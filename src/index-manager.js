import { watch, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalDirectory, containsPath } from "./lib/roots.js";
import { log } from "./lib/log.js";
import { configuredEmbedding } from "./lifecycle.js";
import { IGNORE_FILE_NAME, isDerivedSegment, isTransientFile, loadScopeIgnore } from "../packages/core/dist/workspace/scope-policy.js";

const roots = new Map();
const processEpoch = randomUUID();
const MAX_ROOTS = intEnv("LAZY_INTEL_MAX_ROOTS", 8, 1, 64);
const MAINTENANCE_MS = intEnv("LAZY_INTEL_MAINTENANCE_MS", 5_000, 0, 300_000);
const MAX_STALE_MS = intEnv("LAZY_INTEL_MAX_STALE_MS", 60_000, 5_000, 3_600_000);
const BOOTSTRAP_TIMEOUT_MS = intEnv("LAZY_INTEL_BOOTSTRAP_TIMEOUT_MS", 1_800_000, 5_000, 3_600_000);
const DEFAULT_TIMEOUT_MS = intEnv("LAZY_INTEL_INDEX_TIMEOUT_MS", 120_000, 5_000, 1_800_000);
const EXPLICIT_EMBEDDING = process.env.LAZY_INTEL_EMBEDDING || undefined;
const AUTO_REPAIR = process.env.LAZY_INTEL_AUTO_REPAIR !== "false";
export const INDEX_BACKENDS = ["zvec", "codegraph"];

const DENIED_TREES = [...new Set([
  process.env.OMP_HOME || path.join(homedir(), ".omp"),
  process.env.ZVEC_GREP_HOME || path.join(homedir(), ".zvec-grep"),
  ...(process.env.LAZY_INTEL_DENY_ROOTS ?? "").split(path.delimiter),
].filter(Boolean).map(canonicalPath))];
const DENIED_EXACT = new Set([canonicalPath(homedir())]);
let maintenanceTimer;

function canonicalPath(entry) {
  try { return realpathSync(entry); } catch { return path.resolve(entry); }
}
export function isDeniedRoot(root) {
  const canonical = canonicalPath(root);
  if (DENIED_EXACT.has(canonical)) return true;
  for (const denied of DENIED_TREES) {
    if (containsPath(denied, canonical)) return true;
    try { if (containsPath(realpathSync(denied), canonical)) return true; } catch {}
  }
  return false;
}
export async function bootstrapRoot(root) {
  root = await canonicalDirectory(root);
  if (isDeniedRoot(root)) {
    log("info", "skipping automatic indexing of agent private state", { root });
    return null;
  }
  const state = await ensureState(root);
  queueMicrotask(() => runPublication(state, INDEX_BACKENDS, { freshness: "auto", timeoutMs: DEFAULT_TIMEOUT_MS }, "ensure")
    .catch((error) => log("warn", "background bootstrap failed", { root, error: error.message })));
  startMaintenanceLoop();
  return state;
}
export function observeIndexState(root) {
  const state = roots.get(canonicalPath(root));
  if (!state) return null;
  const applied = INDEX_BACKENDS.map((backend) => state.backends[backend].applied).filter((generation) => generation > 0);
  return { processEpoch, generation: state.generation, appliedGeneration: applied.length ? Math.min(...applied) : null,
    watcher: state.watcherState, baseline: applied.length ? "applied" : "unverified" };
}
export async function ensureIndexes(root, backends, options = {}) {
  const state = await ensureState(root);
  startMaintenanceLoop();
  return runPublication(state, indexBackends(backends), options, "ensure");
}
export async function syncIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  return runPublication(await ensureState(root), indexBackends(backends), options, "sync");
}
export async function reindexIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  return runPublication(await ensureState(root), indexBackends(backends), options, "rebuild");
}
export async function repairIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  return runPublication(await ensureState(root), indexBackends(backends), options, "repair");
}
export async function indexStatus(root) {
  const state = await ensureState(root);
  const published = await (await import("./unified.js")).unifiedIndexStatus(state.root);
  return { ...published, generation: state.generation, watcher: state.watcherActive,
    embedding: EXPLICIT_EMBEDDING ?? `inherited from zvec-grep configuration (${await configuredEmbedding() ?? "unset"})`,
    freshnessSource: state.watcherActive ? "filesystem watcher" : `periodic fallback (${MAX_STALE_MS}ms)`,
    backends: Object.fromEntries(INDEX_BACKENDS.map((backend) => {
      const b = state.backends[backend];
      return [backend, { ...published.backends[backend], dirty: hasBaseline(b) ? b.applied < state.generation : null,
        baseline: hasBaseline(b) ? "applied" : "unverified", appliedGeneration: b.applied, lastSyncAt: b.lastSyncAt || null,
        consecutiveFailures: b.consecutiveFailures, lastError: b.lastError, busy: b.pending > 0 }];
    })),
  };
}

async function ensureState(root) {
  const absolute = await canonicalDirectory(root);
  if (isDeniedRoot(absolute)) throw new Error(`root is agent private state, not a source workspace: ${absolute}`);
  const existing = roots.get(absolute);
  if (existing) return existing;
  if (roots.size >= MAX_ROOTS) throw new Error(`workspace limit reached (${MAX_ROOTS}); restart lazy-intel to release watchers`);
  const scopeIgnore = await loadScopeIgnore(absolute);
  const state = { root: absolute, scopeIgnore, generation: 1, watcher: null, watcherActive: false, watcherState: "unknown", closed: false,
    publicationQueue: Promise.resolve(), queueDepth: 0, ensures: new Map(), backgroundBuild: null,
    backends: { zvec: backendState(), codegraph: backendState() } };
  roots.set(absolute, state);
  attachWatcher(state);
  return state;
}
function backendState() {
  return { applied: 0, lastSyncAt: 0, consecutiveFailures: 0, lastError: null, errorCode: null, holderPid: null, pending: 0, ready: false, nextAttemptAt: 0, readFailed: false };
}
function hasBaseline(b) { return b.applied > 0; }
function isStale(state, b, options = {}) {
  return !state.watcherActive && hasBaseline(b) && Date.now() - b.lastSyncAt >= (options.maxStaleMs ?? MAX_STALE_MS);
}
function attachWatcher(state) {
  const failed = (error) => {
    state.generation += 1; state.watcherActive = false; state.watcherState = "unavailable";
    log("warn", "filesystem watcher unavailable; periodic freshness checks remain active", { root: state.root, error: error.message });
  };
  try {
    state.watcher = watch(state.root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename || !shouldIgnore(String(filename), state)) state.generation += 1;
    });
    state.watcher.on("error", failed);
    state.watcherActive = true; state.watcherState = "active";
  } catch (error) { failed(error); }
}
function shouldIgnore(filename, state) {
  const normalized = filename.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === IGNORE_FILE_NAME) { loadScopeIgnore(state.root).then((policy) => { state.scopeIgnore = policy; }).catch(() => {}); return false; }
  return isTransientFile(normalized) || normalized.split("/").some((segment) => isDerivedSegment(segment)) || state.scopeIgnore.ignores(normalized, false);
}
function markApplied(b, generation) {
  b.applied = generation; b.lastSyncAt = Date.now(); b.consecutiveFailures = 0; b.lastError = null;
  b.nextAttemptAt = 0; b.ready = true; b.readFailed = false; b.errorCode = null; b.holderPid = null;
}
export function noteIndexReadFailure(root, backend, message) {
  const b = roots.get(canonicalPath(root))?.backends[backend];
  if (b) { b.ready = false; b.readFailed = true; b.lastError = message; }
}
function join(job, signal) {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    job.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function scheduleBackgroundBuild(state, backends) {
  if (state.backgroundBuild) return;
  const now = Date.now();
  if (backends.some((backend) => now < state.backends[backend].nextAttemptAt)) return;
  const job = runPublication(state, backends, { freshness: "auto", timeoutMs: BOOTSTRAP_TIMEOUT_MS }, "bootstrap");
  state.backgroundBuild = job;
  void job.then((rows) => {
    if (rows.some((row) => !row.ok)) {
      log("warn", "background index bootstrap failed", { root: state.root, error: rows.find((row) => !row.ok)?.error ?? "unknown error" });
    }
  }, (error) => {
    log("warn", "background index bootstrap failed", { root: state.root, error: error.message });
  }).finally(() => {
    if (state.backgroundBuild === job) state.backgroundBuild = null;
  });
}
/** The watcher schedules work; only a published durable view grants readiness. */
function runPublication(state, backends, options, action) {
  options.signal?.throwIfAborted();
  const key = action === "ensure" ? [...backends].sort().join(",") + ":" + (options.freshness ?? "auto") : null;
  const existing = key && state.ensures.get(key);
  if (existing) return join(existing, options.signal);
  if (state.queueDepth >= 32 && action !== "ensure") return Promise.reject(new Error("workspace publication queue is full"));
  const freshness = options.freshness ?? "auto";
  if (action === "ensure" && freshness !== "strict") {
    return assessReadiness(state, backends, options).then((result) => {
      if (result.canRead && result.coherent) {
        if (freshness === "fast" || result.fresh) return backends.map((backend) => ({ backend, ok: true, ready: true, building: false, action: "ready", view: result.status.backends[backend].view, dirty: !result.fresh }));
        scheduleBackgroundBuild(state, backends);
        return backends.map((backend) => ({ backend, ok: true, ready: true, building: false, action: "ready", view: result.status.backends[backend].view, dirty: true }));
      }
      scheduleBackgroundBuild(state, backends);
      return backends.map((backend) => buildingRow(backend, state.backends[backend]));
    });
  }
  const run = async () => {
    if (state.closed) throw new Error("workspace is closing");
    const { synchronizeWorkspace } = await import("./unified.js");
    const { readFailed } = await assessReadiness(state, backends, options);
    const generation = state.generation;
    try {
      // Watcher hints can arrive while capture/publication is in flight. Reconcile a
      // bounded number of generations, but never claim a generation captured later.
      let rows;
      let firstRows;
      let publishedGeneration = generation;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observedGeneration = state.generation;
        rows = await synchronizeWorkspace(state.root, backends, { ...options, signal: undefined,
          rebuild: attempt === 0 && (action === "rebuild" || action === "repair" || (readFailed && AUTO_REPAIR)) });
        firstRows ??= rows;
        publishedGeneration = observedGeneration;
        if (state.generation === observedGeneration) break;
      }
      for (const backend of backends) markApplied(state.backends[backend], publishedGeneration);
      return firstRows;
    } catch (error) {
      for (const backend of backends) {
        const b = state.backends[backend];
        b.ready = false; b.lastError = error.message;
        b.errorCode = error.code;
        b.holderPid = error.holderPid;
        if (error.code === "WORKSPACE_OWNED") b.nextAttemptAt = Date.now() + 5_000;
        else {
          b.consecutiveFailures += 1;
          b.nextAttemptAt = Date.now() + Math.min(30_000 * 2 ** Math.max(0, b.consecutiveFailures - 1), 900_000);
        }
      }
      if (error.code === "WORKSPACE_OWNED") return backends.map((backend) => buildingRow(backend, state.backends[backend]));
      return backends.map((backend) => ({ backend, ok: false, ready: false, building: false, action: "failed", error: error.message, ...(error.code ? { errorCode: error.code } : {}), ...(Number.isInteger(error.holderPid) ? { holderPid: error.holderPid } : {}) }));
    }
  };
  state.queueDepth += 1;
  for (const backend of backends) state.backends[backend].pending += 1;
  const job = state.publicationQueue.then(run, run);
  const settled = job.then(() => undefined, () => undefined).finally(() => {
    state.queueDepth -= 1;
    for (const backend of backends) state.backends[backend].pending -= 1;
    if (key && state.ensures.get(key) === job) state.ensures.delete(key);
  });
  state.publicationQueue = settled;
  if (key) state.ensures.set(key, job);
  return join(job, options.signal);
}

function buildingRow(backend, state) {
  const row = { backend, ok: true, ready: false, building: true, action: "building" };
  if (state.errorCode === "WORKSPACE_OWNED") {
    row.errorCode = state.errorCode;
    row.holderPid = state.holderPid;
    row.detail = "another lazy-intel process (pid " + state.holderPid + ") owns publication for this workspace";
  }
  return row;
}
async function assessReadiness(state, backends, options) {
  const { unifiedIndexStatus } = await import("./unified.js");
  const status = await unifiedIndexStatus(state.root);
  const readFailed = backends.some((backend) => state.backends[backend].readFailed);
  const canRead = !readFailed && !status.needsRecovery && backends.every((backend) => status.backends[backend].ready);
  const coherent = new Set(backends.map((backend) => status.backends[backend].view?.appliedManifestId)).size <= 1;
  const fresh = backends.every((backend) => hasBaseline(state.backends[backend]) && state.backends[backend].applied === state.generation && !isStale(state, state.backends[backend], options));
  return { status, readFailed, canRead, coherent, fresh };
}
function startMaintenanceLoop() {
  if (maintenanceTimer || MAINTENANCE_MS <= 0) return;
  maintenanceTimer = setInterval(() => {
    const now = Date.now();
    for (const state of roots.values()) {
      const due = INDEX_BACKENDS.filter((backend) => {
        const b = state.backends[backend];
        return b.pending === 0 && now >= b.nextAttemptAt && (b.applied < state.generation || b.consecutiveFailures > 0 || !b.ready || isStale(state, b));
      });
      if (due.length) runPublication(state, due, { freshness: "auto", timeoutMs: DEFAULT_TIMEOUT_MS }, "ensure")
        .catch((error) => log("warn", "background index maintenance failed", { root: state.root, error: error.message }));
    }
  }, MAINTENANCE_MS);
  maintenanceTimer.unref();
}
function indexBackends(backends) {
  const list = Array.isArray(backends) ? backends : [backends];
  const filtered = [...new Set(list.filter((value) => INDEX_BACKENDS.includes(value)))];
  if (!filtered.length) throw new Error(`no derived-index backend selected from: ${JSON.stringify(list)}`);
  return filtered;
}
function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}
export function closeIndexManager() {
  clearInterval(maintenanceTimer); maintenanceTimer = undefined;
  for (const state of roots.values()) { state.closed = true; state.watcher?.close(); }
  roots.clear();
}
