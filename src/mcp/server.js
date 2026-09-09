import readline from "node:readline";
import process from "node:process";
import { codeIntel } from "../engine.js";
import { bootstrapRoot, closeIndexManager } from "../index-manager.js";
import { log } from "../lib/log.js";
import { bootRoot } from "../lib/roots.js";
import { closeSerena } from "../backends/serena.js";

const TOOL = {
  name: "code_intel",
  description: [
    "Unified autonomous local code intelligence and index control plane for OMP.",
    "Routes to zvec-grep for semantic workspace retrieval, CodeGraph for architecture/call-flow/impact, and Serena/LSP for exact symbol semantics.",
    "It automatically creates, watches, synchronizes, and repairs derived indexes; no user index maintenance is required.",
    "The same tool lets the agent inspect/sync/reindex/repair indexes when explicit control is useful.",
    "Sharpshooter remains the durable memory owner. OMP native source/edit/build/tests remain correctness truth.",
    "Prefer explicit operation when known. auto uses deterministic routing and fans out to at most two intelligence backends.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Focused local-code question or search phrase. Optional for status/sync/reindex/repair and symbol-only calls." },
      root: { type: "string", description: "Canonical workspace root, confined to process boot root or explicitly configured LAZY_INTEL_ALLOWED_ROOTS." },
      operation: {
        type: "string",
        enum: ["auto", "search", "architecture", "symbol", "references", "implementations", "diagnostics", "impact", "status", "sync", "reindex", "repair"],
        default: "auto",
      },
      backend: { type: "string", enum: ["all", "zvec", "codegraph", "serena"], default: "all", description: "Backend target for control operations. Serena supports status/repair; zvec and CodeGraph support index controls." },
      embedding: { type: "string", description: "Optional zvec embedding model for an explicit reindex. Omit it to preserve an existing index model." },
      symbol: { type: "string", description: "Exact/near-exact symbol name or Serena name_path. Required for impact, references and implementations." },
      relativePath: { type: "string", description: "Project-relative source path. Required for references/implementations/diagnostics." },
      includeBody: { type: "boolean", default: false },
      substringMatching: { type: "boolean" },
      freshness: {
        type: "string",
        enum: ["fast", "auto", "strict"],
        default: "auto",
        description: "auto is default: create indexes if absent and sync when dirty/stale. strict forces a pre-query sync. fast permits a previously built index.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      depth: { type: "integer", minimum: 0, maximum: 10, default: 2 },
      maxChars: { type: "integer", minimum: 4000, maximum: 80000, default: 24000 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      indexTimeoutMs: { type: "integer", minimum: 5000, maximum: 1800000, default: 120000, description: "Timeout for automatic index create/sync/rebuild operations." },
    },
  },
};

export function startMcpServer() {
  if (process.env.LAZY_INTEL_AUTO_INDEX !== "false") {
    bootstrapRoot(bootRoot).catch((error) => log("warn", "initial automatic indexing failed", { root: bootRoot, error: error.message }));
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const controllers = new Map();

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); }
    catch {
      writeError(null, -32700, "Parse error");
      return;
    }

    if (req.method === "notifications/cancelled") {
      controllers.get(req.params?.requestId)?.abort();
      return;
    }
    if (req.id == null) return;

    const controller = new AbortController();
    controllers.set(req.id, controller);
    try {
      const result = await handle(req, controller.signal);
      write({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      log("error", "MCP request failed", { method: req.method, error: error.message });
      writeError(req.id, error.code ?? -32000, error.message);
    } finally {
      controllers.delete(req.id);
    }
  });

  rl.on("close", () => {
    for (const controller of controllers.values()) controller.abort();
    closeSerena();
    closeIndexManager();
    process.exitCode = 0;
  });
}

async function handle(req, signal) {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: req.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lazy-intel", version: "0.2.0" },
        instructions: "Use code_intel for autonomous local code intelligence. lazy-intel owns derived index lifecycle and self-repair; Sharpshooter owns memory; OMP native source/edit/build/tests remain truth.",
      };
    case "ping": return {};
    case "tools/list": return { tools: [TOOL] };
    case "tools/call": {
      if (req.params?.name !== "code_intel") throw new Error(`unknown tool: ${req.params?.name}`);
      const result = await codeIntel(req.params?.arguments ?? {}, signal);
      const backends = result.meta?.backends;
      // Intelligence calls where no backend produced evidence are failures, not empty successes.
      const isError = result.meta?.ok === false || (Array.isArray(backends) && backends.length > 0 && backends.every((b) => !b.ok));
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.meta,
        isError,
      };
    }
    default: throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
  }
}

function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function writeError(id, code, message) { write({ jsonrpc: "2.0", id, error: { code, message } }); }
