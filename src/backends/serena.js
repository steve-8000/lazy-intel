import { StdioMcpClient, toolText } from "../mcp/client.js";
import { resolveBin } from "../lib/process.js";
import { log } from "../lib/log.js";

const ALLOWED_TOOLS = new Set([
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_diagnostics_for_file",
]);

class SerenaPool {
  constructor() {
    this.clients = new Map();
    const max = Number(process.env.LAZY_INTEL_SERENA_MAX_CLIENTS ?? 2);
    this.maxClients = Number.isInteger(max) && max > 0 ? Math.min(max, 8) : 2;
  }

  async get(root, timeoutMs, signal) {
    signal?.throwIfAborted();
    let record = this.clients.get(root);
    if (record?.client?.closed) { this.invalidate(root); record = null; }
    if (!record) {
      this.#evictIfNeeded();
      record = { client: null, tools: new Set(), lastUsed: Date.now(), waiters: 0, disposed: false, ready: false };
      this.clients.set(root, record);
      record.opening = this.#open(root, timeoutMs, record).catch((error) => {
        if (this.clients.get(root) === record) this.invalidate(root);
        throw error;
      });
    }
    record.lastUsed = Date.now();
    record.waiters++;
    try {
      await waitForOpen(record.opening, signal);
      signal?.throwIfAborted();
      return record;
    } finally {
      record.waiters--;
      if (!record.ready && record.waiters === 0 && this.clients.get(root) === record) this.invalidate(root);
    }
  }

  async #open(root, timeoutMs, record) {
    const serena = await resolveBin("serena");
    if (record.disposed) throw new Error("Serena startup cancelled");
    // Serena 1.7 renamed contexts: ide-assistant no longer exists. `agent` is the
    // tools-only context that fits a harness where OMP owns editing.
    const context = process.env.LAZY_INTEL_SERENA_CONTEXT ?? "agent";
    const client = new StdioMcpClient(serena, [
      "start-mcp-server",
      "--transport", "stdio",
      "--context", context,
      "--project", root,
      "--enable-web-dashboard", "false",
      "--enable-gui-log-window", "false",
      "--log-level", "ERROR",
    ], { cwd: root, name: `serena:${root}`, timeoutMs, env: { SERENA_USAGE_REPORTING: "false", DO_NOT_TRACK: "1" } });
    record.client = client;
    let listed;
    try {
      await client.start();
      listed = await client.listTools();
    } catch (error) {
      // Not registered yet, so invalidate() cannot reach it: close here or leak a process per retry.
      client.close();
      throw error;
    }
    const names = new Set((listed.tools ?? []).map((t) => t.name));
    const missing = [...ALLOWED_TOOLS].filter((t) => !names.has(t));
    if (missing.length) log("warn", "serena semantic tools missing", { root, missing });
    record.tools = names;
    record.ready = true;
  }

  invalidate(root) {
    const existing = this.clients.get(root);
    if (existing) { existing.disposed = true; existing.client?.close(); }
    this.clients.delete(root);
  }

  async restart(root, timeoutMs, signal) {
    signal?.throwIfAborted();
    this.invalidate(root);
    const record = await this.get(root, timeoutMs, signal);
    return {
      backend: "serena",
      ok: true,
      action: "restarted",
      tools: [...record.tools].filter((x) => ALLOWED_TOOLS.has(x)),
    };
  }

  status(root) {
    const existing = this.clients.get(root);
    return {
      backend: "serena",
      running: Boolean(existing?.ready && !existing.client?.closed),
      tools: existing ? [...existing.tools].filter((x) => ALLOWED_TOOLS.has(x)) : [],
      lastUsed: existing?.lastUsed ?? null,
    };
  }

  #evictIfNeeded() {
    if (this.clients.size < this.maxClients) return;
    const oldest = [...this.clients.entries()]
      .filter(([, entry]) => entry.ready && entry.waiters === 0 && entry.client.pending.size === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) throw new Error("Serena pool is busy; no idle client can be evicted");
    this.invalidate(oldest[0]);
  }

  closeAll() {
    for (const root of this.clients.keys()) this.invalidate(root);
  }
}

function waitForOpen(opening, signal) {
  if (!signal) return opening;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    opening.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

const pool = new SerenaPool();
export function closeSerena() { pool.closeAll(); }
process.once("exit", () => pool.closeAll());
process.once("SIGTERM", () => { pool.closeAll(); process.exit(0); });
process.once("SIGINT", () => { pool.closeAll(); process.exit(130); });

export async function serenaQuery(kind, input, signal) {
  signal?.throwIfAborted();
  let call;
  try { call = buildCall(kind, input); }
  catch (error) { return { backend: "serena", ok: false, text: "", warning: error.message }; }

  let firstError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { client, tools } = await pool.get(input.root, input.timeoutMs, signal);
      if (!ALLOWED_TOOLS.has(call.tool)) throw new Error(`Serena tool not allowed: ${call.tool}`);
      if (!tools.has(call.tool)) throw new Error(`Serena does not expose required tool: ${call.tool}`);
      const started = performance.now();
      const result = await client.callTool(call.tool, call.args, { signal, timeoutMs: input.timeoutMs });
      if (result?.isError) throw new Error(toolText(result) || `${call.tool} failed`);
      return { backend: "serena", ok: true, text: toolText(result), latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      signal?.throwIfAborted();
      firstError ??= error;
      pool.invalidate(input.root);
      if (attempt === 0) log("warn", "Serena call failed; restarting once", { root: input.root, error: error.message });
    }
  }
  return { backend: "serena", ok: false, text: "", warning: firstError?.message ?? "Serena failed" };
}

export function serenaStatus(root) {
  return pool.status(root);
}

export async function repairSerena(root, timeoutMs, signal) {
  signal?.throwIfAborted();
  try { return await pool.restart(root, timeoutMs, signal); }
  catch (error) { signal?.throwIfAborted(); return { backend: "serena", ok: false, action: "restart_failed", error: error.message }; }
}

function buildCall(kind, input) {
  const max = Math.max(2_000, Math.min(input.perBackendChars ?? 14_000, 100_000));
  if (kind === "diagnostics") {
    if (!input.relativePath) throw new Error("diagnostics requires relativePath");
    return { tool: "get_diagnostics_for_file", args: { relative_path: input.relativePath, max_answer_chars: max } };
  }
  if (kind === "references") {
    requireSymbolAndPath(input, kind);
    return { tool: "find_referencing_symbols", args: { name_path: input.symbol, relative_path: input.relativePath, max_answer_chars: max } };
  }
  if (kind === "implementations") {
    requireSymbolAndPath(input, kind);
    return { tool: "find_implementations", args: { name_path: input.symbol, relative_path: input.relativePath, max_answer_chars: max } };
  }
  const symbol = input.symbol || input.query;
  if (!symbol) throw new Error("symbol lookup requires symbol or query");
  return {
    tool: "find_symbol",
    args: {
      name_path_pattern: symbol,
      relative_path: input.relativePath ?? "",
      include_body: Boolean(input.includeBody),
      depth: input.depth ?? 0,
      substring_matching: input.substringMatching ?? !input.symbol,
      max_matches: input.limit ?? 20,
      max_answer_chars: max,
    },
  };
}

function requireSymbolAndPath(input, kind) {
  if (!input.symbol || !input.relativePath) throw new Error(`${kind} requires symbol and relativePath`);
}
