import { realpath } from "node:fs/promises";
import path from "node:path";
import { containsPath, requestRoot } from "./lib/roots.js";
import {
  CONTROL_OPERATIONS,
  OPERATIONS,
  SCHEMA_VERSION,
  assertEnum,
  legacyBackendMeta,
  optionalBoolean,
} from "./contracts.js";
import { createPlan, routesOf } from "./plan.js";
import { buildContextPack } from "./context-pack.js";
import { dedupe, makeEvidence } from "./evidence.js";
import { createSourceVerifier, observationSpan } from "./lib/source.js";
import {
  RequestCancelledError,
  createDeadline,
  defaultRequestTimeoutMs,
  classifyAbort,
} from "./lib/deadline.js";
import {
  indexStatus,
  isDeniedRoot,
  observeIndexState,
  repairIndexes,
  reindexIndexes,
  syncIndexes,
} from "./index-manager.js";
import { log } from "./lib/log.js";
import { unifiedRead, unifiedStage, unifiedSemanticStatus, repairUnifiedSemantic } from "./unified.js";

const SUCCESSFUL_OUTCOMES = new Set(["ok", "empty"]);

export async function codeIntel(rawInput, signal) {
  signal?.throwIfAborted();
  const input = await normalizeInput(rawInput);
  signal?.throwIfAborted();
  if (CONTROL_OPERATIONS.has(input.operation)) return control(input, signal);

  // One monotonic budget owns the whole request: queue waiting, index preparation, the
  // single transport retry and source verification all draw from it.
  const deadline = createDeadline({ signal, requestTimeoutMs: input.requestTimeoutMs });
  try {
    return await intelligence(input, deadline);
  } finally {
    deadline.dispose();
  }
}

async function intelligence(input, deadline) {
  const plan = createPlan(input);
  const routes = routesOf(plan);
  log("info", "code_intel plan", { operation: input.operation, mode: plan.mode, routes, root: input.root });

  const before = observeIndexState(input.root);
  const envelopes = [];
  /** @type {"ambiguous_subject" | "subject_unresolved" | null} */
  let gate = null;
  let budgetExhausted = false;

  for (const stage of plan.stages) {
    let reads = stage.reads;
    if (stage.when === "validated_unique_subject") {
      const subject = uniqueSubject(envelopes, input);
      if (!subject.ok) {
        gate = subject.reason;
        break;
      }
      reads = reads.map((read) => ({ ...read, subject: subject.value }));
    }
    if (!deadline.affords(1)) {
      budgetExhausted = true;
      break;
    }
    // allSettled, not all: a thrown preparation error in one read must never discard a
    // sibling backend's valid result.
    const settled = await unifiedStage(reads, input, deadline, (read, lease) => executeRead(read, input, deadline, lease));
    for (const [index, entry] of settled.entries()) {
      if (entry.status === "fulfilled") {
        envelopes.push({ read: reads[index], envelope: entry.value });
        continue;
      }
      const error = entry.reason;
      if (classifyAbort(error, deadline) === "CANCELLED") throw error;
      if (classifyAbort(error, deadline) === "TIMEOUT") budgetExhausted = true;
      envelopes.push({ read: reads[index], envelope: localFailure(reads[index], error, deadline) });
    }
    if (budgetExhausted) break;
  }

  if (deadline.stopKind === "cancelled") throw new RequestCancelledError();
  if (deadline.stopKind === "timeout" || deadline.expired()) budgetExhausted = true;

  const after = observeIndexState(input.root);
  const observation = observationSpan(before, after);

  const opaque = envelopes.flatMap(({ envelope }) => envelope.opaque ?? []);
  const rawItems = envelopes.flatMap(({ envelope }) => envelope.items ?? []);
  const items = dedupe(await verifyItems(rawItems, input, observation, deadline));

  const fulfillment = judgeFulfillment(plan, envelopes);
  const status = judgeStatus({ fulfillment, envelopes, items, opaque, budgetExhausted });
  const stopReason = judgeStopReason({ fulfillment, gate, budgetExhausted, observation, items, opaque, envelopes });

  const pack = buildContextPack({
    input,
    envelopes: envelopes.map(({ envelope }) => envelope),
    items,
    opaque,
    status,
    fulfillment,
    stopReason,
    maxChars: input.maxChars,
  });

  return {
    text: pack.text,
    metaText: pack.metaText,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      root: input.root,
      operation: input.operation,
      routes,
      freshness: input.freshness,
      backends: envelopes.map(({ envelope }) => legacyBackendMeta(envelope)),
      status: pack.status,
      fulfillment: pack.fulfillment,
      stopReason: pack.stopReason,
      coverage: pack.coverage,
      normalization: pack.normalization,
      evidence: pack.evidence,
      truncated: pack.truncated,
      omittedItems: pack.omittedItems,
      observation: observation.consistency,
      views: pack.views,
      semanticObservations: pack.semanticObservations,
      issues: pack.issues,
      metadataOmitted: pack.metadataOmitted,
    },
    isError: pack.isError,
  };
}

/** One read of one backend, bounded by whatever is left of the request budget. */
function executeRead(read, input, deadline, lease) {
  const timeoutMs = deadline.budget(input.timeoutMs);
  const indexTimeoutMs = deadline.budget(input.indexTimeoutMs);
  const subject = read.subject;
  const scoped = {
    ...input,
    operation: read.operation,
    timeoutMs,
    indexTimeoutMs,
    ...(subject ? { symbol: subject.symbol, relativePath: subject.relativePath } : {}),
  };
  return unifiedRead(read, scoped, deadline, lease);
}

function localFailure(read, error, deadline) {
  const code = classifyAbort(error, deadline) ?? (error?.code === "source_changed" ? "SOURCE_MISMATCH" : ["needs_recovery", "mixed-views", "unavailable", "applying"].includes(error?.code) ? "INDEX_UNAVAILABLE" : "INTERNAL_ERROR");
  return {
    backend: read.backend,
    operation: read.operation,
    outcome: "error",
    items: [],
    opaque: [],
    coverage: "unknown",
    returned: null,
    total: null,
    truncated: false,
    error: { code, retryable: code === "TIMEOUT", message: error?.message ?? String(error) },
    timing: { prepareMs: 0, queueMs: 0, executeMs: 0, totalMs: 0 },
  };
}

/**
 * A dependent stage runs only when the previous stage produced exactly one typed subject
 * whose path is inside the root. A best-scoring guess is not a resolved subject.
 */
function uniqueSubject(envelopes, input) {
  const candidates = [];
  for (const { envelope } of envelopes) {
    for (const item of envelope.items ?? []) {
      if (item.method === "opaque" || !item.locator?.relativePath) continue;
      if (!["definition", "implementation"].includes(item.kind)) continue;
      candidates.push(item);
    }
  }
  const distinct = new Map();
  for (const item of candidates) {
    const name = item.subject?.qualifiedName ?? input.symbol;
    distinct.set(`${item.locator.relativePath}\0${name ?? ""}`, {
      relativePath: item.locator.relativePath,
      symbol: name ?? input.symbol,
    });
  }
  if (distinct.size === 1) return { ok: true, value: [...distinct.values()][0] };
  if (distinct.size === 0) return { ok: false, reason: "subject_unresolved" };
  return { ok: false, reason: "ambiguous_subject" };
}

/**
 * Re-stamp evidence with the request's observation window and a bounded source check.
 * Budget-skipped files stay `unchecked`; nothing is upgraded to verified without a read.
 */
async function verifyItems(items, input, observation, deadline) {
  if (!items.length) return items;
  const verifier = createSourceVerifier(input.root);
  const verified = [];
  for (const item of items) {
    let sourceCheck = { status: "unchecked", reason: "source verification budget not spent" };
    if (deadline.affords(1)) {
      try {
        sourceCheck = await verifier.verify(item.locator, item.text, item.anchor?.contentHash, item.anchor?.span, item.textKind);
      } catch (error) {
        sourceCheck = { status: "unchecked", reason: `verification failed: ${error.message}` };
      }
    } else {
      sourceCheck = { status: "unchecked", reason: "request deadline exhausted" };
    }
    verified.push(makeEvidence({ ...item, sourceCheck, observation }));
  }
  return verified;
}

/** An obligation is met when at least one read carrying it returned a usable outcome. */
function judgeFulfillment(plan, envelopes) {
  const met = new Set();
  for (const { read, envelope } of envelopes) {
    if (SUCCESSFUL_OUTCOMES.has(envelope.outcome)) met.add(read.obligation);
  }
  const unmet = plan.requiredObligations.filter((obligation) => !met.has(obligation));
  return { requiredMet: unmet.length === 0, unmet };
}

function judgeStatus({ fulfillment, envelopes, items, opaque, budgetExhausted }) {
  const evidence = items.length + opaque.length;
  if (!fulfillment.requiredMet) return evidence > 0 ? "partial" : "error";
  if (budgetExhausted) return "partial";
  const outcomes = envelopes.map(({ envelope }) => envelope.outcome);
  if (outcomes.length && outcomes.every((outcome) => outcome === "empty")) return "empty";
  if (outcomes.some((outcome) => !SUCCESSFUL_OUTCOMES.has(outcome))) return "partial";
  if (envelopes.some(({ envelope }) => envelope.truncated)) return "partial";
  return evidence > 0 ? "ok" : "empty";
}

function judgeStopReason({ fulfillment, gate, budgetExhausted, observation, items, opaque, envelopes }) {
  if (budgetExhausted) return "budget_exhausted";
  if (gate) return gate;
  if (!fulfillment.requiredMet) return "required_backend_failed";
  if (observation.consistency === "concurrent_change_observed") return "concurrent_change_observed";
  if (items.length + opaque.length === 0 && envelopes.length) return "no_matches";
  return "plan_complete";
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
    if (input.backend === "all" || input.backend === "serena") payload.serena = await unifiedSemanticStatus(input.root);
    return controlResult(input, payload, true);
  }

  const payload = [];
  if (indexTargets.length) {
    if (input.operation === "sync") payload.push(...await syncIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal }));
    else if (input.operation === "reindex") payload.push(...await reindexIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal, embedding: input.embedding }));
    else payload.push(...await repairIndexes(input.root, indexTargets, { timeoutMs: input.indexTimeoutMs, signal }));
  }
  if ((input.backend === "all" || input.backend === "serena") && input.operation === "repair") {
    const repaired = await repairUnifiedSemantic(input.root);
    payload.push(serenaControlRow(repaired));
  }
  // A build still in flight is not a completed effect and is never journalled as one.
  const ok = payload.length > 0 && payload.every((entry) => entry.ok === true && entry.building !== true);
  return controlResult(input, payload, ok);
}

function serenaControlRow(result) {
  if (result && typeof result === "object" && "outcome" in result) {
    return {
      backend: "serena",
      ok: SUCCESSFUL_OUTCOMES.has(result.outcome),
      action: "repair",
      building: false,
      ...(result.error ? { error: result.error.message } : {}),
    };
  }
  return result;
}

/**
 * Control output is JSON. The response cap applies, but the JSON is never cut mid-document:
 * an oversized payload is replaced by a valid summarizing document that says so.
 */
function controlResult(input, payload, ok) {
  const full = JSON.stringify(payload, null, 2);
  const text = full.length <= input.maxChars ? full : JSON.stringify({
    summarized: true,
    reason: `control payload of ${full.length} characters exceeds maxChars=${input.maxChars}`,
    entries: Array.isArray(payload) ? payload.length : Object.keys(payload).length,
    backends: Array.isArray(payload)
      ? payload.map(({ backend, ok: entryOk, action, building }) => ({ backend, ok: entryOk, action, building }))
      : Object.keys(payload),
  }, null, 2);
  return {
    text,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      root: input.root,
      operation: input.operation,
      backend: input.backend,
      ok,
      status: ok ? "ok" : "error",
      truncated: text !== full,
      backends: Array.isArray(payload)
        ? payload.map(({ backend, ok: entryOk, error, building }) => ({ backend, ok: entryOk, warning: error, building }))
        : [],
    },
    isError: !ok,
  };
}

async function normalizeInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const operation = assertEnum(raw.operation ?? "auto", OPERATIONS, "operation");
  const queryRequired = !CONTROL_OPERATIONS.has(operation);
  const query = raw.query == null ? "" : stringValue(raw.query, "query", 4096, !queryRequired);
  const symbol = optionalString(raw.symbol, "symbol", 1024);
  const relativePath = optionalString(raw.relativePath, "relativePath", 4096);
  if (operation === "impact" && !symbol) throw new Error("impact requires symbol");
  if (["references", "implementations"].includes(operation) && (!symbol || !relativePath)) {
    throw new Error(`${operation} requires symbol and relativePath`);
  }
  // Diagnostics are addressed by file. Demanding a query or symbol here is what pushed
  // diagnostic questions into semantic search.
  if (operation === "diagnostics" && !relativePath) throw new Error("diagnostics requires relativePath");
  if (queryRequired && operation !== "diagnostics" && !query.trim() && !symbol) {
    throw new Error("query or symbol is required");
  }
  const root = await requestRoot(raw.root == null ? undefined : stringValue(raw.root, "root", 4096));
  if (isDeniedRoot(root)) throw new Error(`root is agent private state, not a source workspace: ${root}`);
  if (relativePath) {
    const target = path.resolve(root, relativePath);
    if (path.isAbsolute(relativePath) || !containsPath(root, target) || !containsPath(root, await realpath(target))) {
      throw new Error("relativePath must remain inside the requested workspace");
    }
  }
  const freshness = assertEnum(raw.freshness ?? "auto", ["fast", "auto", "strict"], "freshness");
  const backend = assertEnum(raw.backend ?? "all", ["all", "zvec", "codegraph", "serena"], "backend");
  const timeoutMs = clampInt(raw.timeoutMs, 1_000, 120_000, envInt("LAZY_INTEL_TIMEOUT_MS", 30_000, 1_000, 120_000));
  const indexTimeoutMs = clampInt(raw.indexTimeoutMs, 5_000, 1_800_000, envInt("LAZY_INTEL_INDEX_TIMEOUT_MS", 120_000, 5_000, 1_800_000));
  return {
    query,
    root,
    operation,
    backend,
    embedding: optionalString(raw.embedding, "embedding", 512),
    symbol,
    relativePath,
    includeBody: raw.includeBody == null ? false : optionalBoolean(raw.includeBody, "includeBody"),
    substringMatching: optionalBoolean(raw.substringMatching, "substringMatching"),
    limit: clampInt(raw.limit, 1, 100, 20),
    depth: clampInt(raw.depth, 0, 10, 2),
    maxChars: clampInt(raw.maxChars, 4_000, 80_000, 24_000),
    timeoutMs,
    indexTimeoutMs,
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, 1_000, 3_600_000, defaultRequestTimeoutMs({ indexTimeoutMs, timeoutMs })),
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
