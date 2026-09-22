import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serveWorker, WorkerError } from "../../packages/core/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRIDGE = resolve(ROOT, "workers/semantic/lazy_semantic/bridge.py");
const VENDOR_SRC = resolve(ROOT, "vendor/serena/src");
const UPSTREAM_COMMIT = "949a27ef1e5fda1a6e7b561e777bcece345c6ffd";

function configuredPython() {
  if (process.env.LAZY_INTEL_PYTHON?.trim()) return resolve(process.env.LAZY_INTEL_PYTHON);
  return resolve(dirname(fileURLToPath(import.meta.url)), ".venv/bin/python");
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class PythonBridge {
  #child = null;
  #buffer = "";
  #waiters = new Map();
  #dead = null;

  async #ensure() {
    if (this.#child && this.#dead === null) return;
    const python = configuredPython();
    if (!(await executable(python))) {
      throw new WorkerError("backend_failed", `trusted Python interpreter is unavailable: ${python}`, false);
    }
    const child = spawn(python, [BRIDGE], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: `${VENDOR_SRC}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#dead = null;
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(child, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => process.stderr.write(`semantic-python: ${chunk}`));
    child.once("error", (error) => { if (this.#child === child) this.#die(error); });
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      if (code !== 0 || signal !== null) this.#die(new Error(`Python bridge exited (code=${code}, signal=${signal})`));
    });
  }

  #onData(child, chunk) {
    if (this.#child !== child) return;
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch (error) { this.#die(error); return; }
      const requestId = response?.requestId;
      const resolveResponse = this.#waiters.get(requestId);
      if (!resolveResponse) {
        process.stderr.write(`semantic-python: discarded response for unknown requestId ${JSON.stringify(requestId)}\n`);
        continue;
      }
      this.#waiters.delete(requestId);
      resolveResponse(response);
    }
  }

  #die(error) {
    if (this.#dead !== null) return;
    this.#dead = error instanceof Error ? error : new Error(String(error));
    for (const resolveWaiter of this.#waiters.values()) resolveWaiter({ ok: false, code: "backend_failed", retryable: true, message: this.#dead.message });
    this.#waiters.clear();
    this.#child = null;
    this.#buffer = "";
  }

  async request(operation, payload, budgetMs) {
    await this.#ensure();
    if (this.#dead !== null) throw new WorkerError("backend_failed", `Python bridge is dead: ${this.#dead.message}`, true);
    const requestId = randomUUID();
    const responsePromise = new Promise((resolveResponse) => this.#waiters.set(requestId, resolveResponse));
    let resolveTimeout;
    const timeoutPromise = new Promise((_, reject) => { resolveTimeout = () => reject(new WorkerError("deadline", "semantic Python budget expired", true)); });
    const timer = setTimeout(() => {
      this.#waiters.delete(requestId);
      // Serena/LSP work cannot be cancelled; recycle the process rather than leave queued callers behind it.
      const child = this.#child;
      this.#die(new Error("semantic Python budget expired"));
      child?.kill();
      resolveTimeout();
    }, Math.max(1, budgetMs));
    this.#child.stdin.write(`${JSON.stringify({ requestId, operation, payload })}\n`);
    try {
      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (!response.ok) {
        if (response.code === "unavailable") return { outcome: "unavailable", payload: response };
        throw new WorkerError(response.code === "invalid_request" ? "invalid_request" : "backend_failed", response.message, response.retryable !== false);
      }
      return { outcome: "ok", payload: response.payload };
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    this.#child?.stdin.end();
    this.#child?.kill();
    this.#child = null;
  }
}

function validatePayload(payload) {
  const serverPath = payload?.languageServerPath;
  if (serverPath !== undefined && (!serverPath || !isAbsolute(serverPath))) {
    throw new WorkerError("invalid_request", "languageServerPath must be an explicit absolute executable path", false);
  }
}

const bridge = new PythonBridge();
await serveWorker({
  kind: "semantic",
  upstreamCommit: UPSTREAM_COMMIT,
  handlers: {
    initialize: async (payload, context) => { validatePayload(payload); return bridge.request("initialize", payload, context.remainingBudgetMs); },
    symbol: async (payload, context) => { validatePayload(payload); return bridge.request("symbol", payload, context.remainingBudgetMs); },
    references: async (payload, context) => { validatePayload(payload); return bridge.request("references", payload, context.remainingBudgetMs); },
    implementations: async (payload, context) => { validatePayload(payload); return bridge.request("implementations", payload, context.remainingBudgetMs); },
    diagnostics: async (payload, context) => { validatePayload(payload); return bridge.request("diagnostics", payload, context.remainingBudgetMs); },
    overview: async (payload, context) => { validatePayload(payload); return bridge.request("overview", payload, context.remainingBudgetMs); }
  },
  dispose: async () => bridge.close(),
});
