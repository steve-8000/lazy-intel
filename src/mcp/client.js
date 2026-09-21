import { spawn } from "node:child_process";
import readline from "node:readline";
import { log } from "../lib/log.js";


export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

export class McpRpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
    this.data = data;
  }
}

export class McpRequestTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpRequestTimeoutError";
        this.code = "TIMEOUT";
  }
}

export class StdioMcpClient {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.name = options.name ?? command;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.protocolVersion = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", (error) => this.#closeAll(error));
    this.child.stderr.on("data", (chunk) => log("debug", `${this.name}:stderr`, { text: chunk.toString("utf8").slice(0, 4000) }));
    this.child.on("exit", (code, signal) => this.#closeAll(new Error(`${this.name} exited code=${code} signal=${signal}`)));
    this.child.on("error", (error) => this.#closeAll(error));

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#onLine(line));

    const initialize = await this.request("initialize", {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "lazy-intel", version: "0.3.0" },
    });
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(initialize?.protocolVersion)) {
      const error = new McpRpcError(`Unsupported negotiated protocol version: ${initialize?.protocolVersion ?? "missing"}`, "UNSUPPORTED_VERSION", { protocolVersion: initialize?.protocolVersion });
      this.#closeAll(error);
      this.child?.kill("SIGTERM");
      throw error;
    }
    this.protocolVersion = initialize.protocolVersion;
    this.notify("notifications/initialized", {});
    return this;
  }

  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (method !== "initialize" && signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (error) => {
        if (!this.pending.has(id)) return;
        cleanup();
        if (method !== "initialize") {
          try { this.notify("notifications/cancelled", { requestId: id }); } catch {}
        }
        reject(error);
      };
      const onAbort = () => cancel(signal.reason);
      this.pending.set(id, {
        resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); },
      });
            if (method !== "initialize") signal?.addEventListener("abort", onAbort, { once: true });
      timer = timeoutMs > 0 && method !== "initialize"
        ? setTimeout(() => cancel(new McpRequestTimeoutError(`${this.name} MCP timeout: ${method}`)), timeoutMs)
        : null;
      timer?.unref();
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) this.#closeAll(error);
        });
      } catch (error) {
        this.#closeAll(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools() {
    return this.request("tools/list", {});
  }

  async callTool(name, args, options) {
    return this.request("tools/call", { name, arguments: args }, options);
  }

  close() {
    if (this.closed) return;
    this.#closeAll(new Error(`${this.name} closed`));
    this.child?.kill("SIGTERM");
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch {
      log("warn", `${this.name}:non-json-stdout`, { line: line.slice(0, 1000) });
      return;
    }
    if (msg.id == null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new McpRpcError(`${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`, msg.error.code, msg.error.data));
    else pending.resolve(msg.result);
  }

  #closeAll(error) {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

export function toolText(result) {
  const blocks = result?.content ?? [];
  return blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
}
