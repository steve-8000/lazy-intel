import { resolveBin, run } from "../lib/process.js";
import { ensureIndexes } from "../index-manager.js";
import { envelope, failureEnvelope } from "../contracts.js";
import { errorCodeFor } from "../lib/deadline.js";
import * as Evidence from "../evidence.js";

function timing(start, prepare, execute) { const now = performance.now(); return { prepareMs: Math.max(0, Math.round(prepare - start)), queueMs: 0, executeMs: Math.max(0, Math.round(now - execute)), totalMs: Math.max(0, Math.round(now - start)) }; }
function opaque(text, operation, reason = "documented_text_format") { const provenance = { backend: "codegraph", operation, backendVersion: "1.6.0", adapterVersion: "0.3.0", executionId: `codegraph-${Date.now()}-${Math.random().toString(36).slice(2)}` }; const value = { id: `${provenance.executionId}-opaque`, method: "opaque", text, reason, provenance }; return typeof Evidence.makeOpaque === "function" ? Evidence.makeOpaque(value) : value; }
function parseJson(text) { if (typeof text !== "string" || !text.trim()) return { ok: false, code: "MALFORMED_RESPONSE", message: "CodeGraph returned blank stdout" }; try { return { ok: true, value: JSON.parse(text) }; } catch (error) { return { ok: false, code: "MALFORMED_RESPONSE", message: `CodeGraph JSON parse failed: ${error.message}` }; } }
function impactShape(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return false; return typeof value.symbol === "string" && (Array.isArray(value.affected) || Array.isArray(value.affectedFiles) || Array.isArray(value.nodes) || Array.isArray(value.edges) || Array.isArray(value.impacts)); }
function impactItems(value, root, operation) {
  const rows = value.affected ?? value.affectedFiles ?? value.nodes ?? value.impacts;
  if (!Array.isArray(rows)) return [];
  const p = { backend: "codegraph", operation, backendVersion: "1.6.0", adapterVersion: "0.3.0", executionId: `codegraph-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  return rows.map((row, index) => {
    if (!row || typeof row.filePath !== "string" || !Number.isInteger(row.startLine) || row.startLine < 1) return null;
    const spec = { id: `${p.executionId}-${index}`, kind: "impact", method: "indexed_graph", locator: { rootKey: root, relativePath: row.filePath, range: { startLine: row.startLine - 1, endLineExclusive: row.startLine } }, subject: typeof row.name === "string" ? { qualifiedName: row.name, backendNamespace: "codegraph" } : undefined, text: typeof row.name === "string" ? row.name : JSON.stringify(row), sourceCheck: { status: "unchecked", reason: "not_requested" }, observation: { before: null, after: null, consistency: "unverified" }, provenance: [p] };
    return typeof Evidence.makeEvidence === "function" ? Evidence.makeEvidence(spec) : spec;
  }).filter(Boolean);
}

/** Validate only the pinned impact JSON shape; all other graph prose remains opaque. */
export function parseCodegraphResponse(stdout, { operation = "architecture", truncated = false, root = "/fixture" } = {}) {
  if (operation === "impact") {
    const parsed = parseJson(stdout); if (!parsed.ok) { if (/^\s*ℹ?\s*Symbol .*not found/i.test(stdout ?? "")) return { ok: true, outcome: "empty", items: [], opaque: [], returned: 0, total: 0, truncated: false, coverage: "backend_complete" }; return parsed; }
    if (!impactShape(parsed.value)) return { ok: true, outcome: "ok", items: [], opaque: [opaque(String(stdout), operation, "unsupported_shape")], returned: 1, total: null, truncated, coverage: "unknown" };
    const items = impactItems(parsed.value, root, operation);
    return { ok: true, outcome: "ok", items, opaque: [], returned: items.length, total: parsed.value.nodeCount ?? items.length, truncated, coverage: "bounded", structured: parsed.value };
  }
  if (typeof stdout !== "string" || stdout.length === 0 || !stdout.trim()) return { ok: false, code: "MALFORMED_RESPONSE", message: "CodeGraph returned blank stdout" };
  if (/^No relevant code found for /i.test(stdout.trim())) return { ok: true, outcome: "empty", items: [], opaque: [], returned: 0, total: 0, truncated: false, coverage: "backend_complete" };
  const limited = /Not shown above|truncated|output limit/i.test(stdout);
  return { ok: true, outcome: "ok", items: [], opaque: [opaque(stdout, operation)], returned: 1, total: null, truncated: truncated || limited, coverage: "bounded" };
}
export const parseCodegraph = parseCodegraphResponse;
function indexFailure(row, operation, start, prepare) { const code = row?.building ? "INDEX_BUILDING" : "INDEX_UNAVAILABLE"; return failureEnvelope("codegraph", operation, code, row?.detail ?? row?.error ?? "CodeGraph index unavailable", { timing: timing(start, prepare, prepare) }); }
function classify(error) { if (/unknown command|unknown option|unsupported/i.test(error?.message ?? "")) return "UNSUPPORTED_CAPABILITY"; return errorCodeFor(error, null); }

export async function codegraphQuery(kind, input, signal) {
  const operation = kind ?? input.operation ?? "architecture"; const started = performance.now(); let preparedAt = started;
  try {
    signal?.throwIfAborted(); if (operation === "impact" && !input.symbol?.trim()) return failureEnvelope("codegraph", operation, "UNRECOGNIZED_RESPONSE", "impact requires symbol", { timing: timing(started, preparedAt, preparedAt) });
    const [ready] = await ensureIndexes(input.root, ["codegraph"], { freshness: input.freshness, timeoutMs: input.indexTimeoutMs, signal }); preparedAt = performance.now(); signal?.throwIfAborted();
    if (ready?.building || ready?.ready !== true) return indexFailure(ready, operation, started, preparedAt);
    const args = operation === "impact" ? ["impact", input.symbol, "--path", input.root, "--depth", String(input.depth ?? 2), "--json"] : ["explore", input.query, "--path", input.root, "--max-files", String(Math.max(1, Math.min(input.limit, 12)))];
    const bin = await resolveBin("codegraph"); const executeAt = performance.now(); const result = await run(bin, args, { cwd: input.root, timeoutMs: input.timeoutMs, signal, env: { DO_NOT_TRACK: "1" } }); signal?.throwIfAborted();
    if (result?.overflow) return failureEnvelope("codegraph", operation, "OUTPUT_LIMIT", "CodeGraph output exceeded the configured limit", { outcome: "partial", truncated: true, timing: timing(started, preparedAt, executeAt) });
    const parsed = parseCodegraphResponse(result?.stdout, { operation, truncated: false, root: input.root }); if (!parsed.ok) return failureEnvelope("codegraph", operation, parsed.code, parsed.message, { timing: timing(started, preparedAt, executeAt) });
    return envelope({ backend: "codegraph", operation, ...parsed, timing: timing(started, preparedAt, executeAt), raw: { ...(parsed.structured ? { structured: parsed.structured } : {}), text: result.stdout } });
  } catch (error) { signal?.throwIfAborted(); const code = classify(error); return failureEnvelope("codegraph", operation, code, error?.message ?? String(error), { outcome: code === "OUTPUT_LIMIT" ? "partial" : undefined, truncated: code === "OUTPUT_LIMIT", timing: timing(started, preparedAt, preparedAt) }); }
}
