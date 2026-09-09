import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { canonicalDirectory } from "./lib/roots.js";
import { homedir } from "node:os";
import path from "node:path";
import { resolveBin, run } from "./lib/process.js";
import { log } from "./lib/log.js";

const roots = new Map();
const MAX_ROOTS = intEnv("LAZY_INTEL_MAX_ROOTS", 8, 1, 64);
const MAINTENANCE_MS = intEnv("LAZY_INTEL_MAINTENANCE_MS", 5_000, 0, 300_000);
// Only used when the filesystem watcher is unavailable: without change events, time is
// the only remaining freshness signal.
const MAX_STALE_MS = intEnv("LAZY_INTEL_MAX_STALE_MS", 60_000, 5_000, 3_600_000);
const DEFAULT_TIMEOUT_MS = intEnv("LAZY_INTEL_INDEX_TIMEOUT_MS", 120_000, 5_000, 1_800_000);
const PROBE_TIMEOUT_MS = intEnv("LAZY_INTEL_PROBE_TIMEOUT_MS", 20_000, 1_000, 120_000);
const AUTO_REPAIR = process.env.LAZY_INTEL_AUTO_REPAIR !== "false";
// Unset by default on purpose: a new zvec index then inherits the shared zvec-grep
// configuration (global default model + model cache) instead of creating a second vector space.
const EXPLICIT_EMBEDDING = process.env.LAZY_INTEL_EMBEDDING || undefined;
const ZVEC_MODE = process.env.LAZY_INTEL_ZVEC_MODE ?? "auto";
export const INDEX_BACKENDS = ["zvec", "codegraph"];

const IGNORED_SEGMENTS = new Set([
  ".git", ".hg", ".svn", ".zvec-grep", ".codegraph", ".serena", "node_modules", ".venv", "venv",
  "DerivedData", ".build", ".swiftpm", "target", "dist", "build", "out", ".next", ".turbo",
  ".gradle", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache",
]);

// Agent private state is not a source workspace. The OMP home holds ~100k session
// transcripts, blobs, logs and SQLite WALs that the harness rewrites every second, so a
// watcher rooted there can never settle: every sync re-embeds files the running agent is
// still appending to. Matched by exact directory, never by prefix, so a real project nested
// inside one — such as ~/.omp/agent — stays indexable.
const DENIED_ROOTS = new Set(
  [
    process.env.OMP_HOME || path.join(homedir(), ".omp"),
    process.env.ZVEC_GREP_HOME || path.join(homedir(), ".zvec-grep"),
    ...(process.env.LAZY_INTEL_DENY_ROOTS ?? "").split(path.delimiter),
  ].filter(Boolean).map((entry) => path.resolve(entry)),
);

let maintenanceTimer;

export function isDeniedRoot(root) {
  let canonical;
  try { canonical = realpathSync(root); } catch { canonical = path.resolve(root); }
  for (const denied of DENIED_ROOTS) {
    if (denied === canonical) return true;
    try { if (realpathSync(denied) === canonical) return true; } catch {}
  }
  return false;
}

export async function bootstrapRoot(root) {
  root = await canonicalDirectory(root);
  // cwd is frequently the OMP home itself; that is an ordinary skip, not a failure.
  if (isDeniedRoot(root)) {
    log("info", "skipping automatic indexing of agent private state", { root: path.resolve(root) });
    return null;
  }
  const state = await ensureState(root);
  // Never block MCP startup on a first-time index.
  queueMicrotask(() => {
    ensureBackends(state, INDEX_BACKENDS, { freshness: "auto", timeoutMs: DEFAULT_TIMEOUT_MS })
      .catch((error) => log("warn", "background bootstrap failed", { root: state.root, error: error.message }));
  });
  startMaintenanceLoop();
  return state;
}

export async function ensureIndexes(root, backends, options = {}) {
  const state = await ensureState(root);
  startMaintenanceLoop();
  return ensureBackends(state, indexBackends(backends), options);
}

export async function syncIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  const state = await ensureState(root);
  return serialPerBackend(state, indexBackends(backends), async (backend) => {
    const created = await ensureCreated(state, backend, options);
    if (created?.building) return created;
    return refreshBackend(state, backend, options);
  });
}

export async function reindexIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  const state = await ensureState(root);
  return serialPerBackend(state, indexBackends(backends), (backend) => rebuildBackend(state, backend, options));
}

export async function repairIndexes(root, backends = INDEX_BACKENDS, options = {}) {
  const state = await ensureState(root);
  return serialPerBackend(state, indexBackends(backends), async (backend) => {
    try {
      const created = await ensureCreated(state, backend, options);
      if (created?.building) return created;
      return await refreshBackend(state, backend, options);
    } catch (first) {
      options.signal?.throwIfAborted();
      log("warn", "index repair escalating to rebuild", { root: state.root, backend, error: first.message });
      return rebuildBackend(state, backend, options);
    }
  });
}

export async function indexStatus(root, options = {}) {
  const state = await ensureState(root);
  const result = {
    root: state.root,
    generation: state.generation,
    watcher: state.watcherActive,
    embedding: EXPLICIT_EMBEDDING ?? `inherited from zvec-grep configuration (${await configuredEmbedding() ?? "unset"})`,
    zvecTransport: ZVEC_MODE,
    freshnessSource: state.watcherActive ? "filesystem watcher" : `periodic fallback (${MAX_STALE_MS}ms)`,
    backends: {},
  };
  for (const backend of INDEX_BACKENDS) {
    const b = state.backends[backend];
    const probe = await probeBackend(state, backend, { ...options, force: true }).catch((error) => ({
      present: false, ready: false, building: false, detail: error.message,
    }));
    result.backends[backend] = {
      present: probe.present,
      ready: probe.ready,
      building: probe.building,
      detail: probe.detail,
      // null = this process has not synced yet, so "changed since last sync" is unknowable.
      dirty: hasBaseline(b) ? b.applied < state.generation : null,
      baseline: hasBaseline(b) ? "applied" : "unverified",
      appliedGeneration: b.applied,
      lastSyncAt: b.lastSyncAt || null,
      consecutiveFailures: b.consecutiveFailures,
      lastError: b.lastError ?? null,
      busy: Boolean(b.queue),
    };
  }
  return result;
}

async function ensureState(root) {
  const absolute = await canonicalDirectory(root);
  if (isDeniedRoot(absolute)) {
    throw new Error(`root is agent private state, not a source workspace: ${absolute} `
      + "(run from the project directory, or set LAZY_INTEL_DENY_ROOTS to change the deny list)");
  }
  const existing = roots.get(absolute);
  if (existing) return existing;
  if (roots.size >= MAX_ROOTS) throw new Error(`workspace limit reached (${MAX_ROOTS}); restart lazy-intel to release watchers`);
  const state = {
    root: absolute,
    generation: 1,
    watcher: null,
    watcherActive: false,
    backends: { zvec: backendState(), codegraph: backendState() },
  };
  roots.set(absolute, state);
  attachWatcher(state);
  return state;
}

function backendState() {
  return {
    applied: 0, lastSyncAt: 0, consecutiveFailures: 0, lastError: null,
    queue: null, ready: false, nextAttemptAt: 0,
  };
}

// A baseline exists only after this process created or synced the index itself.
function hasBaseline(b) {
  return b.applied > 0;
}

// With a live watcher, dirtiness is authoritative and time means nothing. Without one,
// fall back to periodic freshness so changes are not missed forever.
function isStale(state, b, options = {}) {
  if (state.watcherActive || !hasBaseline(b)) return false;
  const maxStaleMs = options.maxStaleMs ?? MAX_STALE_MS;
  return Date.now() - b.lastSyncAt >= maxStaleMs;
}

// A backend that keeps failing must not be hammered: 30s, 1m, 2m, … capped at 15m.
function failureBackoffMs(failures) {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 900_000);
}

function attachWatcher(state) {
  try {
    state.watcher = watch(state.root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename || shouldIgnore(String(filename))) return;
      state.generation += 1;
    });
    state.watcher.on("error", (error) => {
      state.watcherActive = false;
      log("warn", "filesystem watcher failed; explicit sync still available", { root: state.root, error: error.message });
    });
    state.watcherActive = true;
  } catch (error) {
    log("warn", "filesystem watcher unavailable; explicit sync still available", { root: state.root, error: error.message });
  }
}

function shouldIgnore(filename) {
  const normalized = filename.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.endsWith(".swp") || normalized.endsWith("~") || normalized.endsWith(".tmp")) return true;
  // Every segment is checked so nested vendor/derived directories cannot create sync feedback loops.
  return normalized.split("/").some((segment) => segment === ".DS_Store" || IGNORED_SEGMENTS.has(segment));
}

async function ensureBackends(state, backends, options) {
  return serialPerBackend(state, backends, async (backend) => {
    const b = state.backends[backend];
    try {
      const created = await ensureCreated(state, backend, options);
      if (created?.building) return created;
      const freshness = options.freshness ?? "auto";
      // Without a baseline from this process, changes made while it was down are unknown:
      // reconcile exactly once, then stay change-driven.
      const needsReconcile = !hasBaseline(b);
      const dirty = hasBaseline(b) && b.applied < state.generation;
      const stale = isStale(state, b, options);
      if (freshness === "strict" || (freshness === "auto" && (dirty || needsReconcile || stale))) {
        return await refreshBackend(state, backend, options);
      }
      return row(backend, true, "ready", { dirty });
    } catch (error) {
      options.signal?.throwIfAborted();
      b.ready = false;
      b.consecutiveFailures += 1;
      b.lastError = error.message;
      b.nextAttemptAt = Date.now() + failureBackoffMs(b.consecutiveFailures);
      // Escalate to a rebuild exactly once per failure streak; a broken backend must not
      // trigger a full re-index on every later attempt.
      if (AUTO_REPAIR && b.consecutiveFailures === 2) {
        try {
          log("warn", "automatic index repair", { root: state.root, backend, failures: b.consecutiveFailures });
          return await rebuildBackend(state, backend, options);
        } catch (repairError) {
          b.lastError = repairError.message;
          b.nextAttemptAt = Date.now() + failureBackoffMs(b.consecutiveFailures);
        }
      }
      return row(backend, false, "failed", { error: b.lastError, retryAfterMs: Math.max(0, b.nextAttemptAt - Date.now()) });
    }
  });
}

async function ensureCreated(state, backend, options = {}) {
  const b = state.backends[backend];
  if (b.ready) return null;
  const probe = await probeBackend(state, backend, options);
  if (probe.building) return row(backend, true, "building", { detail: probe.detail });
  if (probe.ready) {
    b.ready = true;
    if (!b.lastSyncAt) b.lastSyncAt = Date.now();
    return null;
  }
  const startedGeneration = state.generation;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (backend === "zvec") {
    const args = ["index", state.root, "--mode", ZVEC_MODE];
    const embedding = options.embedding ?? EXPLICIT_EMBEDDING ?? await configuredEmbedding();
    if (!embedding) {
      throw new Error("no zvec embedding available: set LAZY_INTEL_EMBEDDING or ZVEC_GREP_EMBEDDING, "
        + "or configure a default with `zg config model set <model>` (a new index cannot pick a model on its own)");
    }
    // Inherited values are not re-passed: zg then keeps using its own configured default.
    if (options.embedding ?? EXPLICIT_EMBEDDING) args.push("--embedding", embedding);
    await runBackend("zg", args, state, options, timeoutMs);
  } else {
    await runBackend("codegraph", ["init", state.root], state, options, timeoutMs);
  }
  markApplied(b, startedGeneration);
  log("info", "index initialized", { root: state.root, backend });
  return null;
}

// The shared zvec-grep configuration is the single source of truth for the vector space.
async function configuredEmbedding() {
  if (process.env.ZVEC_GREP_EMBEDDING) return process.env.ZVEC_GREP_EMBEDDING;
  const home = process.env.ZVEC_GREP_HOME || path.join(homedir(), ".zvec-grep");
  try {
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    return config?.defaults?.embedding ?? null;
  } catch {
    return null;
  }
}

async function refreshBackend(state, backend, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedGeneration = state.generation;
  if (backend === "zvec") {
    // Incremental pass; the stored embedding schema is reused, so no model is ever re-selected here.
    await runBackend("zg", ["index", state.root, "--mode", ZVEC_MODE], state, options, timeoutMs);
  } else {
    await runBackend("codegraph", ["sync", state.root], state, options, timeoutMs);
  }
  markApplied(state.backends[backend], startedGeneration);
  return row(backend, true, "synced", { generation: startedGeneration });
}

async function rebuildBackend(state, backend, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedGeneration = state.generation;
  if (backend === "zvec") {
    const args = ["index", state.root, "--mode", ZVEC_MODE, "--rebuild"];
    // Only an explicit request changes the vector space; otherwise the existing schema is kept.
    const embedding = options.embedding ?? (options.allowConfiguredEmbedding ? EXPLICIT_EMBEDDING : undefined);
    if (embedding) args.push("--embedding", embedding);
    await runBackend("zg", args, state, options, timeoutMs);
  } else {
    await runBackend("codegraph", ["index", state.root], state, options, timeoutMs);
  }
  markApplied(state.backends[backend], startedGeneration);
  return row(backend, true, "rebuilt", { generation: startedGeneration });
}

async function probeBackend(state, backend, options = {}) {
  const timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  if (backend === "zvec") {
    const result = await runBackend("zg", ["status", state.root, "--mode", ZVEC_MODE, "--check-ready"], state, options, timeoutMs, true);
    const text = `${result.stdout}\n${result.stderr}`;
    const building = /state:\s*(indexing|updating)|index is (updating|indexing)/i.test(text);
    const absent = /not configured|no workspace index/i.test(text);
    return { present: !absent, ready: result.code === 0, building: building && !absent, detail: firstLine(text) };
  }
  const result = await runBackend("codegraph", ["status", state.root], state, options, timeoutMs, true);
  const text = `${result.stdout}\n${result.stderr}`;
  const absent = /not initialized|not configured/i.test(text);
  const detail = pickLine(text, /not initialized|not configured|symbols?|files?|up to date|stale|last index/i);
  return { present: !absent, ready: result.code === 0 && !absent, building: false, detail };
}

async function runBackend(bin, args, state, options, timeoutMs, tolerateFailure = false) {
  const command = await resolveBin(bin);
  const env = bin === "codegraph" ? { DO_NOT_TRACK: "1" } : {};
  try {
    return await run(command, args, {
      cwd: state.root, timeoutMs, signal: options.signal, maxOutputBytes: 8 * 1024 * 1024, env,
    });
  } catch (error) {
    if (tolerateFailure && error.result) return error.result;
    throw error;
  }
}

function markApplied(b, generation) {
  b.applied = generation;
  b.lastSyncAt = Date.now();
  b.consecutiveFailures = 0;
  b.lastError = null;
  b.ready = true;
}

// FIFO per backend: a queued reindex/repair runs after the in-flight job instead of
// silently inheriting its result.
function serialPerBackend(state, backends, fn) {
  return Promise.all(backends.map((backend) => {
    const b = state.backends[backend];
    const previous = b.queue ?? Promise.resolve();
    const result = previous.then(() => fn(backend), () => fn(backend));
    const settled = result.then(ignore, ignore);
    b.queue = settled;
    settled.then(() => {
      if (b.queue === settled) b.queue = null;
    });
    return result;
  }));
}

function startMaintenanceLoop() {
  if (maintenanceTimer || MAINTENANCE_MS <= 0) return;
  maintenanceTimer = setInterval(() => {
    const now = Date.now();
    for (const state of roots.values()) {
      // Change-driven, deduplicated, backoff-aware: a quiet or broken workspace costs
      // zero subprocesses and never accumulates a queue backlog.
      const due = INDEX_BACKENDS.filter((backend) => {
        const b = state.backends[backend];
        if (b.queue || now < b.nextAttemptAt) return false;
        return b.applied < state.generation || b.consecutiveFailures > 0 || !b.ready || isStale(state, b);
      });
      if (!due.length) continue;
      ensureBackends(state, due, { freshness: "auto", timeoutMs: DEFAULT_TIMEOUT_MS })
        .catch((error) => log("warn", "background index maintenance failed", { root: state.root, error: error.message }));
    }
  }, MAINTENANCE_MS);
  maintenanceTimer.unref();
}

function indexBackends(backends) {
  const list = Array.isArray(backends) ? backends : [backends];
  const filtered = [...new Set(list.filter((x) => INDEX_BACKENDS.includes(x)))];
  if (!filtered.length) throw new Error(`no derived-index backend selected from: ${JSON.stringify(list)}`);
  return filtered;
}

function ignore() {}

function firstLine(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? null;
}

function pickLine(text, pattern) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((line) => pattern.test(line)) ?? lines[0] ?? null;
}

function row(backend, ok, action, detail = {}) {
  return { backend, ok, action, ...detail };
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function closeIndexManager() {
  clearInterval(maintenanceTimer);
  maintenanceTimer = undefined;
  for (const state of roots.values()) state.watcher?.close();
  roots.clear();
}
