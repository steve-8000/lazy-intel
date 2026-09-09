import { spawn } from "node:child_process";
import readline from "node:readline";
import { log } from "../lib/log.js";

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

    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "lazy-intel", version: "0.2.0" },
    });
    this.notify("notifications/initialized", {});
    return this;
  }

  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
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
        // MCP initialize is not cancellable. Notification failure must not hide the abort.
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
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = timeoutMs > 0 ? setTimeout(() => cancel(new Error(`${this.name} MCP timeout: ${method}`)), timeoutMs) : null;
      timer?.unref();
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) this.pending.get(id)?.reject(error);
        });
      } catch (error) { this.pending.get(id)?.reject(error); }
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
    this.closed = true;
    this.child?.kill("SIGTERM");
    this.#closeAll(new Error(`${this.name} closed`));
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
    if (msg.error) pending.reject(new Error(`${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else pending.resolve(msg.result);
  }

  #closeAll(error) {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}

export function toolText(result) {
  const blocks = result?.content ?? [];
  return blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
}
