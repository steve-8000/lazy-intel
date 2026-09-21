import { buildContextPack } from "./context-pack.js";
import { makeOpaque } from "./evidence.js";
import { ADAPTER_VERSION } from "./contracts.js";

/**
 * Compatibility facade for the pre-0.3 `{backend, ok, text}` rows.
 *
 * Rendering now belongs to `src/context-pack.js`, which enforces the whole-response
 * character budget instead of the old per-section budget that let a 4,000-character cap
 * emit 4,319 characters. This wrapper preserves the previous call signature by presenting
 * legacy rows as what they always were: opaque backend text that makes no typed claim.
 */

// Live LSP semantics outrank an indexed graph, which outranks retrieval relevance. This is
// a presentation order, not a correctness proof.
const TRUTH_ORDER = { serena: 0, codegraph: 1, zvec: 2 };

export function fuse(results, options = {}) {
  const maxChars = options.maxChars ?? 24_000;
  const rows = [...results]
    .filter((row) => row.ok && row.text)
    .sort((a, b) => (TRUTH_ORDER[a.backend] ?? 9) - (TRUTH_ORDER[b.backend] ?? 9));

  const opaque = rows.map((row, index) => makeOpaque({
    id: `legacy-${row.backend}-${index}`,
    text: row.text,
    reason: "documented_text_format",
    provenance: {
      backend: row.backend,
      operation: "legacy",
      backendVersion: "unknown",
      adapterVersion: ADAPTER_VERSION,
      executionId: `legacy-${index}`,
    },
  }));

  const envelopes = results.map((row) => ({
    backend: row.backend,
    operation: "legacy",
    outcome: row.ok ? "ok" : "unavailable",
    items: [],
    opaque: [],
    coverage: "unknown",
    returned: row.ok ? 1 : 0,
    total: null,
    truncated: false,
    ...(row.ok ? {} : { error: { code: "INDEX_UNAVAILABLE", retryable: true, message: row.warning ?? "unavailable" } }),
    timing: { prepareMs: 0, queueMs: 0, executeMs: row.latencyMs ?? 0, totalMs: row.latencyMs ?? 0 },
  }));

  const pack = buildContextPack({
    input: { operation: "legacy" },
    envelopes,
    items: [],
    opaque,
    status: rows.length ? "ok" : "error",
    fulfillment: { requiredMet: rows.length > 0, unmet: rows.length ? [] : ["legacy_evidence"] },
    stopReason: rows.length ? "plan_complete" : "required_backend_failed",
    maxChars,
  });
  return `${pack.text}\n\n${pack.metaText}`;
}
