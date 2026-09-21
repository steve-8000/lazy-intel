import process from "node:process";
import { codeIntel } from "../engine.js";
import { bootstrapRoot, closeIndexManager } from "../index-manager.js";
import { log } from "../lib/log.js";
import { bootRoot } from "../lib/roots.js";
import { closeSerena } from "../backends/serena.js";
import { closeUnified } from "../unified.js";
import { ERROR_CODES } from "../contracts.js";
import { WIRE_CAP_BYTES as CONTEXT_WIRE_CAP_BYTES } from "../context-pack.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
export const MAX_INPUT_FRAME_BYTES = 256 * 1024;
export const WIRE_CAP_BYTES = CONTEXT_WIRE_CAP_BYTES;
export const OUTPUT_WIRE_CAP_BYTES = WIRE_CAP_BYTES;
const MAX_ACTIVE_REQUESTS = 4;
const MAX_QUEUED_REQUESTS = 32;
const BUSY_CODE = Object.hasOwn(ERROR_CODES, "BUSY") ? "BUSY" : "INTERNAL_ERROR";

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
        enum: ["auto", "context", "search", "architecture", "symbol", "references", "implementations", "diagnostics", "impact", "status", "sync", "reindex", "repair"],
        default: "auto",
        description: "context stage 1 runs CodeGraph context plus zvec discovery in parallel; stage 2 adds at most one Serena symbol lookup only when a validated unique typed focal subject is resolved.",
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
      requestTimeoutMs: { type: "integer", minimum: 1000, maximum: 3600000, description: "Whole-request ceiling, including queueing, index preparation, backend execution, and rendering." },
    },
  },
};

/** Return the negotiated protocol revision stored on a server session. */
export function getNegotiatedProtocolVersion(session) {
  return session?.negotiatedVersion ?? null;
}

export function startMcpServer() {
  if (process.env.LAZY_INTEL_AUTO_INDEX !== "false") {
    bootstrapRoot(bootRoot).catch((error) => log("warn", "initial automatic indexing failed", { root: bootRoot, error: error.message }));
  }

  const session = { negotiatedVersion: null };
  const controllers = new Map();
  const queue = [];
  let active = 0;
  let closed = false;

  const runRecord = (record) => {
    const intelligence = record.request.method === "tools/call";
    if (intelligence) active += 1;
    void (async () => {
      try {
        const result = await handle(record.request, record.controller.signal, session);
        if (!record.controller.signal.aborted && !record.responseWritten) {
          writeResponse({ jsonrpc: "2.0", id: record.request.id, result }, session);
        }
      } catch (error) {
        if (!record.responseWritten && !record.controller.signal.aborted) {
          log("error", "MCP request failed", { method: record.request.method, error: error.message });
          writeError(record.request.id, error.code ?? -32000, error.message, error.data, session);
        }
      } finally {
        record.responseWritten = true;
        controllers.delete(record.request.id);
        if (intelligence) active -= 1;
        drain();
      }
    })();
  };

  const drain = () => {
    while (!closed && active < MAX_ACTIVE_REQUESTS && queue.length > 0) {
      const record = queue.shift();
      if (record.controller.signal.aborted) {
        record.responseWritten = true;
        controllers.delete(record.request.id);
        continue;
      }
      runRecord(record);
    }
  };

  const onRequest = (req) => {
    if (!isRequestObject(req)) {
      writeError(null, -32600, "Invalid Request", undefined, session);
      return;
    }
    if (req.method === "notifications/cancelled") {
      const requestId = req.params?.requestId;
      const record = controllers.get(requestId);
      if (record?.request.method !== "initialize") record?.controller.abort();
      return;
    }
    if (req.id == null) return;
    if (controllers.has(req.id)) {
      writeError(req.id, -32600, "Duplicate in-flight request id", undefined, session);
      return;
    }

    const record = { request: req, controller: new AbortController(), responseWritten: false };
    controllers.set(req.id, record);
    if (req.method === "tools/call") {
      if (active >= MAX_ACTIVE_REQUESTS) {
        if (queue.length >= MAX_QUEUED_REQUESTS) {
          controllers.delete(req.id);
          writeToolError(req.id, BUSY_CODE, "The intelligence request queue is full.", session);
          return;
        }
        queue.push(record);
        return;
      }
      runRecord(record);
      return;
    }
    runRecord(record);
  };

  const framer = createLineFramer(process.stdin, (line) => {
    let req;
    try { req = JSON.parse(line); } catch { writeError(null, -32700, "Parse error", undefined, session); return; }
    onRequest(req);
  }, () => {
    writeError(null, -32600, "Frame exceeds the 256 KiB input limit", undefined, session);
  });
  framer.start();

  process.stdin.once("close", () => {
    closed = true;
    for (const record of controllers.values()) record.controller.abort();
    controllers.clear();
    queue.length = 0;
    closeSerena();
    closeIndexManager();
    // Worker processes outlive their parent's stdin unless they are released, and
    // an orphaned worker keeps a workspace lock nobody can reclaim.
    void closeUnified();
    process.exitCode = 0;
  });

  return session;
}

async function handle(req, signal, session) {
  switch (req.method) {
    case "initialize": {
      const requested = req.params?.protocolVersion;
      session.negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        protocolVersion: session.negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lazy-intel", version: "0.2.0" },
        instructions: "Use code_intel for autonomous local code intelligence. lazy-intel owns derived index lifecycle and self-repair; Sharpshooter owns memory; OMP native source/edit/build/tests remain truth.",
      };
    }
    case "ping": return {};
    case "tools/list": return { tools: [TOOL] };
    case "tools/call": {
      if (req.params?.name !== "code_intel") throw protocolError(-32602, `Unknown tool: ${req.params?.name}`);
      const args = req.params?.arguments === undefined ? {} : req.params.arguments;
      validateToolArguments(args);
      try {
        const result = await codeIntel(args, signal);
        // Fulfilment is decided by the engine against the plan's obligations. A backend
        // answering at all was never evidence that the request was satisfied.
        const content = [{ type: "text", text: result.text ?? "" }];
        // Text-only consumers still need the machine-readable status; its length is already
        // inside the response budget the engine applied.
        if (result.metaText) content.push({ type: "text", text: result.metaText });
        const response = { content, isError: Boolean(result.isError) };
        if (session.negotiatedVersion === SUPPORTED_PROTOCOL_VERSIONS[0]) response.structuredContent = result.meta;
        return response;
      } catch (error) {
        if (signal.aborted) throw error;
        return toolError(error.code ?? "TOOL_ERROR", error.message, session);
      }
    }
    default: throw protocolError(-32601, `Method not found: ${req.method}`);
  }
}

function validateToolArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw protocolError(-32602, "Tool arguments must be an object");
  const allowed = new Set(Object.keys(TOOL.inputSchema.properties));
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw protocolError(-32602, `Unknown tool argument: ${key}`);
  const strings = ["query", "root", "embedding", "symbol", "relativePath"];
  for (const key of strings) if (args[key] !== undefined && typeof args[key] !== "string") throw protocolError(-32602, `${key} must be a string`);
    for (const key of ["includeBody", "substringMatching"]) {
      if (args[key] !== undefined && typeof args[key] !== "boolean") throw protocolError(-32602, key + " must be a boolean");
    }
  checkEnum(args.operation, TOOL.inputSchema.properties.operation.enum, "operation");
  checkEnum(args.backend, TOOL.inputSchema.properties.backend.enum, "backend");
  checkEnum(args.freshness, TOOL.inputSchema.properties.freshness.enum, "freshness");
  checkInteger(args.limit, 1, 100, "limit");
  checkInteger(args.depth, 0, 10, "depth");
  checkInteger(args.maxChars, 4000, 80000, "maxChars");
  checkInteger(args.timeoutMs, 1000, 120000, "timeoutMs");
  checkInteger(args.indexTimeoutMs, 5000, 1800000, "indexTimeoutMs");
  checkInteger(args.requestTimeoutMs, 1000, 3600000, "requestTimeoutMs");
}

function checkEnum(value, allowed, name) {
  if (value !== undefined && !allowed.includes(value)) throw protocolError(-32602, `${name} must be one of: ${allowed.join(", ")}`);
}

function checkInteger(value, minimum, maximum, name) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw protocolError(-32602, `${name} must be an integer between ${minimum} and ${maximum}`);
}

function protocolError(code, message, data) {
  return Object.assign(new Error(message), { code, data });
}

function toolError(code, message, session) {
  const response = { content: [{ type: "text", text: String(message ?? code) }], isError: true };
  if (session.negotiatedVersion === SUPPORTED_PROTOCOL_VERSIONS[0]) response.structuredContent = { error: { code, message: String(message ?? code) } };
  return response;
}

function writeToolError(id, code, message, session) {
  writeResponse({ jsonrpc: "2.0", id, result: toolError(code, message, session) }, session);
}

function writeResponse(value, session) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= WIRE_CAP_BYTES) {
    process.stdout.write(`${serialized}\n`);
    return;
  }
  const id = value.id ?? null;
  const degraded = {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: "Response exceeded the 1 MiB wire limit; optional result details were omitted." }],
      isError: true,
    },
  };
  if (session.negotiatedVersion === SUPPORTED_PROTOCOL_VERSIONS[0]) degraded.result.structuredContent = { error: { code: "OUTPUT_LIMIT", message: "Response exceeded the 1 MiB wire limit" } };
  process.stdout.write(`${JSON.stringify(degraded)}\n`);
}

function writeError(id, code, message, data, session) {
  writeResponse({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, session);
}

function isRequestObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function createLineFramer(stream, onLine, onOversized) {
  let partial = Buffer.alloc(0);
  let discarding = false;
  return {
    start() {
      stream.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(0x0a, offset);
          const end = newline === -1 ? bytes.length : newline;
          const part = bytes.subarray(offset, end);
                    let rejected = false;
          if (discarding) {
            if (newline !== -1) {
              discarding = false;
                            rejected = true;
              partial = Buffer.alloc(0);
            }
          } else if (partial.length + part.length > MAX_INPUT_FRAME_BYTES) {
            onOversized();
                        rejected = true;
            partial = Buffer.alloc(0);
            discarding = newline === -1;
          } else if (part.length > 0) {
            partial = partial.length === 0 ? Buffer.from(part) : Buffer.concat([partial, part]);
          }
          if (newline !== -1 && !discarding && !rejected) {
            onLine(partial.toString("utf8").replace(/\r$/, ""));
            partial = Buffer.alloc(0);
          }
          offset = newline === -1 ? bytes.length : newline + 1;
        }
      });
      stream.on("end", () => {
        if (!discarding && partial.length > 0) onLine(partial.toString("utf8").replace(/\r$/, ""));
      });
    },
  };
}
