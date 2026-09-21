import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Projection, ProjectionView } from "../contracts.js";
import { openWorkspaceJournal, type WorkspaceJournal } from "./journal.js";

export type PublicationFailurePoint =
  | "before-component-write"
  | "after-component-write-before-ack"
  | "after-ack-before-catalog-publication"
  | "before-catalog-publication"
  | "after-catalog-publication";

export interface PublicationOptions {
  readonly manifestId: string;
  readonly profileDigest: string;
  readonly components: Readonly<Partial<Record<Projection, unknown>>>;
  readonly failureAt?: PublicationFailurePoint;
}

export interface PublicationStatus {
  readonly views: Readonly<Partial<Record<Projection, ProjectionView>>>;
  readonly mixedViews: boolean;
  readonly applying: boolean;
  readonly needsRecovery: boolean;
}

export interface ProjectionRead<T = unknown> {
  readonly projection: Projection;
  readonly view: ProjectionView;
  readonly data: T;
}

interface StoredTransaction {
  readonly id: string;
  readonly manifestId: string;
  readonly profileDigest: string;
  readonly projections: readonly Projection[];
  readonly candidates: Readonly<Partial<Record<Projection, string>>>;
  readonly oldViews: Readonly<Partial<Record<Projection, ProjectionView>>>;
}

interface PublicationCatalog {
  readonly version: 1;
  readonly views: Partial<Record<Projection, ProjectionView>>;
  readonly transactions: Partial<Record<string, StoredTransaction>>;
}

interface PublicationJournalPayload {
  readonly kind: "publication";
  readonly transaction: StoredTransaction;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function projectionList(components: Readonly<Partial<Record<Projection, unknown>>>): Projection[] {
  return (["retrieval", "graph"] as const).filter((projection) => Object.prototype.hasOwnProperty.call(components, projection));
}

function emptyCatalog(): PublicationCatalog {
  return { version: 1, views: {}, transactions: {} };
}

async function durableJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readCatalog(filePath: string): Promise<PublicationCatalog> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as PublicationCatalog;
    if (parsed.version !== 1 || !parsed.views || !parsed.transactions) throw new Error("invalid publication catalog");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog();
    throw error;
  }
}


function mixedViews(views: Readonly<Partial<Record<Projection, ProjectionView>>>): boolean {
  const applied = Object.values(views).filter((view): view is ProjectionView => view !== undefined && view.state === "clean").map((view) => view.appliedManifestId);
  return new Set(applied).size > 1;
}

export class PublicationCrash extends Error {
  readonly failurePoint: PublicationFailurePoint;
  constructor(failurePoint: PublicationFailurePoint) {
    super(`injected publication crash at ${failurePoint}`);
    this.name = "PublicationCrash";
    this.failurePoint = failurePoint;
  }
}

export class PublicationNotReadable extends Error {
  readonly code: "applying" | "needs_recovery" | "unavailable" | "mixed-views";
  constructor(code: "applying" | "needs_recovery" | "unavailable" | "mixed-views", message: string) {
    super(message);
    this.name = "PublicationNotReadable";
    this.code = code;
  }
}

export class PublicationCoordinator {
  readonly stateRoot: string;
  readonly catalogPath: string;
  readonly journalPath: string;
  readonly projectionsRoot: string;
  private catalog: PublicationCatalog = emptyCatalog();
  private journal!: WorkspaceJournal;
  private opened = false;

  private constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.catalogPath = path.join(stateRoot, "runtime", "publication-catalog.json");
    this.journalPath = path.join(stateRoot, "runtime", "publication.journal");
    this.projectionsRoot = path.join(stateRoot, "projections");
  }

  static async open(stateRoot: string): Promise<PublicationCoordinator> {
    const coordinator = new PublicationCoordinator(stateRoot);
    await mkdir(path.join(stateRoot, "runtime"), { recursive: true });
    await mkdir(coordinator.projectionsRoot, { recursive: true });
    coordinator.catalog = await readCatalog(coordinator.catalogPath);
    coordinator.journal = await openWorkspaceJournal(coordinator.journalPath);
    coordinator.opened = true;
    await coordinator.recover();
    return coordinator;
  }

  private async saveCatalog(): Promise<void> {
    await durableJson(this.catalogPath, this.catalog);
  }

  private fail(point: PublicationFailurePoint, requested: PublicationFailurePoint | undefined): void {
    if (point === requested) throw new PublicationCrash(point);
  }

  private async writeCandidate(candidate: string, data: unknown): Promise<void> {
    await mkdir(candidate, { recursive: true });
    await durableJson(path.join(candidate, "payload.json"), data);
  }

  private async candidateExists(candidate: string): Promise<boolean> {
    try { return (await stat(path.join(candidate, "payload.json"))).isFile(); } catch { return false; }
  }

  private async publicationEntries(): Promise<{ readonly intents: Map<string, PublicationJournalPayload>; readonly acknowledgements: Set<string> }> {
    const intents = new Map<string, PublicationJournalPayload>();
    const acknowledgements = new Set<string>();
    for (const record of this.journal.entries) {
      if (record.type === "intent" && record.operation === "replace" && (record.payload as PublicationJournalPayload)?.kind === "publication") intents.set(record.operationId, record.payload as PublicationJournalPayload);
      if (record.type === "ack") acknowledgements.add(record.operationId);
    }
    return { intents, acknowledgements };
  }

  async recover(): Promise<void> {
    if (!this.opened) throw new Error("publication coordinator is not open");
    const { intents, acknowledgements } = await this.publicationEntries();
    const transactions = { ...this.catalog.transactions };
    for (const [operationId, payload] of intents) {
      const transaction = payload.transaction;
      if (acknowledgements.has(operationId) && !this.catalog.transactions[transaction.id]) continue;
      if (!transactions[transaction.id]) transactions[transaction.id] = transaction;
    }
    this.catalog = { ...this.catalog, transactions };
    for (const transaction of Object.values(this.catalog.transactions)) {
      if (!transaction) continue;
      const candidateChecks = await Promise.all(transaction.projections.map(async (projection) => {
        const candidate = transaction.candidates[projection];
        if (typeof candidate !== "string") return false;
        return this.candidateExists(candidate);
      }));
      const ackFiles = await Promise.all(transaction.projections.map(async (projection) => {
        const candidate = transaction.candidates[projection];
        if (typeof candidate !== "string") return false;
        try { await stat(path.join(candidate, "ack")); return true; } catch { return false; }
      }));
      const complete = candidateChecks.every(Boolean) && ackFiles.every(Boolean);
      if (complete) {
        const views = { ...this.catalog.views };
        for (const projection of transaction.projections) {
          const candidate = transaction.candidates[projection] as string;
          views[projection] = { projection, viewId: digest({ transaction: transaction.id, projection }).slice(0, 32), appliedManifestId: transaction.manifestId, profileDigest: transaction.profileDigest, state: "clean" };
          const viewDirectory = path.join(this.projectionsRoot, projection);
          await mkdir(viewDirectory, { recursive: true });
          await durableJson(path.join(viewDirectory, "active"), { candidate });
        }
        this.catalog = { version: 1, views, transactions: Object.fromEntries(Object.entries(this.catalog.transactions).filter(([id]) => id !== transaction.id)) };
        await this.saveCatalog();
      } else {
        const views = { ...this.catalog.views };
        for (const projection of transaction.projections) {
          const oldView = transaction.oldViews[projection];
          if (oldView) views[projection] = { ...oldView, state: "clean" };
        }
        this.catalog = { version: 1, views, transactions: Object.fromEntries(Object.entries(this.catalog.transactions).filter(([id]) => id !== transaction.id)) };
        await this.saveCatalog();
        await Promise.all(Object.values(transaction.candidates).filter((candidate): candidate is string => typeof candidate === "string").map((candidate) => rm(candidate, { recursive: true, force: true })));
      }
    }
    this.catalog = await readCatalog(this.catalogPath);
  }

  async publish(options: PublicationOptions): Promise<readonly ProjectionView[]> {
    const projections = projectionList(options.components);
    if (projections.length === 0) throw new Error("publication requires at least one component");
    const transactionId = randomUUID();
    const candidates: Partial<Record<Projection, string>> = {};
    for (const projection of projections) candidates[projection] = path.join(this.projectionsRoot, projection, `.candidate-${transactionId}`);
    const transaction: StoredTransaction = { id: transactionId, manifestId: options.manifestId, profileDigest: options.profileDigest, projections, candidates, oldViews: this.catalog.views };
    const intent = await this.journal.appendIntent("replace", { kind: "publication", transaction });
    this.catalog = { ...this.catalog, transactions: { ...this.catalog.transactions, [transactionId]: transaction }, views: { ...this.catalog.views } };
    for (const projection of projections) {
      const old = this.catalog.views[projection];
      this.catalog.views[projection] = old ? { ...old, state: "applying" } : { projection, viewId: "", appliedManifestId: "", profileDigest: options.profileDigest, state: "applying" };
    }
    await this.saveCatalog();
    for (const projection of projections) {
      this.fail("before-component-write", options.failureAt);
      const candidate = candidates[projection] as string;
      await this.writeCandidate(candidate, options.components[projection]);
      this.fail("after-component-write-before-ack", options.failureAt);
      await durableJson(path.join(candidate, "ack"), { transactionId, projection });
      await this.journal.appendAck({ operationId: `${intent.operationId}:${projection}`, operation: "replace" }, { transactionId, projection });
      this.fail("after-ack-before-catalog-publication", options.failureAt);
    }
    this.fail("before-catalog-publication", options.failureAt);
    const views = { ...this.catalog.views };
    for (const projection of projections) views[projection] = { projection, viewId: digest({ transactionId, projection }).slice(0, 32), appliedManifestId: options.manifestId, profileDigest: options.profileDigest, state: "clean" };
    for (const projection of projections) {
      const candidate = candidates[projection] as string;
      const viewDirectory = path.join(this.projectionsRoot, projection);
      await mkdir(viewDirectory, { recursive: true });
      await durableJson(path.join(viewDirectory, "active"), { candidate });
    }
    this.catalog = { version: 1, views, transactions: Object.fromEntries(Object.entries(this.catalog.transactions).filter(([id]) => id !== transactionId)) };
    await this.saveCatalog();
    this.fail("after-catalog-publication", options.failureAt);
    await this.journal.appendAck({ operationId: intent.operationId, operation: "replace" }, { transactionId });
    return projections.map((projection) => views[projection] as ProjectionView);
  }

  status(): PublicationStatus {
    const views = this.catalog.views;
    const values = Object.values(views).filter((view): view is ProjectionView => view !== undefined);
    return { views, mixedViews: mixedViews(views), applying: values.some((view) => view.state === "applying"), needsRecovery: values.some((view) => view.state === "needs_recovery") };
  }

  view(projection: Projection): ProjectionView | null {
    return this.catalog.views[projection] ?? null;
  }

  async read<T = unknown>(projection: Projection, options: { readonly requireCoherent?: boolean } = {}): Promise<ProjectionRead<T>> {
    this.catalog = await readCatalog(this.catalogPath);
    const view = this.catalog.views[projection];
    if (!view) throw new PublicationNotReadable("unavailable", `no published ${projection} view`);
    if (view.state === "applying") throw new PublicationNotReadable("applying", `${projection} projection is applying`);
    if (view.state === "needs_recovery") throw new PublicationNotReadable("needs_recovery", `${projection} projection needs recovery`);
    if (options.requireCoherent && mixedViews(this.catalog.views)) throw new PublicationNotReadable("mixed-views", "projections have mixed applied manifests");
    const active = JSON.parse(await readFile(path.join(this.projectionsRoot, projection, "active"), "utf8")) as { candidate: string };
    const data = JSON.parse(await readFile(path.join(active.candidate, "payload.json"), "utf8")) as T;
    return { projection, view, data };
  }

  async close(): Promise<void> {
    this.opened = false;
  }
}

export async function openPublicationCoordinator(stateRoot: string): Promise<PublicationCoordinator> {
  return PublicationCoordinator.open(stateRoot);
}

export async function recoverPublication(stateRoot: string): Promise<PublicationCoordinator> {
  return PublicationCoordinator.open(stateRoot);
}
