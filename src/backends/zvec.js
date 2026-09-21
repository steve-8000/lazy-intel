import { resolveBin, run } from "../lib/process.js";
import { ensureIndexes } from "../index-manager.js";
import { envelope, failureEnvelope } from "../contracts.js";
import { errorCodeFor } from "../lib/deadline.js";
import * as Evidence from "../evidence.js";

const MODE = process.env.LAZY_INTEL_ZVEC_MODE ?? "auto";
// Daemon-side refresh keeps the indexed hybrid runtime warm; query never owns a second index pass.
const REFRESH = { strict: "wait", auto: "background", fast: "off" };

function timing(start, prepare, execute) { const now = performance.now(); return { prepareMs: Math.max(0, Math.round(prepare - start)), queueMs: 0, executeMs: Math.max(0, Math.round(now - execute)), totalMs: Math.max(0, Math.round(now - start)) }; }
function opaque(text, operation, reason = "documented_text_format") { const provenance = { backend: "zvec", operation, backendVersion: "0.2.1", adapterVersion: "0.3.0", executionId: `zvec-${Date.now()}-${Math.random().toString(36).slice(2)}` }; const value = { id: `${provenance.executionId}-opaque`, method: "opaque", text, reason, provenance }; return typeof Evidence.makeOpaque === "function" ? Evidence.makeOpaque(value) : value; }

/** Parse the pinned zvec text contract without promoting path-looking prose to locators. */
export function parseZvecResponse(stdout, { operation = "search", truncated = false } = {}) {
  if (typeof stdout !== "string" || stdout.length === 0 || !stdout.trim()) return { ok: false, code: "MALFORMED_RESPONSE", message: "zvec returned blank stdout" };
  if (/^No matches\.\s*$/i.test(stdout)) return { ok: true, outcome: "empty", items: [], opaque: [], returned: 0, total: 0, truncated: false, coverage: "backend_complete" };
  return { ok: true, outcome: "ok", items: [], opaque: [opaque(stdout, operation)], returned: 1, total: null, truncated, coverage: "bounded" };
}
export const parseZvec = parseZvecResponse;
function indexFailure(row, operation, start, prepare) { const code = row?.building ? "INDEX_BUILDING" : "INDEX_UNAVAILABLE"; return failureEnvelope("zvec", operation, code, row?.detail ?? row?.error ?? "zvec index unavailable", { timing: timing(start, prepare, prepare) }); }
function classify(error) { if (/unknown command|unknown option|unsupported/i.test(error?.message ?? "")) return "UNSUPPORTED_CAPABILITY"; return errorCodeFor(error, null); }

export async function zvecSearch(input, signal) {
  const operation = input.operation ?? "search"; const started = performance.now(); let preparedAt = started;
  try {
    signal?.throwIfAborted(); const [ready] = await ensureIndexes(input.root, ["zvec"], { freshness: input.freshness, timeoutMs: input.indexTimeoutMs, signal }); preparedAt = performance.now(); signal?.throwIfAborted();
    if (ready?.building || ready?.ready !== true) return indexFailure(ready, operation, started, preparedAt);
    const args = ["query", input.query, "--mode", MODE, "--refresh", REFRESH[input.freshness] ?? "background", "--limit", String(input.limit), "--preview", input.includeBody ? "full" : "short"];
    const zg = await resolveBin("zg"); const executeAt = performance.now(); const result = await run(zg, args, { cwd: input.root, timeoutMs: input.timeoutMs, signal }); signal?.throwIfAborted();
    if (result?.overflow) return failureEnvelope("zvec", operation, "OUTPUT_LIMIT", "zvec output exceeded the configured limit", { outcome: "partial", truncated: true, timing: timing(started, preparedAt, executeAt) });
    const parsed = parseZvecResponse(result?.stdout, { operation, truncated: false }); if (!parsed.ok) return failureEnvelope("zvec", operation, parsed.code, parsed.message, { timing: timing(started, preparedAt, executeAt) });
    return envelope({ backend: "zvec", operation, ...parsed, timing: timing(started, preparedAt, executeAt), raw: { text: result.stdout } });
  } catch (error) { signal?.throwIfAborted(); const code = classify(error); return failureEnvelope("zvec", operation, code, error?.message ?? String(error), { outcome: code === "OUTPUT_LIMIT" ? "partial" : undefined, truncated: code === "OUTPUT_LIMIT", timing: timing(started, preparedAt, preparedAt) }); }
}
