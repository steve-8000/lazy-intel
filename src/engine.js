import { stat } from "node:fs/promises";
import path from "node:path";
import { OPERATIONS, route } from "./router.js";
import { zvecSearch } from "./backends/zvec.js";
import { codegraphQuery } from "./backends/codegraph.js";
import { repairSerena, serenaQuery, serenaStatus } from "./backends/serena.js";
import { fuse } from "./fusion.js";
import { indexStatus, repairIndexes, reindexIndexes, syncIndexes } from "./index-manager.js";
import { log } from "./lib/log.js";

const CONTROL_OPERATIONS = new Set(["status", "sync", "reindex", "repair"]);

export async function codeIntel(rawInput, signal) {
  const input = await normalizeInput(rawInput);
  if (CONTROL_OPERATIONS.has(input.operation)) return control(input, signal);

  const routes = route(input).slice(0, 2);
  log("info", "code_intel route", { operation: input.operation, routes, root: input.root });
  const perBackendChars = Math.max(2_000, Math.floor(input.maxChars / routes.length));
  const fullInput = { ...input, perBackendChars };

  const tasks = routes.map((entry) => {
    const [backend, kind] = entry.split(":");
    if (backend === "zvec") return zvecSearch(fullInput, signal);
    if (backend === "codegraph") return codegraphQuery(kind, fullInput, signal);
    if (backend === "serena") return serenaQuery(kind, fullInput);
    return Promise.resolve({ backend, ok: false, warning: `unknown backend ${backend}`, text: "" });
  });
  const results = await Promise.all(tasks);
  return {
    text: fuse(results, { maxChars: input.maxChars }),
    meta: {
      root: input.root,
      operation: input.operation,
      routes,
      freshness: input.freshness,
      backends: results.map(({ backend, ok, latencyMs, warning }) => ({ backend, ok, latencyMs, warning })),
    },
  };
}

async function control(input, signal) {
  if (input.backend === "serena" && !["status", "repair"].includes(input.operation)) {
    throw new Error(`${input.operation} is not applicable to Serena; it has no derived index. Use repair to restart its live LSP backend`);
  }
  const indexTargets = input.backend === "all"
    ? ["zvec", "codegraph"]
    : input.backend === "serena" ? [] : [input.backend];

  if (input.operation === "status") {
    const payload = {};
    if (input.backend !== "serena") {
      const indexes = await indexStatus(input.root);
      payload.indexes = input.backend === "all" ? indexes : {
        root: indexes.root,
        generation: indexes.generation,
        watcher: indexes.watcher,
        backends: { [input.backend]: indexes.backends[input.backend] },
      };
    }
    if (input.backend === "all" || input.backend === "serena") payload.serena = serenaStatus(input.root);
    return { text: JSON.stringify(payload, null, 2), meta: { root: input.root, operation: input.operation, backend: input.backend } };
  }

  const payload = [];
  if (indexTargets.length) {
    if (input.operation === "sync") payload.push(...await syncIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal }));
    else if (input.operation === "reindex") payload.push(...await reindexIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal, embedding: input.embedding }));
    else payload.push(...await repairIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal }));
  }
  if ((input.backend === "all" || input.backend === "serena") && input.operation === "repair") {
    payload.push(await repairSerena(input.root, input.indexTimeoutMs));
  }
  return {
    text: JSON.stringify(payload, null, 2),
    meta: { root: input.root, operation: input.operation, backend: input.backend },
  };
}

async function normalizeInput(raw) {
  if (!raw || typeof raw !== "object") throw new Error("arguments must be an object");
  const operation = raw.operation ?? "auto";
  if (!OPERATIONS.includes(operation)) throw new Error(`unsupported operation: ${operation}`);
  const queryRequired = !CONTROL_OPERATIONS.has(operation);
  const query = raw.query == null ? "" : stringValue(raw.query, "query", 4096, !queryRequired);
  if (queryRequired && !query.trim() && !raw.symbol) throw new Error("query or symbol is required");
  const root = path.resolve(raw.root ? stringValue(raw.root, "root", 4096) : process.cwd());
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`root is not a directory: ${root}`);
  const freshness = raw.freshness ?? "auto";
  if (!["fast", "auto", "strict"].includes(freshness)) throw new Error(`unsupported freshness: ${freshness}`);
  const backend = raw.backend ?? "all";
  if (!["all", "zvec", "codegraph", "serena"].includes(backend)) throw new Error(`unsupported backend: ${backend}`);
  return {
    query,
    root,
    operation,
    backend,
    embedding: optionalString(raw.embedding, "embedding", 512),
    symbol: optionalString(raw.symbol, "symbol", 1024),
    relativePath: optionalString(raw.relativePath, "relativePath", 4096),
    includeBody: Boolean(raw.includeBody),
    substringMatching: raw.substringMatching == null ? undefined : Boolean(raw.substringMatching),
    limit: clampInt(raw.limit, 1, 100, 20),
    depth: clampInt(raw.depth, 0, 10, 2),
    maxChars: clampInt(raw.maxChars, 4_000, 80_000, 24_000),
    timeoutMs: clampInt(raw.timeoutMs, 1_000, 120_000, envInt("LAZY_INTEL_TIMEOUT_MS", 30_000, 1_000, 120_000)),
    indexTimeoutMs: clampInt(raw.indexTimeoutMs, 5_000, 1_800_000, envInt("LAZY_INTEL_INDEX_TIMEOUT_MS", 120_000, 5_000, 1_800_000)),
    freshness,
  };
}

function stringValue(value, name, max, allowEmpty = false) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const out = value.trim();
  if (!allowEmpty && !out) throw new Error(`${name} must not be empty`);
  if (out.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return out;
}
function optionalString(value, name, max) { return value == null ? undefined : stringValue(value, name, max); }
function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function clampInt(value, min, max, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`integer must be ${min}..${max}`);
  return n;
}
