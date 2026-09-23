import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION, envelope, failureEnvelope } from "./contracts.js";
import { ensureIndexes, observeIndexState, noteIndexReadFailure } from "./index-manager.js";
import * as Evidence from "./evidence.js";
import { log } from "./lib/log.js";
import { requestRoot } from "./lib/roots.js";
import { lineRangeForSpan } from "./lib/source.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_MODE = "unified";
const COMPONENT = { zvec: "retrieval", codegraph: "graph", serena: "semantic" };
const BACKEND = { retrieval: "zvec", graph: "codegraph", semantic: "serena" };
const METHOD_TO_PRODUCT = { lexical: "hybrid_retrieval", vector: "hybrid_retrieval", hybrid: "hybrid_retrieval", syntax: "indexed_graph", resolved_graph: "indexed_graph", lsp: "lsp" };
const KIND_TO_PRODUCT = { definition: "definition", reference: "reference", implementation: "implementation", diagnostic: "diagnostic", call: "relation", dependency: "relation", impact: "impact", retrieval: "retrieval" };
const LANGUAGE_BY_EXTENSION = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".java": "java",
  ".swift": "swift", ".kt": "kotlin", ".cs": "csharp", ".c": "cpp", ".h": "cpp", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".dart": "dart", ".lua": "lua", ".ex": "elixir", ".exs": "elixir", ".scala": "scala", ".zig": "zig", ".svelte": "svelte", ".vue": "vue",
};
const runtimes = new Map();
let corePromise;
let profilePromise;
const workerPools = new Map();
function poolSize() {
  const raw = process.env.LAZY_INTEL_WORKER_POOL;
  if (raw == null || raw === "") return 2;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.trunc(value))) : 2;
}
async function sharedWorkerPool(api, projection) {
  let pool = workerPools.get(projection);
  if (pool) return pool;
  pool = new api.WorkerPool({ kind: projection, size: poolSize(), modulePath: path.join(ROOT_DIR, projection === "retrieval" ? "workers/retrieval/main.mjs" : "workers/graph/main.mjs"), workspaceId: "shared", onLog: (line, stream) => log("debug", "worker output", { projection, stream, line }) });
  workerPools.set(projection, pool);
  return pool;
}
function core() {
  corePromise ??= import(path.join(ROOT_DIR, "packages/core/dist/index.js")).catch((error) => {
    corePromise = undefined;
    throw new Error(`the unified engine needs a build: ${error.message}. Run npm run build.`);
  });
  return corePromise;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function profiles() {
  profilePromise ??= Promise.all(["zvec-grep", "codegraph"].map((name) => readFile(path.join(ROOT_DIR, "vendor", name, "UPSTREAM.json"), "utf8")))
    .then(([retrieval, graph]) => ({ parserProfileDigest: digest({ schema: "prepared-snapshot/2", retrieval, graph }), resolverProfileDigest: digest(graph) }));
  return profilePromise;
}
function trustedLanguageServers() {
  try {
    const value = JSON.parse(process.env.LAZY_INTEL_LSP || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
async function newIndexWorker(runtime, projection) {
  const api = await core();
  const pool = await sharedWorkerPool(api, projection);
  if (projection === "retrieval") {
    runtime.retrievalPool = pool;
    runtime.retrieval = api.createRetrievalAdapter({ workspaceId: runtime.scope.workspaceId, workerPath: path.join(ROOT_DIR, "workers/retrieval/main.mjs"), pool });
  } else {
    runtime.graphPool = pool;
    runtime.graph = api.createGraphAdapter({ pool, sourceRoot: runtime.root });
  }
}
async function runtimeFor(root, mode) {
  root = await realpath(root);
  const key = `${root}\0${mode}`;
  let pending = runtimes.get(key);
  if (pending) return pending;
  pending = (async () => {
    const api = await core();
    const trustedForLanguageTools = await requestRoot(root).then(() => true, () => false);
    const runtimeOptions = { sourceRoot: root, mode, trustedForLanguageTools };
    const scope = await api.openWorkspaceRuntime(runtimeOptions);
    try {
      const coordinator = await api.PublicationCoordinator.open(scope.canonicalStateRoot, { mode, deferRecovery: mode === "write" });
      const publication = mode === "read" ? new Proxy(coordinator, {
        get(target, property, receiver) {
          if (property === "publishBatch" || property === "publish" || property === "recover" || property === "registerRecovery") return () => scope.assertWritable();
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) : coordinator;
      const runtime = { root, api, runtimeOptions, scope, publication, semantic: new Map(), sync: Promise.resolve(), closed: false, retrievalPool: null, graphPool: null, idleTimer: null, writerReleased: false };
      await Promise.all([newIndexWorker(runtime, "retrieval"), newIndexWorker(runtime, "graph")]);
      if (mode === "write") publication.registerRecovery((projection, batch) => applyProjection(runtime, projection, batch));
      return runtime;
    } catch (error) { await scope.release(); throw error; }
  })();
  runtimes.set(key, pending);
  pending.catch(() => { if (runtimes.get(key) === pending) runtimes.delete(key); });
  return pending;
}
function writerIdleMs() {
  const raw = process.env.LAZY_INTEL_WRITER_IDLE_MS;
  if (raw == null || raw === "") return 30_000;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 30_000;
}
async function activateWriter(runtime) {
  if (!runtime.writerReleased) return;
  runtime.scope = await runtime.api.openWorkspaceRuntime(runtime.runtimeOptions);
  runtime.publication = await runtime.api.PublicationCoordinator.open(runtime.scope.canonicalStateRoot, { mode: "write", deferRecovery: true });
  runtime.publication.registerRecovery((projection, batch) => applyProjection(runtime, projection, batch));
  runtime.writerReleased = false;
}
function scheduleWriterRelease(runtime) {
  if (runtime.writerReleased || runtime.closed) return;
  clearTimeout(runtime.idleTimer);
  runtime.idleTimer = setTimeout(() => {
    // Release rides the same chain as syncs, so a sync enqueued meanwhile either
    // runs first (and this sees activeSync) or runs after and re-acquires the lock.
    runtime.sync = runtime.sync.then(async () => {
      if (runtime.closed || runtime.activeSync || runtime.writerReleased) return;
      try { await runtime.publication.close(); await runtime.scope.release(); runtime.writerReleased = true; }
      catch (error) { log("warn", "idle writer release failed", { root: runtime.root, error: error.message }); }
    });
  }, writerIdleMs());
  runtime.idleTimer.unref?.();
}
async function retireStoreIfUnused(runtime, storeRoot, projection) {
  if (!storeRoot) return;
  const status = runtime.publication.status();
  if (Object.values(status.views).some((view) => view?.storeRoot === storeRoot)
    || status.pendingBatches.some((batch) => batch.storeRoot === storeRoot)
    || ["graph", "retrieval"].some((projection) => runtime.publication.currentBatch(projection)?.storeRoot === storeRoot)) return;
  const supervisor = supervisorFor(runtime, projection, storeRoot);
  const result = await supervisor.call("close-store", { root: runtime.root, stateRoot: storeRoot }, {
    requestId: runtime.api.newRequestId("retire-store"), workspaceId: runtime.scope.workspaceId, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30_000,
  });
  if (!result.ok) throw new Error(result.message);
  await rm(storeRoot, { recursive: true, force: true });
}
async function sweepUnusedStores(runtime, root) {
  const storesRoot = path.join(runtime.scope.canonicalStateRoot, "stores");
  const graceValue = process.env.LAZY_INTEL_STORE_GRACE_MS === undefined ? 600_000 : Number(process.env.LAZY_INTEL_STORE_GRACE_MS);
  const graceMs = Number.isFinite(graceValue) && graceValue >= 0 ? graceValue : 600_000;
  const status = runtime.publication.status();
  const referenced = new Set([
    ...Object.values(status.views).map((view) => view?.storeRoot),
    ...status.pendingBatches.map((batch) => batch.storeRoot),
    ...["graph", "retrieval"].map((projection) => runtime.publication.currentBatch(projection)?.storeRoot),
  ].filter((storeRoot) => typeof storeRoot === "string"));
  let entries;
  try { entries = await readdir(storesRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storeRoot = path.join(storesRoot, entry.name);
    if (referenced.has(storeRoot)) continue;
    try {
      const information = await stat(storeRoot);
      if (Date.now() - information.mtimeMs < graceMs) continue;
      for (const projection of ["graph", "retrieval"]) {
        const supervisor = supervisorFor(runtime, projection, storeRoot);
        const result = await supervisor.call("close-store", { root, stateRoot: storeRoot }, {
          requestId: runtime.api.newRequestId("retire-store"), workspaceId: runtime.scope.workspaceId,
          signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30_000,
        });
        if (!result.ok) throw new Error(result.message);
      }
      await rm(storeRoot, { recursive: true, force: true });
    } catch (error) {
      log("warn", "unused store sweep failed", { root, storeRoot, error: error.message });
    }
  }
}

function supervisorFor(runtime, projection, affinityKey = runtime.scope.canonicalStateRoot) {
  return (projection === "retrieval" ? runtime.retrievalPool : runtime.graphPool).acquire(affinityKey);
}
function waitForJob(job, signal) {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("cancelled")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    job.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function sourceChunks(sources) {
  const chunks = [];
  let current = [], size = 0;
  for (const source of sources) {
    const bytes = Buffer.byteLength(JSON.stringify(source));
    if (size + bytes > 700_000 && current.length) { chunks.push(current); current = []; size = 0; }
    current.push(source); size += bytes;
  }
  if (current.length || chunks.length === 0) chunks.push(current);
  return chunks;
}
async function applyProjection(runtime, projection, batch) {
  runtime.scope.assertWritable();
  if (batch.storeRoot) await assertOwnedStoreRoot(runtime.scope.canonicalStateRoot, batch.storeRoot);
  const api = await core();
  const supervisor = supervisorFor(runtime, projection, batch.storeRoot ?? runtime.scope.canonicalStateRoot);
  const previous = currentBatch(runtime, projection);
  const priorHashes = new Map((previous?.sources ?? []).map((source) => [source.relativePath, source.contentHash]));
  const upserts = batch.full ? batch.sources : batch.sources.filter((source) => priorHashes.get(source.relativePath) !== source.contentHash);
  const chunks = sourceChunks(upserts);
  let ack, transport;
  const applyDeadline = performance.now() + 1_800_000;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const part = { batchId: batch.batchId, part: index, final: index === chunks.length - 1, manifestId: batch.manifestId, sources: chunks[index], deletedPaths: index === 0 ? batch.deletedPaths : [], full: batch.full && index === 0 };
      transport = await api.stagePreparedBatch(batch.storeRoot, part);
      const result = await supervisor.call("apply", { root: runtime.root, stateRoot: batch.storeRoot, batchRef: transport.reference, options: { embedding: batch.embedding, embeddingCachePath: path.join(runtime.scope.canonicalStateRoot, "embedding-cache.jsonl") } }, {
        requestId: api.newRequestId(projection + "-apply"), workspaceId: runtime.scope.workspaceId, signal: new AbortController().signal, deadlineMonotonicMs: applyDeadline,
      });
      if (!result.ok) throw new Error(result.message);
      ack = result.payload;
      const staged = projection === "graph" && !part.final;
      if (ack?.state !== (staged ? "staged" : "applied") || ack.batchId !== batch.batchId || ack.manifestId !== batch.manifestId || (!staged && (typeof ack.durableBoundary !== "string" || !ack.durableBoundary))) {
        throw new Error(projection + " did not acknowledge the prepared part");
      }
      await transport.release(); transport = undefined;
    }
    return { ...ack, storeRoot: batch.storeRoot };
  } catch (error) {
    // Retain input until any timed-out native operation has been physically reaped.
    // The worker is shared, so reclaim it whatever this runtime is doing.
    await (projection === "retrieval" ? runtime.retrievalPool : runtime.graphPool).recycle(supervisor);
    throw error;
  } finally {
    if (transport) await transport.release();
  }
}
async function capture(runtime, observedSeq) {
  const api = await core();
  return api.captureWorkspaceSnapshot({ workspaceId: runtime.scope.workspaceId, sourceRoot: runtime.root, observedSeq: String(observedSeq), ...(await profiles()) });
}
function currentBatch(runtime, projection) { return runtime.publication.currentBatch(projection); }
function isWithin(parent, child) { return child === parent || child.startsWith(parent + path.sep); }
async function assertOwnedStoreRoot(stateRoot, storeRoot) {
  const canonicalStateRoot = await realpath(stateRoot);
  const resolvedStoreRoot = await realpath(storeRoot).catch(() => path.resolve(storeRoot));
  if (!isWithin(canonicalStateRoot, resolvedStoreRoot)) throw new Error("publication store root escapes workspace state root");
  const storesRoot = path.join(canonicalStateRoot, "stores");
  const resolvedStoresRoot = await realpath(storesRoot).catch(() => storesRoot);
  if (resolvedStoresRoot !== storesRoot || !isWithin(storesRoot, resolvedStoreRoot)) throw new Error("publication store root is outside the owned stores directory");
}

/** One capture and publication owns all requested projections, including admin work. */
export async function synchronizeWorkspace(root, backends, options = {}) {
  const runtime = await runtimeFor(root, "write");
  const projections = [...new Set(backends.map((backend) => COMPONENT[backend]).filter((value) => value === "graph" || value === "retrieval"))];
  const run = async () => {
    if (runtime.closed) throw new Error("workspace is closing");
    await activateWriter(runtime);
    runtime.scope.assertWritable();
    const initial = projections.map((projection) => currentBatch(runtime, projection)).filter(Boolean);
    await Promise.all(initial.map((batch) => batch.storeRoot ? assertOwnedStoreRoot(runtime.scope.canonicalStateRoot, batch.storeRoot) : undefined));
    const configured = process.env.LAZY_INTEL_EMBEDDING || await (await import("./lifecycle.js")).configuredEmbedding();
    const embedding = options.embedding ?? initial.find((batch) => batch.embedding)?.embedding ?? configured ?? undefined;
    const observedSeq = String(observeIndexState(root)?.generation ?? 1);
    const captured = await capture(runtime, observedSeq, embedding);
    const profileDigest = digest({ scope: captured.manifest.scopeDigest, parser: captured.manifest.parserProfileDigest, resolver: captured.manifest.resolverProfileDigest, embedding });
    const abandoned = [];
    const pending = runtime.publication.status().pendingBatches;
    for (const transaction of pending) if (transaction.storeRoot) await assertOwnedStoreRoot(runtime.scope.canonicalStateRoot, transaction.storeRoot);
    try {
      for (const transaction of pending) {
        if (transaction.profileDigest !== profileDigest) { abandoned.push(await runtime.publication.abandon(transaction.batchId)); continue; }
      }
      if (runtime.publication.status().pendingBatches.length) await runtime.publication.recover((projection, batch) => applyProjection(runtime, projection, batch));
    } catch (error) {
      log("warn", "pending publication could not be replayed; abandoning it", { root, error: error.message });
      for (const transaction of runtime.publication.status().pendingBatches) abandoned.push(await runtime.publication.abandon(transaction.batchId));
    }
    // Retiring an orphaned store is housekeeping; it must not keep the workspace unpublished.
    for (const transaction of abandoned) {
      if (!transaction?.storeRoot) continue;
      await retireStoreIfUnused(runtime, transaction.storeRoot, transaction.projections[0])
        .catch((error) => log("warn", "abandoned store retirement failed", { root, storeRoot: transaction.storeRoot, error: error.message }));
    }
    const previous = projections.map((projection) => currentBatch(runtime, projection)).filter(Boolean);
    await Promise.all(previous.map((batch) => batch.storeRoot ? assertOwnedStoreRoot(runtime.scope.canonicalStateRoot, batch.storeRoot) : undefined));
    // An abandoned batch may have partially written a shared store, and a view left
    // unreadable by one (possibly before a crash) marks that store; never build on top of it.
    const tainted = abandoned.some(Boolean) || projections.some((projection) => { const view = runtime.publication.view(projection); return view && view.state !== "clean"; });
    const rebuild = options.rebuild === true || tainted || previous.length !== projections.length || new Set(previous.map((batch) => batch.storeRoot)).size > 1 || previous.some((batch) => batch.profileDigest !== profileDigest);
    const oldPaths = new Set(previous.flatMap((batch) => batch.sources.map((source) => source.relativePath)));
    const paths = new Set(captured.sources.map((source) => source.relativePath));
    const storeRoot = rebuild ? path.join(runtime.scope.canonicalStateRoot, "stores", randomUUID())
      : previous[0]?.storeRoot ?? path.join(runtime.scope.canonicalStateRoot, "stores", randomUUID());
    await assertOwnedStoreRoot(runtime.scope.canonicalStateRoot, storeRoot);
    const batch = { batchId: randomUUID(), manifestId: captured.manifest.id, manifest: captured.manifest, profileDigest,
      projections, sources: captured.sources, deletedPaths: [...oldPaths].filter((entry) => !paths.has(entry)),
      full: rebuild || previous.length === 0, storeRoot, embedding };
    const unchanged = !rebuild && projections.every((projection) => {
      const view = runtime.publication.view(projection);
      return view?.state === "clean" && view.appliedManifestId === batch.manifestId && view.profileDigest === profileDigest;
    });
    if (!unchanged) await runtime.publication.publishBatch(batch, (projection, pending) => applyProjection(runtime, projection, pending));
    // The sweep's grace window is measured from directory mtime, and a replaced store may
    // not have been written for days. Stamp it now so a reader in another process that
    // still holds the old view gets the full window after replacement, not after its last write.
    if (!unchanged) {
      const now = new Date();
      for (const old of new Set(previous.map((entry) => entry.storeRoot).filter((entry) => entry && entry !== storeRoot))) {
        await utimes(old, now, now).catch((error) => { if (error.code !== "ENOENT") log("warn", "replaced store could not be stamped", { root, storeRoot: old, error: error.message }); });
      }
    }
    await sweepUnusedStores(runtime, root).catch((error) => log("warn", "unused store sweep failed", { root, error: error.message }));
    return projections.map((projection) => ({ backend: BACKEND[projection], ok: true, ready: true, building: false,
      action: rebuild ? "rebuilt" : unchanged ? "ready" : "synced", view: runtime.publication.view(projection) }));
  };
  runtime.activeSync = (runtime.activeSync ?? 0) + 1;
  clearTimeout(runtime.idleTimer);
  const job = runtime.sync.then(run, run);
  runtime.sync = job.then(() => { runtime.activeSync -= 1; if (!runtime.activeSync) scheduleWriterRelease(runtime); }, () => { runtime.activeSync -= 1; if (!runtime.activeSync) scheduleWriterRelease(runtime); });
  return waitForJob(job, options.signal);
}
export async function unifiedIndexStatus(root) {
  const runtime = await runtimeFor(root, "read");
  await runtime.publication.refresh();
  const status = runtime.publication.status();
  const backends = Object.fromEntries(["retrieval", "graph"].map((projection) => {
    const view = runtime.publication.view(projection);
    return [BACKEND[projection], { present: Boolean(view), ready: view?.state === "clean", building: view?.state === "applying",
      needsRecovery: view?.state === "needs_recovery", view, stateRoot: view?.storeRoot ?? runtime.scope.canonicalStateRoot }];
  }));
  return { root, workspaceId: runtime.scope.workspaceId, stateRoot: runtime.scope.canonicalStateRoot,
    views: status.views, mixedViews: status.mixedViews, applying: status.applying, needsRecovery: status.needsRecovery,
    pendingBatches: status.pendingBatches.map(({ batchId, manifestId, projections, profileDigest }) => ({ batchId, manifestId, projections, profileDigest })), backends };
}

/** Pin only index reads. Semantic work never extends the index lease lifetime. */
export async function unifiedStage(reads, input, deadline, execute) {
  const indexed = reads.filter((read) => read.backend !== "serena");
  const results = new Map();
  const semantic = reads.filter((read) => read.backend === "serena").map(async (read) => {
    const [settled] = await Promise.allSettled([execute(read)]); results.set(read, settled);
  });
  const indexes = (async () => {
    if (!indexed.length) return;
    try {
      const readiness = await ensureIndexes(input.root, [...new Set(indexed.map((read) => read.backend))], {
        freshness: input.freshness, timeoutMs: deadline.budget(input.indexTimeoutMs), signal: deadline.signal,
      });
      const ready = new Set(readiness.filter((row) => row.ready && !row.building).map((row) => row.backend));
      for (const read of indexed.filter((read) => !ready.has(read.backend))) {
        const row = readiness.find((entry) => entry.backend === read.backend);
        const detail = row?.error ?? row?.detail ?? (row?.building ? "the index is being built in the background" : "no clean published view");
        results.set(read, { status: "fulfilled", value: failureEnvelope(read.backend, read.operation, row?.building ? "INDEX_BUILDING" : "INDEX_UNAVAILABLE",
          row?.building ? `${detail}; use native exact search meanwhile and retry later` : detail) });
      }
      const usable = indexed.filter((read) => ready.has(read.backend));
      const runtime = await runtimeFor(input.root, "read");
      await runtime.publication.read([...new Set(usable.map((read) => COMPONENT[read.backend]))], { requireCoherent: true, signal: deadline.signal }, async (views) => {
        const lease = { runtime, views };
        const settled = await Promise.allSettled(usable.map((read) => execute(read, lease)));
        if (input.freshness === "strict") {
          const batch = currentBatch(runtime, COMPONENT[usable[0].backend]);
          const verified = await capture(runtime, batch.manifest?.observedSeq ?? observeIndexState(input.root)?.generation ?? 1, batch.embedding);
          if (verified.manifest.id !== batch.manifestId) throw new Error("source_changed: source or policy changed during strict query");
        }
        usable.forEach((read, index) => results.set(read, settled[index]));
      });
    } catch (error) {
      for (const read of indexed) if (!results.has(read)) results.set(read, { status: "rejected", reason: error });
    }
  })();
  await Promise.all([...semantic, indexes]);
  return reads.map((read) => results.get(read));
}
async function semanticPort(runtime, language) {
  const existing = runtime.semantic.get(language);
  if (existing) return existing;
  const api = await core();
  const languageServerPath = trustedLanguageServers()[language];
  const port = api.createSemanticAdapter({ workspaceId: runtime.scope.workspaceId, sourceRoot: runtime.root,
    scopeDigest: runtime.scope.scopeDigest, buildContextDigest: runtime.scope.buildContextDigest,
    trustedForLanguageTools: runtime.scope.trustedForLanguageTools && typeof languageServerPath === "string" && path.isAbsolute(languageServerPath),
    language, ...(languageServerPath ? { languageServerPath } : {}), upstreamCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd", workerPath: path.join(ROOT_DIR, "workers/semantic/main.mjs") });
  runtime.semantic.set(language, port);
  return port;
}
function fileBytes(cache, relativePath) {
  if (!cache.has(relativePath)) return null;
  const captured = cache.get(relativePath);
  if (captured && typeof captured.content === "string") {
    const bytes = Buffer.from(captured.content, "utf8");
    if (bytes.byteLength !== captured.byteLength || createHash("sha256").update(bytes).digest("hex") !== captured.contentHash) return null;
    cache.set(relativePath, bytes);
    return bytes;
  }
  return Buffer.isBuffer(captured) ? captured : null;
}
function toProductEvidence(item, { component, operation, root, upstreamCommit, index, fileCache }) {
  const provenance = { backend: BACKEND[component], operation, backendVersion: upstreamCommit ?? "unknown", adapterVersion: ADAPTER_VERSION, executionId: `${component}-${randomUUID()}` };
  const text = item.text ?? "";
  if (!text) return null;
  if (!item.anchor) return { typed: false, value: Evidence.makeOpaque({ id: `${provenance.executionId}-${index}`, text, reason: "unsupported_shape", provenance }) };
  const bytes = fileBytes(fileCache, item.anchor.relativePath);
  if (!bytes) return { typed: false, value: Evidence.makeOpaque({ id: `${provenance.executionId}-${index}`, text, reason: "unsupported_shape", provenance }) };
  const range = lineRangeForSpan(bytes, item.anchor.span);
  const alias = item.aliases[0];
  return { typed: true, value: Evidence.makeEvidence({
    id: `${provenance.executionId}-${index}`, kind: KIND_TO_PRODUCT[item.kind] ?? "retrieval", method: METHOD_TO_PRODUCT[item.method] ?? "hybrid_retrieval",
    locator: { rootKey: root, relativePath: item.anchor.relativePath, range },
    ...(alias ? { subject: { qualifiedName: alias.nativeId, backendId: alias.nativeId, backendNamespace: alias.engine } } : {}),
    text, textKind: item.textKind ?? "source", anchor: item.anchor, projectionView: item.projectionView, semanticObservation: item.semanticObservation,
    coverage: item.coverage, relatedAnchors: item.relatedAnchors,
    sourceCheck: item.sourceCheck === "matched" ? { status: "matched", sha256: item.anchor.contentHash }
      : { status: item.sourceCheck === "mismatch" ? "mismatch" : "unchecked", reason: "captured source requires current-file verification" },
    observation: { before: null, after: null, consistency: "unverified" }, provenance: [provenance],
  }) };
}
const ISSUE_TO_ERROR_CODE = { invalid_input: "MALFORMED_RESPONSE", ambiguous_subject: "UNRECOGNIZED_RESPONSE", unsupported_capability: "UNSUPPORTED_CAPABILITY",
  index_building: "INDEX_BUILDING", source_changed: "SOURCE_MISMATCH", freshness_unavailable: "INDEX_UNAVAILABLE", deadline: "TIMEOUT", cancelled: "CANCELLED",
  protocol_error: "MALFORMED_RESPONSE", worker_failed: "TRANSPORT_CLOSED", needs_recovery: "INDEX_UNAVAILABLE", output_truncated: "OUTPUT_LIMIT" };
function toEnvelope(result, details) {
  const backend = BACKEND[details.component];
  const blocking = result.issues.find((issue) => issue.code !== "output_truncated");
  if (result.outcome === "error" || result.outcome === "unavailable") {
    return failureEnvelope(backend, details.operation, blocking ? ISSUE_TO_ERROR_CODE[blocking.code] ?? "TOOL_ERROR" : "TOOL_ERROR", blocking?.message ?? backend + " read failed", { outcome: result.outcome, timing: details.timing, views: result.views, semanticObservations: result.semanticObservations, issues: result.issues });
  }
  const items = [], opaque = [];
  for (const [index, item] of result.evidence.entries()) {
    const converted = toProductEvidence(item, { ...details, index });
    if (converted) (converted.typed ? items : opaque).push(converted.value);
  }
  const views = result.views ?? [...new Map(result.evidence.filter((item) => item.projectionView).map((item) => [item.projectionView.viewId, item.projectionView])).values()];
  const semanticObservations = result.semanticObservations ?? result.evidence.flatMap((item) => item.semanticObservation ? [item.semanticObservation] : []);
  return envelope({ backend, operation: details.operation, outcome: result.outcome, items, opaque,
    coverage: result.coverage.completeWithinScope === true ? "backend_complete" : result.coverage.completeWithinScope === false ? "bounded" : "unknown",
    returned: items.length + opaque.length, total: result.coverage.omitted === null ? null : items.length + opaque.length + result.coverage.omitted,
    truncated: result.issues.some((issue) => issue.code === "output_truncated") || items.length + opaque.length < result.evidence.length,
    timing: details.timing, views, semanticObservations, issues: result.issues });
}
export async function unifiedRead(read, input, deadline, lease) {
  if (read.backend !== "serena" && !lease) {
    const [settled] = await unifiedStage([read], input, deadline, (selected, pin) => unifiedRead(selected, input, deadline, pin));
    if (settled.status === "rejected") throw settled.reason;
    return settled.value;
  }
  const started = performance.now();
  const component = COMPONENT[read.backend];
  const runtime = lease?.runtime ?? await runtimeFor(input.root, "read");
  const api = await core();
  const context = { requestId: api.newRequestId(component), signal: deadline.signal, deadlineMonotonicMs: performance.now() + deadline.budget(input.timeoutMs),
    workspaceId: runtime.scope.workspaceId, maxEvidence: input.limit, maxOutputChars: input.maxChars, maxWireBytes: 1_048_576 };
  const fileCache = new Map();
  let result, upstreamCommit = null;
  try {
    if (component === "retrieval" || component === "graph") {
      const batch = currentBatch(runtime, component);
      const view = lease.views[component];
      for (const source of batch.sources) fileCache.set(source.relativePath, source);
      if (component === "retrieval") {
        result = await runtime.retrieval.read({ query: input.query ?? input.symbol ?? "", mode: "hybrid", scope: { ...runtime.scope, canonicalStateRoot: view.storeRoot },
          view, sources: batch.sources, limit: input.limit }, context);
        upstreamCommit = runtime.retrievalPool.upstreamCommit;
      } else {
        result = await runtime.graph.read({ operation: read.operation === "impact" ? "impact" : read.operation === "architecture" ? "architecture" : "context",
          query: input.query ?? input.symbol ?? "", subject: input.symbol ? { namePath: input.symbol, relativePath: input.relativePath ?? null, anchor: null, nativeAlias: null } : null,
          depth: input.depth, view, sources: batch.sources }, context);
        upstreamCommit = runtime.graphPool.upstreamCommit;
      }
      result = { ...result, views: [view] };
      if (result.issues?.some((issue) => issue.code === "worker_failed")) noteIndexReadFailure(input.root, read.backend, result.issues.map((issue) => issue.message).join("; "));
    } else {
      const language = LANGUAGE_BY_EXTENSION[path.extname(input.relativePath ?? "").toLowerCase()];
      if (!language) return failureEnvelope("serena", read.operation, "UNSUPPORTED_CAPABILITY", "Cannot determine the language; supply relativePath with a recognized source-file extension.");
      const port = await semanticPort(runtime, language);
      result = await port.read({ operation: read.operation, subject: input.symbol ? { namePath: input.symbol, relativePath: input.relativePath ?? null, anchor: null, nativeAlias: null } : null,
        relativePath: input.relativePath ?? null, includeBody: input.includeBody, depth: input.depth, substringMatching: input.substringMatching, maxMatches: input.limit }, context);
      const files = [...new Set(result.evidence.flatMap((item) => item.anchor ? [item.anchor.relativePath] : []))];
      if (files.length) {
        const sources = await api.captureSourceSnapshots({ workspaceId: runtime.scope.workspaceId, sourceRoot: runtime.root,
          files, observedSeq: String(observeIndexState(input.root)?.generation ?? 1), scopeDigest: runtime.scope.scopeDigest, ...(await profiles()) });
        for (const source of sources) fileCache.set(source.relativePath, source);
      }
    }
    const stale = result.evidence.filter((item) => item.anchor && fileCache.get(item.anchor.relativePath)?.contentHash !== item.anchor.contentHash);
    if (stale.length) {
      const rejected = new Set(stale);
      result = { ...result, outcome: "partial", evidence: result.evidence.filter((item) => !rejected.has(item)),
        coverage: { ...result.coverage, completeWithinScope: false },
        issues: [...result.issues, { code: "source_changed", message: "Evidence no longer matches the captured source bytes", retryable: true }] };
    }
    const totalMs = Math.max(0, Math.round(performance.now() - started));
    return toEnvelope(result, { component, operation: read.operation, root: input.root, upstreamCommit, fileCache, timing: { prepareMs: 0, queueMs: 0, executeMs: totalMs, totalMs } });
  } catch (error) {
    if (deadline.signal.aborted) throw error;
    return failureEnvelope(read.backend, read.operation, "TRANSPORT_CLOSED", error.message);
  }
}
export async function unifiedSemanticStatus(root) {
  const runtime = await runtimeFor(root, "read");
  return { backend: "serena", ok: true, configuredLanguages: Object.keys(trustedLanguageServers()), activeLanguages: [...runtime.semantic.keys()] };
}
export async function repairUnifiedSemantic(root) {
  const runtime = await runtimeFor(root, "write");
  const ports = [...runtime.semantic.values()];
  runtime.semantic.clear();
  await Promise.all(ports.map((port) => port.close()));
  return { backend: "serena", ok: true, action: "repair", building: false };
}
export async function unifiedHasInFlightWork() {
  const settled = await Promise.allSettled([...runtimes.values()]);
  return settled.some(({ status, value }) => status === "fulfilled" && (value.activeSync > 0 || value.publication.status().applying || value.publication.status().pendingBatches.length > 0));
}
export async function closeUnified() {
  const entries = [...runtimes.values()];
  runtimes.clear();
  await Promise.all(entries.map(async (pending) => {
    let runtime;
    try {
      runtime = await pending;
      clearTimeout(runtime.idleTimer);
      runtime.closed = true;
      await Promise.all([runtime.retrieval.close(), runtime.graph.close(), ...[...runtime.semantic.values()].map((port) => port.close())]);
      await runtime.sync;
      await runtime.publication.close();
    } catch (error) { log("warn", "unified runtime shutdown failed", { error: error.message }); }
    finally { if (runtime) await runtime.scope.release(); }
  }));
  await Promise.all([...workerPools.values()].map((pool) => pool.close()));
  workerPools.clear();
}
export const __internals = { lineRangeForSpan, METHOD_TO_PRODUCT, KIND_TO_PRODUCT, runtimeFor };
