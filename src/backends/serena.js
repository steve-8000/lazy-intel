import { StdioMcpClient } from "../mcp/client.js";
import { resolveBin } from "../lib/process.js";
import { log } from "../lib/log.js";
import { envelope, failureEnvelope } from "../contracts.js";
import { errorCodeFor } from "../lib/deadline.js";
import * as Evidence from "../evidence.js";

const ALLOWED_TOOLS = new Set(["find_symbol", "find_referencing_symbols", "find_implementations", "get_symbols_overview", "get_diagnostics_for_file"]);
const KNOWN_RESULT_KEYS = new Set(["results", "symbols", "references", "implementations", "diagnostics", "matches", "locations"]);

function timing(start, prepare, execute) {
  const now = performance.now();
  return { prepareMs: Math.max(0, Math.round(prepare - start)), queueMs: 0,
    executeMs: Math.max(0, Math.round(now - execute)), totalMs: Math.max(0, Math.round(now - start)) };
}
function textBlocks(result) {
  return Array.isArray(result?.content) ? result.content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n") : "";
}
function provenance(operation) {
  return { backend: "serena", operation, backendVersion: "1.7.0", adapterVersion: "0.3.0", executionId: `serena-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}
function opaque(text, operation, reason = "unsupported_shape") {
  const p = provenance(operation);
  const value = { id: `${p.executionId}-opaque`, method: "opaque", text, reason, provenance: p };
  return typeof Evidence.makeOpaque === "function" ? Evidence.makeOpaque(value) : value;
}

function structuredRows(value) {
  if (typeof value === "string") { try { return structuredRows(JSON.parse(value)); } catch { return null; } }
  if (Array.isArray(value)) return { key: "results", rows: value };
  if (!value || typeof value !== "object") return null;
  if (typeof value.result === "string") { try { return structuredRows(JSON.parse(value.result)); } catch { return null; } }
  for (const key of KNOWN_RESULT_KEYS) if (Array.isArray(value[key])) return { key, rows: value[key] };
  return null;
}
function rowItem(row, operation, root) {
  if (!row || typeof row !== "object") return null;
  const relativePath = row.relative_path ?? row.relativePath ?? row.path;
  const location = row.body_location ?? row.location ?? row.range;
  const startLine = row.start_line ?? row.startLine ?? row.line ?? location?.start_line ?? location?.startLine;
  const endLine = row.end_line ?? row.endLine ?? location?.end_line ?? location?.endLine ?? (Number.isInteger(startLine) ? startLine + 1 : undefined);
  if (typeof relativePath !== "string" || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  const endExclusive = endLine <= startLine ? startLine + 1 : endLine;
  const p = provenance(operation);
  const value = {
    id: `${p.executionId}-${relativePath}-${startLine}`,
    kind: operation === "diagnostics" ? "diagnostic" : operation === "references" ? "reference" : operation === "implementations" ? "implementation" : "definition",
    method: "lsp", locator: { rootKey: root ?? "", relativePath, range: { startLine, endLineExclusive: endExclusive } },
    ...(typeof row.name_path === "string" || typeof row.name === "string" ? { subject: { qualifiedName: row.name_path ?? row.name, backendNamespace: "serena" } } : {}),
    text: typeof row.text === "string" ? row.text : JSON.stringify(row),
    sourceCheck: { status: "unchecked", reason: "not_requested" },
    observation: { before: null, after: null, consistency: "unverified" }, provenance: [p],
  };
  return typeof Evidence.makeEvidence === "function" ? Evidence.makeEvidence(value) : value;
}

/** Parse only known Serena structured data or this pin's JSON text body. */
export function parseSerenaResponse(result, { operation = "symbol", root = "" } = {}) {
  if (result?.isError) return { ok: false, code: "TOOL_ERROR", message: textBlocks(result) || `${operation} tool failed` };
  const structured = result?.structuredContent;
  const structuredShape = structuredRows(structured);
  if (structuredShape) {
    const items = structuredShape.rows.map((row) => rowItem(row, operation, root)).filter(Boolean);
    if (structuredShape.rows.length === 0) return { ok: true, outcome: "empty", items: [], opaque: [], returned: 0, total: 0, truncated: false, coverage: "backend_complete", structured };
    if (items.length) return { ok: true, outcome: "ok", items, opaque: [], returned: items.length, total: structuredShape.rows.length, truncated: false, coverage: "backend_complete", structured };
    return { ok: true, outcome: "ok", items: [], opaque: [opaque(JSON.stringify(structured), operation, "unsupported_shape")], returned: 1, total: null, truncated: false, coverage: "unknown", structured };
  }
  const text = textBlocks(result);
  if (/answer is too long|output limit|truncated/i.test(text)) return { ok: false, code: "OUTPUT_LIMIT", message: text, truncated: true };
  if (!text.trim()) return { ok: false, code: "UNRECOGNIZED_RESPONSE", message: "Serena returned no recognized result body" };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) {
    if (/^[\[{]/.test(text.trim())) return { ok: false, code: "MALFORMED_RESPONSE", message: `Serena JSON parse failed: ${error.message}` };
    return { ok: true, outcome: "ok", items: [], opaque: [opaque(text, operation)], returned: 1, total: null, truncated: false, coverage: "bounded" };
  }
  const shape = structuredRows(parsed);
  if (!shape) return { ok: true, outcome: "ok", items: [], opaque: [opaque(text, operation, "unsupported_shape")], returned: 1, total: null, truncated: false, coverage: "unknown", structured: parsed };
  const items = shape.rows.map((row) => rowItem(row, operation, root)).filter(Boolean);
  if (shape.rows.length === 0) return { ok: true, outcome: "empty", items: [], opaque: [], returned: 0, total: 0, truncated: false, coverage: "backend_complete", structured: parsed };
  if (!items.length) return { ok: true, outcome: "ok", items: [], opaque: [opaque(text, operation, "unsupported_shape")], returned: 1, total: null, truncated: false, coverage: "unknown", structured: parsed };
  return { ok: true, outcome: "ok", items, opaque: [], returned: items.length, total: shape.rows.length, truncated: false, coverage: "backend_complete", structured: parsed };
}
export const parseSerena = parseSerenaResponse;

class SerenaPool {
  constructor() {
    this.clients = new Map(); this.generations = new Map();
    const max = Number(process.env.LAZY_INTEL_SERENA_MAX_CLIENTS ?? 2);
    this.maxClients = Number.isInteger(max) && max > 0 ? Math.min(max, 8) : 2;
  }
  async get(root, timeoutMs, signal) {
    signal?.throwIfAborted();
    let record = this.clients.get(root);
    if (record?.client?.closed) { this.invalidate(root, record.generation); record = null; }
    if (!record) {
      this.#evictIfNeeded();
      const generation = (this.generations.get(root) ?? 0) + 1; this.generations.set(root, generation);
      record = { generation, client: null, tools: new Map(), capabilities: null, lastUsed: Date.now(), waiters: 0, disposed: false, ready: false, reconnecting: null };
      this.clients.set(root, record);
      record.opening = this.#open(root, timeoutMs, record).catch((error) => { this.invalidate(root, record.generation); throw error; });
    }
    record.lastUsed = Date.now(); record.waiters++;
    try { await waitForOpen(record.opening, signal); signal?.throwIfAborted(); return record; }
    finally { record.waiters--; if (!record.ready && record.waiters === 0) this.invalidate(root, record.generation); }
  }
  async #open(root, timeoutMs, record) {
    const serena = await resolveBin("serena");
    if (record.disposed) throw new Error("Serena startup cancelled");
    const context = process.env.LAZY_INTEL_SERENA_CONTEXT ?? "agent";
    const client = new StdioMcpClient(serena, ["start-mcp-server", "--transport", "stdio", "--context", context, "--project", root, "--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"], { cwd: root, name: `serena:${root}`, timeoutMs, env: { SERENA_USAGE_REPORTING: "false", DO_NOT_TRACK: "1" } });
    record.client = client;
    try { await client.start(); record.capabilities = await client.listTools(); }
    catch (error) { client.close(); throw error; }
    for (const tool of record.capabilities?.tools ?? []) if (tool?.name) record.tools.set(tool.name, tool);
    record.ready = true;
    return record;
  }
  invalidate(root, expectedGeneration) {
    const existing = this.clients.get(root);
    if (!existing || (expectedGeneration != null && existing.generation !== expectedGeneration)) return false;
    existing.disposed = true; existing.client?.close(); this.clients.delete(root); return true;
  }
  async reconnect(root, record, timeoutMs, signal) {
    if (record.reconnecting) return record.reconnecting;
    record.reconnecting = (async () => { this.invalidate(root, record.generation); return this.get(root, timeoutMs, signal); })();
    try { return await record.reconnecting; } finally { record.reconnecting = null; }
  }
  async restart(root, timeoutMs, signal) { signal?.throwIfAborted(); const old = this.clients.get(root); if (old) this.invalidate(root, old.generation); const record = await this.get(root, timeoutMs, signal); return { backend: "serena", ok: true, action: "restarted", tools: [...record.tools.keys()].filter((x) => ALLOWED_TOOLS.has(x)) }; }
  status(root) { const r = this.clients.get(root); return { backend: "serena", running: Boolean(r?.ready && !r.client?.closed), generation: r?.generation ?? null, tools: r ? [...r.tools.keys()].filter((x) => ALLOWED_TOOLS.has(x)) : [], capabilities: r?.capabilities ?? null, lastUsed: r?.lastUsed ?? null }; }
  #evictIfNeeded() { if (this.clients.size < this.maxClients) return; const oldest = [...this.clients.entries()].filter(([, r]) => r.ready && r.waiters === 0 && r.client.pending.size === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]; if (!oldest) throw new Error("Serena pool is busy; no idle client can be evicted"); this.invalidate(oldest[0], oldest[1].generation); }
  closeAll() { for (const [root, r] of this.clients) this.invalidate(root, r.generation); }
}
function waitForOpen(opening, signal) { if (!signal) return opening; signal.throwIfAborted(); return new Promise((resolve, reject) => { const onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); opening.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); }); }); }

const pool = new SerenaPool();
export const serenaPool = pool;
export function closeSerena() { pool.closeAll(); }
process.once("exit", () => pool.closeAll());
process.once("SIGTERM", () => { pool.closeAll(); process.exit(0); });
process.once("SIGINT", () => { pool.closeAll(); process.exit(130); });

function buildCall(kind, input) {
  const max = Math.max(2_000, Math.min(input.perBackendChars ?? 14_000, 100_000));
  if (kind === "diagnostics") { if (!input.relativePath) throw new Error("diagnostics requires relativePath"); return { tool: "get_diagnostics_for_file", args: { relative_path: input.relativePath, max_answer_chars: max } }; }
  if (kind === "references" || kind === "implementations") { if (!input.symbol || !input.relativePath) throw new Error(`${kind} requires symbol and relativePath`); return { tool: kind === "references" ? "find_referencing_symbols" : "find_implementations", args: { name_path: input.symbol, relative_path: input.relativePath, max_answer_chars: max } }; }
  const symbol = input.symbol || input.query; if (!symbol) throw new Error("symbol lookup requires symbol or query");
  return { tool: "find_symbol", args: { name_path_pattern: symbol, relative_path: input.relativePath ?? "", include_body: Boolean(input.includeBody), depth: input.depth ?? 0, substring_matching: input.substringMatching ?? !input.symbol, max_matches: input.limit ?? 20, max_answer_chars: max } };
}
function sessionFailure(error, client) { return Boolean(client?.closed) || error?.code === "TRANSPORT_CLOSED" || /(?:exited|closed|process|broken pipe)/i.test(error?.message ?? ""); }

export async function serenaQuery(kind, input, signal) {
  const operation = kind ?? input.operation ?? "symbol"; const started = performance.now(); let preparedAt = started; let call;
  try { signal?.throwIfAborted(); call = buildCall(operation, input); const record = await pool.get(input.root, input.timeoutMs, signal); preparedAt = performance.now(); if (!ALLOWED_TOOLS.has(call.tool) || !record.tools.has(call.tool)) return failureEnvelope("serena", operation, "UNSUPPORTED_CAPABILITY", `Serena does not expose required tool: ${call.tool}`, { timing: timing(started, preparedAt, preparedAt) });
    const executeAt = performance.now(); const result = await record.client.callTool(call.tool, call.args, { signal, timeoutMs: input.timeoutMs }); signal?.throwIfAborted();
    const parsed = parseSerenaResponse(result, { operation, root: input.root }); if (!parsed.ok) return failureEnvelope("serena", operation, parsed.code, parsed.message, { truncated: parsed.truncated ?? false, timing: timing(started, preparedAt, executeAt) });
    return envelope({ backend: "serena", operation, ...parsed, timing: timing(started, preparedAt, executeAt), raw: { ...(parsed.structured ? { structured: parsed.structured } : {}), text: textBlocks(result) } });
  } catch (error) {
    signal?.throwIfAborted();
    if (call && error?.code === "UNSUPPORTED_CAPABILITY") return failureEnvelope("serena", operation, "UNSUPPORTED_CAPABILITY", error.message, { timing: timing(started, preparedAt, preparedAt) });
    const record = input.root ? pool.clients.get(input.root) : null;
    if (sessionFailure(error, record?.client) && record) {
      try { await pool.reconnect(input.root, record, input.timeoutMs, signal); } catch (reconnectError) { signal?.throwIfAborted(); return failureEnvelope("serena", operation, errorCodeFor(reconnectError, null), reconnectError.message, { timing: timing(started, preparedAt, preparedAt) }); }
      return failureEnvelope("serena", operation, "TRANSPORT_CLOSED", error.message, { timing: timing(started, preparedAt, preparedAt) });
    }
    const code = /timeout/i.test(error?.message ?? "") ? "TIMEOUT" : errorCodeFor(error, null);
    return failureEnvelope("serena", operation, code, error?.message ?? String(error), { timing: timing(started, preparedAt, preparedAt) });
  }
}
export function serenaStatus(root) { return pool.status(root); }
export async function repairSerena(root, timeoutMs, signal) { const started = performance.now(); try { signal?.throwIfAborted(); const result = await pool.restart(root, timeoutMs, signal); return envelope({ backend: "serena", operation: "repair", outcome: "ok", items: [], opaque: [], coverage: "backend_complete", returned: 0, timing: { prepareMs: 0, queueMs: 0, executeMs: Math.round(performance.now() - started), totalMs: Math.round(performance.now() - started) }, raw: { structured: result } }); } catch (error) { signal?.throwIfAborted(); return failureEnvelope("serena", "repair", errorCodeFor(error, null), error.message, { timing: { prepareMs: 0, queueMs: 0, executeMs: Math.round(performance.now() - started), totalMs: Math.round(performance.now() - started) } }); } }
