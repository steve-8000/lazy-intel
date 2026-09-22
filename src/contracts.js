/**
 * Shared vocabulary for the v0.3 execution contract.
 *
 * Every module that produces a result — backend adapter, planner, renderer, MCP server —
 * agrees here on the enums, the error taxonomy and the BackendEnvelope shape. Keeping the
 * discriminants in one place is what stops "ok: false" from meaning five different things
 * in five different files.
 */

export const SCHEMA_VERSION = "lazy-intel.result/1";
export const ADAPTER_VERSION = "0.3.0";

export const CONTROL_OPERATIONS = new Set(["status", "sync", "reindex", "repair"]);
export const PRIMITIVE_OPERATIONS = new Set([
  "search", "architecture", "impact", "symbol", "references", "implementations", "diagnostics",
]);
export const COMPOSITE_OPERATIONS = new Set(["auto", "context"]);
export const OPERATIONS = [
  "auto", "context", "search", "architecture", "symbol", "references",
  "implementations", "diagnostics", "impact", "status", "sync", "reindex", "repair",
];

export const BACKENDS = ["zvec", "codegraph", "serena"];
export const BACKEND_TARGETS = ["all", ...BACKENDS];
export const FRESHNESS_MODES = ["fast", "auto", "strict"];

export const BACKEND_OUTCOMES = ["ok", "empty", "partial", "unavailable", "error"];
export const COVERAGES = ["bounded", "backend_complete", "unknown"];
export const REQUEST_STATUSES = ["ok", "empty", "partial", "error"];
export const NORMALIZATIONS = ["typed", "opaque", "mixed", "none"];

// A stop reason records why execution ended, never whether the answer is good enough.
// There is deliberately no "evidence_sufficient": that would be a model judgement.
export const STOP_REASONS = [
  "plan_complete", "no_matches", "ambiguous_subject", "subject_unresolved",
  "required_backend_failed", "budget_exhausted", "concurrent_change_observed",
];

export const EVIDENCE_KINDS = [
  "definition", "reference", "implementation", "diagnostic", "relation", "impact", "retrieval",
];
export const EVIDENCE_METHODS = ["lsp", "indexed_graph", "hybrid_retrieval"];
export const OPAQUE_REASONS = ["documented_text_format", "unsupported_shape", "parser_failed"];
export const SOURCE_CHECK_STATUSES = ["matched", "mismatch", "unchecked"];
export const OBSERVATION_CONSISTENCY = ["observed_stable", "concurrent_change_observed", "unverified"];

/**
 * Error taxonomy. `retryable` describes the transport, not the question: a timeout may
 * succeed on a second attempt, a missing Serena tool never will. The planner uses this to
 * decide whether its single retry budget is worth spending.
 */
export const ERROR_CODES = {
  INDEX_BUILDING: { retryable: true, outcome: "unavailable" },
  INDEX_UNAVAILABLE: { retryable: true, outcome: "unavailable" },
  UNSUPPORTED_CAPABILITY: { retryable: false, outcome: "unavailable" },
  UNSUPPORTED_VERSION: { retryable: false, outcome: "unavailable" },
  TOOL_ERROR: { retryable: false, outcome: "error" },
  TRANSPORT_CLOSED: { retryable: true, outcome: "error" },
  TIMEOUT: { retryable: true, outcome: "error" },
  OUTPUT_LIMIT: { retryable: false, outcome: "partial" },
  MALFORMED_RESPONSE: { retryable: false, outcome: "error" },
  UNRECOGNIZED_RESPONSE: { retryable: false, outcome: "partial" },
  BUSY: { retryable: true, outcome: "unavailable" },
  SOURCE_MISMATCH: { retryable: false, outcome: "partial" },
  CANCELLED: { retryable: false, outcome: "error" },
  INTERNAL_ERROR: { retryable: false, outcome: "error" },
};

export const BACKEND_ERROR_CODES = Object.keys(ERROR_CODES);

/** Typed local error carrying a taxonomy code through adapter internals. */
export class BackendError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = "BackendError";
    this.code = ERROR_CODES[code] ? code : "INTERNAL_ERROR";
    this.retryable = options.retryable ?? ERROR_CODES[this.code].retryable;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function backendError(code, message, options = {}) {
  const known = ERROR_CODES[code] ? code : "INTERNAL_ERROR";
  return {
    code: known,
    retryable: options.retryable ?? ERROR_CODES[known].retryable,
    message: String(message ?? known),
  };
}

/** Outcome implied by an error code, unless the adapter observed something more specific. */
export function outcomeForCode(code) {
  return ERROR_CODES[code]?.outcome ?? "error";
}

const ZERO_TIMING = { prepareMs: 0, queueMs: 0, executeMs: 0, totalMs: 0 };

/**
 * Normalize an adapter result into the single internal shape the engine consumes.
 *
 * `raw` stays attached for the lifetime of the request only: the renderer reads it, the
 * public metadata never does, and nothing writes it to disk.
 */
export function envelope(partial) {
  const backend = partial.backend;
  if (!BACKENDS.includes(backend)) throw new Error(`unknown backend: ${backend}`);
  const error = partial.error
    ? backendError(partial.error.code, partial.error.message, { retryable: partial.error.retryable })
    : undefined;
  const outcome = partial.outcome ?? (error ? outcomeForCode(error.code) : "ok");
  if (!BACKEND_OUTCOMES.includes(outcome)) throw new Error(`unknown backend outcome: ${outcome}`);
  const items = partial.items ?? [];
  const opaque = partial.opaque ?? [];
  const coverage = partial.coverage ?? (outcome === "ok" || outcome === "empty" ? "bounded" : "unknown");
  if (!COVERAGES.includes(coverage)) throw new Error(`unknown coverage: ${coverage}`);
  return {
    backend,
    operation: partial.operation,
    outcome,
    items,
    opaque,
    coverage,
    returned: partial.returned ?? (items.length + opaque.length || null),
    total: partial.total ?? null,
    truncated: Boolean(partial.truncated),
    ...(error ? { error } : {}),
    timing: { ...ZERO_TIMING, ...(partial.timing ?? {}) },
    ...(partial.views ? { views: partial.views } : {}),
    ...(partial.semanticObservations ? { semanticObservations: partial.semanticObservations } : {}),
    ...(partial.issues ? { issues: partial.issues } : {}),
    ...(partial.raw ? { raw: partial.raw } : {}),
  };
}

/** Adapter failure shorthand: one place decides outcome, retryability and message. */
export function failureEnvelope(backend, operation, code, message, extra = {}) {
  const error = backendError(code, message, extra.error);
  return envelope({
    backend,
    operation,
    outcome: extra.outcome ?? outcomeForCode(error.code),
    items: extra.items ?? [],
    opaque: extra.opaque ?? [],
    coverage: extra.coverage ?? "unknown",
    returned: extra.returned ?? null,
    total: extra.total ?? null,
    truncated: extra.truncated ?? false,
    error,
    timing: extra.timing,
    views: extra.views,
    semanticObservations: extra.semanticObservations,
    issues: extra.issues,
  });
}

/**
 * Legacy `meta.backends[]` rows. `ok` survives for existing consumers but is derived, never
 * the oracle: the engine decides fulfilment from `outcome`.
 */
export function legacyBackendMeta(env) {
  return {
    backend: env.backend,
    ok: env.outcome === "ok" || env.outcome === "empty",
    outcome: env.outcome,
    latencyMs: env.timing?.totalMs ?? 0,
    ...(env.error ? { warning: env.error.message } : {}),
  };
}

/** Strict boolean: the string "false" is an input error, not a truthy value. */
export function booleanValue(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function optionalBoolean(value, name) {
  return value == null ? undefined : booleanValue(value, name);
}

export function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`unsupported ${name}: ${value}`);
  return value;
}
