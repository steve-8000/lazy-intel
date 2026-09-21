import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
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
    this.#child = spawn(python, [BRIDGE], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: `${VENDOR_SRC}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#dead = null;
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => process.stderr.write(`semantic-python: ${chunk}`));
    this.#child.once("error", (error) => this.#die(error));
    this.#child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) this.#die(new Error(`Python bridge exited (code=${code}, signal=${signal})`));
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch (error) { this.#die(error); return; }
      const waiter = this.#waiters.entries().next().value;
      if (!waiter) continue;
      this.#waiters.delete(waiter[0]);
      waiter[1](response);
    }
  }

  #die(error) {
    if (this.#dead !== null) return;
    this.#dead = error instanceof Error ? error : new Error(String(error));
    for (const resolveWaiter of this.#waiters.values()) resolveWaiter({ ok: false, code: "backend_failed", retryable: true, message: this.#dead.message });
    this.#waiters.clear();
    this.#child = null;
  }

  async request(operation, payload, budgetMs) {
    await this.#ensure();
    if (this.#dead !== null) throw new WorkerError("backend_failed", `Python bridge is dead: ${this.#dead.message}`, true);
    const requestId = randomUUID();
    const responsePromise = new Promise((resolveResponse) => this.#waiters.set(requestId, resolveResponse));
    this.#child.stdin.write(`${JSON.stringify({ operation, payload })}\n`);
    const timer = setTimeout(() => {
      this.#waiters.delete(requestId);
      resolveTimeout();
    }, Math.max(1, budgetMs));
    let resolveTimeout;
    const timeoutPromise = new Promise((_, reject) => { resolveTimeout = () => reject(new WorkerError("deadline", "semantic Python budget expired", true)); });
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

const bridge = new PythonBridge();
await serveWorker({
  kind: "semantic",
  upstreamCommit: UPSTREAM_COMMIT,
  handlers: {
    initialize: async (payload, context) => bridge.request("initialize", payload, context.remainingBudgetMs),
    symbol: async (payload, context) => bridge.request("symbol", payload, context.remainingBudgetMs),
    references: async (payload, context) => bridge.request("references", payload, context.remainingBudgetMs),
    overview: async (payload, context) => bridge.request("overview", payload, context.remainingBudgetMs),
  },
  dispose: async () => bridge.close(),
});
