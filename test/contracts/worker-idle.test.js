import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = path.join(ROOT, "packages/core/dist/index.js");
const SKIP = existsSync(CORE) ? false : "run npm run build first";
const { WorkerSupervisor } = SKIP ? {} : await import(CORE);

async function scratchWorker(body, kind = "retrieval") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-worker-idle-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, `
    import { serveWorker } from ${JSON.stringify(CORE)};
    ${body}
    await serveWorker({ kind: ${JSON.stringify(kind)}, upstreamCommit: "0000000000000000000000000000000000000000", handlers });
  `);
  return { dir, file };
}

function callContext() {
  return {
    requestId: `idle-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
  };
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`worker ${pid} did not exit`);
}

async function withIdleWindow(fn) {
  const previous = process.env.LAZY_INTEL_WORKER_IDLE_MS;
  process.env.LAZY_INTEL_WORKER_IDLE_MS = "10000";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LAZY_INTEL_WORKER_IDLE_MS;
    else process.env.LAZY_INTEL_WORKER_IDLE_MS = previous;
  }
}

test("idle eviction exits the child and the next call starts a fresh worker without spending restart budget", { skip: SKIP, timeout: 60_000 }, async () => {
  await withIdleWindow(async () => {
    const worker = await scratchWorker(`const handlers = { ping: async () => ({ outcome: "ok", payload: process.pid }) };`);
    const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", maxRestarts: 0 });
    try {
      const first = await supervisor.call("ping", null, callContext());
      assert.equal(first.ok, true, JSON.stringify(first));
      const firstPid = first.payload;
      await waitForExit(firstPid, 15_000);
      assert.equal(supervisor.running, false);

      const second = await supervisor.call("ping", null, callContext());
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.notEqual(second.payload, firstPid);
    } finally {
      await supervisor.close();
      await rm(worker.dir, { recursive: true, force: true });
    }
  });
});

test("a call in flight prevents idle eviction", { skip: SKIP, timeout: 60_000 }, async () => {
  await withIdleWindow(async () => {
    const worker = await scratchWorker(`const handlers = { slow: async () => { await new Promise((resolve) => setTimeout(resolve, 10500)); return { outcome: "ok", payload: process.pid }; } };`);
    const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
    try {
      const pending = supervisor.call("slow", null, callContext());
      await new Promise((resolve) => setTimeout(resolve, 10_200));
      assert.equal(supervisor.inFlight, 1);
      assert.equal(supervisor.running, true);
      const result = await pending;
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      await supervisor.close();
      await rm(worker.dir, { recursive: true, force: true });
    }
  });
});

test("idle eviction terminates a semantic worker grandchild", { skip: SKIP, timeout: 60_000 }, async () => {
  await withIdleWindow(async () => {
    const worker = await scratchWorker(`
      import { spawn } from "node:child_process";
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      const handlers = { ping: async () => ({ outcome: "ok", payload: { workerPid: process.pid, grandchildPid: grandchild.pid } }) };
    `, "semantic");
    const supervisor = new WorkerSupervisor({ kind: "semantic", modulePath: worker.file, workspaceId: "test", maxRestarts: 0 });
    let grandchildPid = null;
    try {
      const first = await supervisor.call("ping", null, callContext());
      assert.equal(first.ok, true, JSON.stringify(first));
      const { workerPid, grandchildPid: startedGrandchildPid } = first.payload;
      grandchildPid = startedGrandchildPid;
      await waitForExit(workerPid, 15_000);
      await waitForExit(startedGrandchildPid, 5_000);
      assert.equal(supervisor.running, false);
    } finally {
      await supervisor.close();
      if (grandchildPid !== null) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      }
      await rm(worker.dir, { recursive: true, force: true });
    }
  });
});
