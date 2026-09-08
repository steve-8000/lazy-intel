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
    this.maxClients = Number(process.env.LAZY_INTEL_SERENA_MAX_CLIENTS ?? 2);
  }

  async get(root, timeoutMs) {
    const existing = this.clients.get(root);
    if (existing && !existing.client.closed) {
      existing.lastUsed = Date.now();
      return existing;
    }
    await this.#evictIfNeeded();
    const serena = await resolveBin("serena");
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
    const record = { client, tools: names, lastUsed: Date.now() };
    this.clients.set(root, record);
    return record;
  }

  invalidate(root) {
    const existing = this.clients.get(root);
    existing?.client.close();
    this.clients.delete(root);
  }

  async restart(root, timeoutMs) {
    this.invalidate(root);
    const record = await this.get(root, timeoutMs);
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
      running: Boolean(existing && !existing.client.closed),
      tools: existing ? [...existing.tools].filter((x) => ALLOWED_TOOLS.has(x)) : [],
      lastUsed: existing?.lastUsed ?? null,
    };
  }

  async #evictIfNeeded() {
    if (this.clients.size < this.maxClients) return;
    const oldest = [...this.clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) {
      oldest[1].client.close();
      this.clients.delete(oldest[0]);
    }
  }

  closeAll() {
    for (const { client } of this.clients.values()) client.close();
    this.clients.clear();
  }
}

const pool = new SerenaPool();
process.once("exit", () => pool.closeAll());
process.once("SIGTERM", () => { pool.closeAll(); process.exit(0); });
process.once("SIGINT", () => { pool.closeAll(); process.exit(130); });

export async function serenaQuery(kind, input) {
  let call;
  try { call = buildCall(kind, input); }
  catch (error) { return { backend: "serena", ok: false, text: "", warning: error.message }; }

  let firstError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { client, tools } = await pool.get(input.root, input.timeoutMs);
      if (!ALLOWED_TOOLS.has(call.tool)) throw new Error(`Serena tool not allowed: ${call.tool}`);
      if (!tools.has(call.tool)) throw new Error(`Serena does not expose required tool: ${call.tool}`);
      const started = performance.now();
      const result = await client.callTool(call.tool, call.args);
      if (result?.isError) throw new Error(toolText(result) || `${call.tool} failed`);
      return { backend: "serena", ok: true, text: toolText(result), latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
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

export async function repairSerena(root, timeoutMs) {
  try { return await pool.restart(root, timeoutMs); }
  catch (error) { return { backend: "serena", ok: false, action: "restart_failed", error: error.message }; }
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
