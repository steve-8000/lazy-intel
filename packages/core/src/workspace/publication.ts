import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ApplyAck, CapturedManifest, Projection, ProjectionView, SourceSnapshot } from "../contracts.js";
import { openWorkspaceJournal, type WorkspaceJournal } from "./journal.js";

export type PublicationFailurePoint = "before-component-write" | "after-component-write-before-ack" | "after-ack-before-catalog-publication" | "before-catalog-publication" | "after-catalog-publication";
export interface PublicationBatch {
  readonly batchId: string;
  readonly manifestId: string;
  readonly profileDigest: string;
  readonly projections: readonly Projection[];
  readonly sources: readonly SourceSnapshot[];
  readonly deletedPaths: readonly string[];
  readonly full: boolean;
  readonly embedding?: string;
  readonly manifest?: CapturedManifest;
  readonly storeRoot?: string;
}
export interface PublicationOptions { readonly failureAt?: PublicationFailurePoint; readonly signal?: AbortSignal; }
export type ApplyProjection = (projection: Projection, batch: PublicationBatch) => Promise<ApplyAck> | ApplyAck;
export interface PublicationStatus { readonly views: Readonly<Partial<Record<Projection, ProjectionView>>>; readonly mixedViews: boolean; readonly applying: boolean; readonly needsRecovery: boolean; readonly pendingBatches: readonly PublicationBatch[]; }
export interface ProjectionRead<T = unknown> { readonly projection: Projection; readonly view: ProjectionView; readonly data: T | undefined; }
export interface PublicationReadLease { readonly views: Readonly<Partial<Record<Projection, ProjectionView>>>; readonly released: boolean; release(): void; }
interface StoredTransaction { readonly batch: PublicationBatch; readonly oldViews: Readonly<Partial<Record<Projection, ProjectionView>>>; readonly operationId: string; readonly acknowledged: readonly Projection[]; }
interface PublicationCatalog { readonly version: 3; readonly views: Partial<Record<Projection, ProjectionView>>; readonly activeBatches: Partial<Record<Projection, PublicationBatch>>; readonly transactions: Partial<Record<string, StoredTransaction>>; readonly completed: Readonly<Record<string, true>>; }
interface PublicationJournalPayload { readonly kind: "publication"; readonly transaction: StoredTransaction; }
interface AckPayload { readonly projection?: unknown; readonly durableBoundary?: unknown; }
 type OperationId = `${string}-${string}-${string}-${string}-${string}`;

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function emptyCatalog(): PublicationCatalog { return { version: 3, views: {}, activeBatches: {}, transactions: {}, completed: {} }; }
function cloneView(view: ProjectionView): ProjectionView { return Object.freeze({ ...view }); }
function cloneBatch(batch: PublicationBatch): PublicationBatch { return Object.freeze({ ...batch, projections: Object.freeze([...batch.projections]), sources: Object.freeze(batch.sources.map((source) => Object.freeze({ ...source }))), deletedPaths: Object.freeze([...batch.deletedPaths]) }); }
function mixedViews(views: Readonly<Partial<Record<Projection, ProjectionView>>>): boolean { const ids = Object.values(views).filter((view): view is ProjectionView => view?.state === "clean").map((view) => view.appliedManifestId); return new Set(ids).size > 1; }
function abortIfNeeded(signal: AbortSignal | undefined): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("publication cancelled"); }
async function durableJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.${process.pid}.${randomUUID()}`; const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath); const directory = await open(path.dirname(filePath), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function readCatalog(filePath: string): Promise<PublicationCatalog> {
  try { const parsed = JSON.parse(await readFile(filePath, "utf8")) as PublicationCatalog; if (parsed.version !== 3 || !parsed.views || !parsed.transactions || !parsed.activeBatches || !parsed.completed) throw new Error("invalid publication catalog"); return parsed; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog(); throw error; }
}

class ReadWriteLease {
  private readers = 0; private writer = false; private waitingWriters = 0;
  private readWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal | undefined; onAbort: (() => void) | undefined }> = [];
  private writeWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal | undefined; onAbort: (() => void) | undefined }> = [];
  async read(signal?: AbortSignal): Promise<() => void> { abortIfNeeded(signal); if (!this.writer && this.waitingWriters === 0) { this.readers += 1; return () => this.releaseRead(); } await this.wait(false, signal); return () => this.releaseRead(); }
  async write(signal?: AbortSignal): Promise<() => void> { abortIfNeeded(signal); if (!this.writer && this.readers === 0) { this.writer = true; return () => this.releaseWrite(); } this.waitingWriters += 1; try { await this.wait(true, signal); return () => this.releaseWrite(); } finally { this.waitingWriters -= 1; this.wake(); } }
  private wait(writer: boolean, signal?: AbortSignal): Promise<void> {
    let resolvePromise!: () => void; let rejectPromise!: (error: unknown) => void; const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const entry = { resolve: resolvePromise, reject: rejectPromise, signal, onAbort: undefined as (() => void) | undefined };
    entry.onAbort = () => { const queue = writer ? this.writeWaiters : this.readWaiters; const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); entry.reject(signal?.reason instanceof Error ? signal.reason : new Error("publication cancelled")); this.wake(); };
    if (signal) signal.addEventListener("abort", entry.onAbort, { once: true }); (writer ? this.writeWaiters : this.readWaiters).push(entry); return promise;
  }
  private releaseRead(): void { this.readers -= 1; this.wake(); }
  private releaseWrite(): void { this.writer = false; this.wake(); }
  private wake(): void {
    if (this.writer || this.readers > 0) return;
    const writer = this.writeWaiters.shift();
    if (writer) { this.writer = true; if (writer.signal && writer.onAbort) writer.signal.removeEventListener("abort", writer.onAbort); writer.resolve(); return; }
    const readers = this.readWaiters.splice(0); this.readers += readers.length;
    for (const reader of readers) { if (reader.signal && reader.onAbort) reader.signal.removeEventListener("abort", reader.onAbort); reader.resolve(); }
  }
}

export class PublicationCrash extends Error { readonly failurePoint: PublicationFailurePoint; constructor(failurePoint: PublicationFailurePoint) { super(`injected publication crash at ${failurePoint}`); this.name = "PublicationCrash"; this.failurePoint = failurePoint; } }
export class PublicationNotReadable extends Error { readonly code: "applying" | "needs_recovery" | "unavailable" | "mixed-views"; constructor(code: "applying" | "needs_recovery" | "unavailable" | "mixed-views", message: string) { super(message); this.name = "PublicationNotReadable"; this.code = code; } }

export class PublicationCoordinator {
  readonly stateRoot: string; readonly catalogPath: string; readonly journalPath: string; readonly projectionsRoot: string;
  private catalog: PublicationCatalog = emptyCatalog(); private journal!: WorkspaceJournal; private opened = false; private readonly rw = new ReadWriteLease(); private recoveryApply: ApplyProjection | undefined; private readOnly = false; private catalogSignature: string | undefined;
  private constructor(stateRoot: string) { this.stateRoot = stateRoot; this.catalogPath = path.join(stateRoot, "runtime", "publication-catalog.json"); this.journalPath = path.join(stateRoot, "runtime", "publication.journal"); this.projectionsRoot = path.join(stateRoot, "projections"); }
  static async open(stateRoot: string, options: { readonly mode?: "read" | "write"; readonly deferRecovery?: boolean; readonly apply?: ApplyProjection } = {}): Promise<PublicationCoordinator> {
    const coordinator = new PublicationCoordinator(stateRoot); coordinator.readOnly = options.mode === "read";
    await mkdir(path.join(stateRoot, "runtime"), { recursive: true });
    coordinator.catalog = await readCatalog(coordinator.catalogPath); coordinator.journal = await openWorkspaceJournal(coordinator.journalPath); coordinator.opened = true;
    // Recovery is a mutation and belongs to the owner. A reader that recovered
    // would write the catalog it was only supposed to observe, and two readers
    // could race the owner for it.
    if (!coordinator.readOnly && options.apply) coordinator.recoveryApply = options.apply;
    if (!coordinator.readOnly && options.deferRecovery) {
      const transactions = { ...coordinator.catalog.transactions };
      for (const transaction of (await coordinator.publicationEntries()).values()) if (!coordinator.catalog.completed[transaction.batch.batchId]) transactions[transaction.batch.batchId] = transaction;
      coordinator.catalog = { ...coordinator.catalog, transactions };
      if (coordinator.reconcileAbandoned()) await coordinator.save();
    } else if (!coordinator.readOnly) await coordinator.recover(options.apply);
    return coordinator;
  }
  /**
   * Re-read the durable catalog.
   *
   * The owner's in-memory catalog is authoritative for itself, but a reader is a
   * different object - usually a different process - and its copy goes stale the
   * moment the owner publishes. Every read path refreshes first, so a reader can
   * never serve a view the owner has already replaced.
   */
  async refresh(): Promise<void> {
    if (!this.opened) throw new Error("publication coordinator is not open");
    if (!this.readOnly) return;
    const release = await this.rw.write();
    try {
      const information = await stat(this.catalogPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      const signature = information ? String(information.ino) + ":" + information.size + ":" + information.mtimeMs : "missing";
      if (signature !== this.catalogSignature) { this.catalog = await readCatalog(this.catalogPath); this.catalogSignature = signature; }
    } finally { release(); }
  }
  private async save(): Promise<void> { await durableJson(this.catalogPath, this.catalog); const information = await stat(this.catalogPath); this.catalogSignature = String(information.ino) + ":" + information.size + ":" + information.mtimeMs; }
  private fail(point: PublicationFailurePoint, requested?: PublicationFailurePoint): void { if (point === requested) throw new PublicationCrash(point); }
  private async publicationEntries(): Promise<Map<string, StoredTransaction>> {
    const pending = new Map<string, StoredTransaction>();
    for (const record of this.journal.entries) {
      if (record.type === "intent" && record.operation === "replace" && (record.payload as PublicationJournalPayload)?.kind === "publication") { pending.set(record.operationId, (record.payload as PublicationJournalPayload).transaction); continue; }
      if (record.type === "ack") { const transaction = pending.get(record.operationId); const payload = record.payload as (AckPayload & { abandonedBatchId?: string }) | undefined; if (payload?.abandonedBatchId) { pending.delete(record.operationId); continue; } const projection = payload?.projection; if (transaction && (projection === "retrieval" || projection === "graph") && !transaction.acknowledged.includes(projection)) pending.set(record.operationId, { ...transaction, acknowledged: [...transaction.acknowledged, projection] }); }
    }
    return pending;
  }
  private markPending(transaction: StoredTransaction, state: "applying" | "needs_recovery"): void {
    const views = { ...this.catalog.views }; for (const projection of transaction.batch.projections) { const old = views[projection]; views[projection] = old ? { ...old, state } : { projection, viewId: "", appliedManifestId: "", profileDigest: transaction.batch.profileDigest, state }; }
    this.catalog = { ...this.catalog, views, transactions: { ...this.catalog.transactions, [transaction.batch.batchId]: transaction } };
  }
  private async compactJournal(): Promise<void> {
    const operationIds = new Set(Object.values(this.catalog.transactions).map((transaction) => transaction?.operationId).filter((id): id is string => !!id));
    await this.journal.compact((record) => operationIds.has(record.operationId));
  }

  private async finish(transaction: StoredTransaction, acks: readonly ApplyAck[]): Promise<void> {
    const views = { ...this.catalog.views }; const activeBatches = { ...this.catalog.activeBatches };
    for (const projection of transaction.batch.projections) {
      const ack = acks.find((candidate) => candidate.projection === projection); const storeRoot = ack?.storeRoot ?? transaction.batch.storeRoot; const view: ProjectionView = { projection, viewId: digest({ batch: transaction.batch.batchId, projection }).slice(0, 32), appliedManifestId: transaction.batch.manifestId, profileDigest: transaction.batch.profileDigest, state: "clean", ...(storeRoot ? { storeRoot } : {}) };
      views[projection] = view; activeBatches[projection] = cloneBatch(transaction.batch);
    }
    const transactions = { ...this.catalog.transactions }; delete transactions[transaction.batch.batchId];
    this.catalog = { ...this.catalog, views, activeBatches, transactions, completed: { ...this.catalog.completed, [transaction.batch.batchId]: true } }; await this.save();
    await this.compactJournal();
  }
  registerRecovery(apply: ApplyProjection): void { this.recoveryApply = apply; }
  currentBatch(projection?: Projection): PublicationBatch | null {
    if (projection) return this.catalog.activeBatches[projection] ? cloneBatch(this.catalog.activeBatches[projection]!) : null;
    const active = Object.values(this.catalog.activeBatches).find((batch): batch is PublicationBatch => !!batch); return active ? cloneBatch(active) : null;
  }
  capturedSources(projection?: Projection): readonly SourceSnapshot[] { return this.currentBatch(projection)?.sources ?? []; }
  async recover(apply: ApplyProjection | undefined = this.recoveryApply): Promise<void> {
    if (!this.opened) throw new Error("publication coordinator is not open"); const release = await this.rw.write();
    try {
      const journalTransactions = await this.publicationEntries(); const transactions = { ...this.catalog.transactions };
      for (const transaction of journalTransactions.values()) { if (this.catalog.completed[transaction.batch.batchId]) continue; transactions[transaction.batch.batchId] = transaction; }
      this.catalog = { ...this.catalog, transactions };
      if (this.reconcileAbandoned()) await this.save();
      const remaining = { ...this.catalog.transactions };
      for (const transaction of Object.values(remaining)) { if (!transaction) continue; this.markPending(transaction, apply ? "applying" : "needs_recovery"); await this.save(); if (!apply) continue; try { await this.applyTransaction(transaction, apply); } catch (error) { this.markPending(transaction, "needs_recovery"); await this.save(); throw error; } }
      if (Object.keys(this.catalog.transactions).length === 0) await this.compactJournal();
    } finally { release(); }
  }
  async abandon(batchId: string): Promise<PublicationBatch | null> {
    if (!this.opened || this.readOnly) throw new Error("publication coordinator is not writable");
    const release = await this.rw.write();
    try {
      const transaction = this.catalog.transactions[batchId];
      if (!transaction) return null;
      await this.journal.appendAck({ operationId: transaction.operationId, operation: "replace" }, { abandonedBatchId: batchId });
      this.catalog = this.withoutTransaction(transaction); await this.save();
      return cloneBatch(transaction.batch);
    } finally { release(); }
  }
  /**
   * The journal ack is the durable abandonment decision; the catalog save that
   * follows it can be lost to a crash. Drop every catalog transaction the journal
   * says was abandoned so a restart cannot replay it.
   */
  private reconcileAbandoned(): boolean {
    const abandoned = new Set<string>();
    for (const record of this.journal.entries) if (record.type === "ack" && (record.payload as { abandonedBatchId?: unknown } | undefined)?.abandonedBatchId) abandoned.add(record.operationId);
    let changed = false;
    for (const transaction of Object.values(this.catalog.transactions)) {
      if (transaction && abandoned.has(transaction.operationId)) { this.catalog = this.withoutTransaction(transaction); changed = true; }
    }
    return changed;
  }
  /**
   * Remove a transaction and restore the views it displaced. A view whose store the
   * batch wrote into is not restored as clean: that store may be half-replaced, so it
   * stays unreadable until a fresh store is published.
   */
  private withoutTransaction(transaction: StoredTransaction): PublicationCatalog {
    const { batch } = transaction; const views = { ...this.catalog.views }; const activeBatches = { ...this.catalog.activeBatches }; const transactions = { ...this.catalog.transactions };
    for (const projection of batch.projections) {
      const old = transaction.oldViews[projection];
      if (!old) delete views[projection];
      else if (batch.storeRoot && old.storeRoot === batch.storeRoot) views[projection] = Object.freeze({ ...old, state: "needs_recovery" as const });
      else views[projection] = cloneView(old);
      if (activeBatches[projection]?.batchId === batch.batchId) delete activeBatches[projection];
    }
    delete transactions[batch.batchId];
    return { ...this.catalog, views, activeBatches, transactions };
  }
  private async applyTransaction(transaction: StoredTransaction, apply: ApplyProjection, options: PublicationOptions = {}): Promise<readonly ApplyAck[]> {
    const acks: ApplyAck[] = []; const acknowledged = new Set(transaction.acknowledged);
    for (const projection of transaction.batch.projections) {
      abortIfNeeded(options.signal); if (acknowledged.has(projection)) continue; this.fail("before-component-write", options.failureAt);
      const ack = await apply(projection, cloneBatch(transaction.batch)); if (!ack || ack.batchId !== transaction.batch.batchId || ack.projection !== projection || ack.manifestId !== transaction.batch.manifestId || typeof ack.durableBoundary !== "string" || !ack.durableBoundary || ack.state !== "applied") throw new Error(`invalid apply acknowledgement for ${projection}`);
      this.fail("after-component-write-before-ack", options.failureAt); await this.journal.appendAck({ operationId: transaction.operationId, operation: "replace" }, { projection, batchId: transaction.batch.batchId, durableBoundary: ack.durableBoundary }); acknowledged.add(projection); acks.push(ack); this.fail("after-ack-before-catalog-publication", options.failureAt);
    }
    if (!transaction.batch.projections.every((projection) => acknowledged.has(projection))) return acks;
    this.fail("before-catalog-publication", options.failureAt);
    const finalAcks = transaction.batch.projections.map((projection) => acks.find((ack) => ack.projection === projection) ?? { batchId: transaction.batch.batchId, projection, state: "applied", manifestId: transaction.batch.manifestId, durableBoundary: "recovered", storeRoot: transaction.batch.storeRoot } as ApplyAck);
    await this.finish(transaction, finalAcks); this.fail("after-catalog-publication", options.failureAt); return acks;
  }
  async publishBatch(batch: PublicationBatch, apply: ApplyProjection, options: PublicationOptions = {}): Promise<readonly ProjectionView[]> {
    if (!this.opened) throw new Error("publication coordinator is not open"); if (!batch.batchId || !batch.manifestId || !batch.profileDigest || batch.projections.length === 0) throw new Error("invalid publication batch"); const projections = [...new Set(batch.projections)]; if (projections.length !== batch.projections.length) throw new Error("publication batch contains duplicate projections"); abortIfNeeded(options.signal);
    const release = await this.rw.write(options.signal);
    try { if (Object.keys(this.catalog.transactions).length > 0) throw new PublicationNotReadable("needs_recovery", "publication has an unresolved transaction"); const operationId = randomUUID() as OperationId; const transaction: StoredTransaction = { batch: cloneBatch({ ...batch, projections }), oldViews: { ...this.catalog.views }, operationId, acknowledged: [] }; await this.journal.appendIntent("replace", { kind: "publication", transaction }, operationId); this.markPending(transaction, "applying"); await this.save(); try { await this.applyTransaction(transaction, apply, options); } catch (error) { if (!this.catalog.completed[batch.batchId]) { this.markPending(transaction, "needs_recovery"); await this.save(); } throw error; } return projections.map((projection) => this.catalog.views[projection]).filter((view): view is ProjectionView => !!view).map(cloneView); }
    finally { release(); }
    }
  async publish(batch: PublicationBatch, apply: ApplyProjection, options?: PublicationOptions): Promise<readonly ProjectionView[]> { return this.publishBatch(batch, apply, options); }
  async read<T>(projection: Projection, options: { readonly requireCoherent?: boolean; readonly signal?: AbortSignal } | undefined, callback: (views: Readonly<Partial<Record<Projection, ProjectionView>>>, lease: PublicationReadLease) => Promise<T> | T): Promise<T>;
  async read<T>(projections: readonly Projection[], options: { readonly requireCoherent?: boolean; readonly signal?: AbortSignal }, callback: (views: Readonly<Partial<Record<Projection, ProjectionView>>>, lease: PublicationReadLease) => Promise<T> | T): Promise<T>;
  async read(projection: Projection, options?: { readonly requireCoherent?: boolean; readonly signal?: AbortSignal }): Promise<ProjectionRead>;
  async read(projections: readonly Projection[], options?: { readonly requireCoherent?: boolean; readonly signal?: AbortSignal }): Promise<Readonly<Record<Projection, ProjectionRead>>>;
  async read<T>(input: Projection | readonly Projection[], options: { readonly requireCoherent?: boolean; readonly signal?: AbortSignal } = {}, callback?: (views: Readonly<Partial<Record<Projection, ProjectionView>>>, lease: PublicationReadLease) => Promise<T> | T): Promise<T | ProjectionRead | Readonly<Record<Projection, ProjectionRead>>> {
    await this.refresh();
    const wanted = typeof input === "string" ? [input] : [...input]; const release = await this.rw.read(options.signal); const views = Object.freeze(Object.fromEntries(wanted.map((projection) => [projection, this.catalog.views[projection] ? cloneView(this.catalog.views[projection]!) : undefined])) as Partial<Record<Projection, ProjectionView>>); let lease: PublicationReadLease | undefined;
    try { const selected = wanted.map((projection) => views[projection]).filter((view): view is ProjectionView => !!view); if (selected.some((view) => view.state === "applying")) throw new PublicationNotReadable("applying", "publication is applying"); if (selected.some((view) => view.state === "needs_recovery")) throw new PublicationNotReadable("needs_recovery", "publication needs recovery"); if (selected.length !== wanted.length) throw new PublicationNotReadable("unavailable", "projection has no published view"); if ((options.requireCoherent ?? true) && mixedViews(views)) throw new PublicationNotReadable("mixed-views", "published views are from different manifests"); let released = false; lease = { views, get released() { return released; }, release: () => { if (!released) { released = true; release(); } } }; if (callback) { try { return await callback(views, lease); } finally { lease.release(); } } lease.release(); if (typeof input === "string") return { projection: input, view: views[input]!, data: undefined }; return Object.fromEntries(wanted.map((projection) => [projection, { projection, view: views[projection]!, data: undefined }])) as Readonly<Record<Projection, ProjectionRead>>; }
    catch (error) { if (lease) lease.release(); else release(); throw error; }
  }
  status(): PublicationStatus { const pendingBatches = Object.values(this.catalog.transactions).map((transaction) => transaction?.batch).filter((batch): batch is PublicationBatch => !!batch).map(cloneBatch); const values = Object.values(this.catalog.views); return { views: Object.freeze(Object.fromEntries(Object.entries(this.catalog.views).map(([key, value]) => [key, cloneView(value!)]))), mixedViews: mixedViews(this.catalog.views), applying: values.some((view) => view?.state === "applying"), needsRecovery: values.some((view) => view?.state === "needs_recovery") || pendingBatches.length > 0, pendingBatches }; }
  view(projection: Projection): ProjectionView | null { const view = this.catalog.views[projection]; return view ? cloneView(view) : null; }
  async close(): Promise<void> { this.opened = false; }
}
export async function openPublicationCoordinator(stateRoot: string): Promise<PublicationCoordinator> { return PublicationCoordinator.open(stateRoot); }
export async function recoverPublication(stateRoot: string, apply?: ApplyProjection): Promise<PublicationCoordinator> { const coordinator = await PublicationCoordinator.open(stateRoot); if (apply) await coordinator.recover(apply); return coordinator; }
