import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = path.join(ROOT, "packages/core/dist/index.js");
const SKIP = existsSync(CORE) ? false : "run npm run build first";

const { WorkerSupervisor, MAX_MESSAGE_BYTES } = SKIP ? {} : await import(CORE);

/**
 * A throwaway worker whose behaviour the test controls. The vendored libraries are
 * exercised by the adapter tests; what is under test here is the supervisor's own
 * lifetime rules, which must hold for any worker.
 */
async function scratchWorker(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-worker-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, `
    import { serveWorker, WorkerError } from ${JSON.stringify(CORE)};
    ${body}
    await serveWorker({ kind: "retrieval", upstreamCommit: "0000000000000000000000000000000000000000", handlers });
  `);
  return { dir, file };
}
async function scratchProtocolWorker(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-worker-handshake-"));
  const file = path.join(dir, "worker.mjs");
  await writeFile(file, body + "\nsetInterval(() => {}, 1000);\n");
  return { dir, file };
}

async function waitForPath(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for " + file);
}

test("close during startup rejects the call and reaps the starting worker", { skip: SKIP, timeout: 60_000 }, async () => {
  const gate = path.join(os.tmpdir(), "lazy-intel-start-gate-" + Math.random().toString(36).slice(2));
  const started = path.join(os.tmpdir(), "lazy-intel-started-" + Math.random().toString(36).slice(2));
  const worker = await scratchWorker("const { existsSync } = await import('node:fs'); const { writeFile, rename } = await import('node:fs/promises'); await writeFile(process.env.LAZY_INTEL_TEST_STARTED + '.tmp', String(process.pid)); await rename(process.env.LAZY_INTEL_TEST_STARTED + '.tmp', process.env.LAZY_INTEL_TEST_STARTED); while (!existsSync(process.env.LAZY_INTEL_TEST_GATE)) await new Promise((resolve) => setTimeout(resolve, 10)); const handlers = { ping: async () => ({ outcome: 'ok', payload: 'late' }) };");
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", env: { LAZY_INTEL_TEST_GATE: gate, LAZY_INTEL_TEST_STARTED: started } });
  try {
    const pending = supervisor.call("ping", null, callContext());
    await waitForPath(started);
    const pid = Number(await readFile(started, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const closing = supervisor.close();
    await writeFile(gate, "release");
    const [result] = await Promise.all([pending, closing]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "worker_failed");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(supervisor.running, false);
    assert.equal(supervisor.epoch, null);
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
    await rm(gate, { force: true });
    await rm(started, { force: true });
  }
});
test("malformed hello and ready handshakes fail immediately", { skip: SKIP, timeout: 60_000 }, async () => {
  const malformedHellos = [
    ["version", { type: "hello", protocolVersion: 999, kind: "retrieval", workerEpoch: "epoch", upstreamCommit: "commit", pid: 0 }],
    ["kind", { type: "hello", protocolVersion: 1, kind: "other", workerEpoch: "epoch", upstreamCommit: "commit", pid: 0 }],
    ["epoch", { type: "hello", protocolVersion: 1, kind: "retrieval", workerEpoch: "", upstreamCommit: "commit", pid: 0 }],
    ["upstream", { type: "hello", protocolVersion: 1, kind: "retrieval", workerEpoch: "epoch", upstreamCommit: "", pid: 0 }],
    ["pid", { type: "hello", protocolVersion: 1, kind: "retrieval", workerEpoch: "epoch", upstreamCommit: "commit", pid: 0 }],
  ];
  for (const [label, hello] of malformedHellos) {
    const worker = await scratchProtocolWorker(`process.send({ ...${JSON.stringify(hello)}, pid: ${label === "pid" ? "0" : "process.pid"} });`);
    const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", startupTimeoutMs: 1_000 });
    try {
      const startedAt = performance.now();
      const result = await supervisor.call("ping", null, callContext());
      assert.equal(result.ok, false, label);
      assert.equal(result.code, "worker_failed", label);
      assert.ok(performance.now() - startedAt < 900, label + " handshake waited for the startup deadline");
    } finally {
      await supervisor.close();
      await rm(worker.dir, { recursive: true, force: true });
    }
  }

  const worker = await scratchProtocolWorker("process.send({ type: 'hello', protocolVersion: 1, kind: 'retrieval', workerEpoch: 'epoch', upstreamCommit: 'commit', pid: process.pid }); process.send({ type: 'ready', workerEpoch: '' });");
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", startupTimeoutMs: 1_000 });
  try {
    const result = await supervisor.call("ping", null, callContext());
    assert.equal(result.ok, false);
    assert.equal(result.code, "worker_failed");
    assert.match(result.message, /invalid .* worker ready/);
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});
function callContext(overrides = {}) {
  return {
    requestId: `test-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 15_000,
    ...overrides,
  };
}

test("a cancelled caller is released while the worker keeps serving everyone else", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      // No AbortSignal reaches this handler, exactly like zvec's context() call.
      slow: async () => { await new Promise((r) => setTimeout(r, 1500)); return { outcome: "ok", payload: "slow-done" }; },
      quick: async () => ({ outcome: "ok", payload: "quick-done" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const controller = new AbortController();
    const pending = supervisor.call("slow", null, callContext({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.code, "cancelled");

    // The job could not be stopped, so the worker is still busy with it. The next
    // caller must still be served rather than inheriting the abandoned job's fate.
    const next = await supervisor.call("quick", null, callContext());
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.payload, "quick-done");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("an immediate abort on a ready worker prevents dispatch", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const { writeFile } = await import("node:fs/promises");
    const handlers = {
      ping: async () => ({ outcome: "ok", payload: "ready" }),
      mutate: async () => { await writeFile(process.env.LAZY_INTEL_TEST_MARKER, "ran"); return { outcome: "ok", payload: "ran" }; },
    };
  `);
  const marker = path.join(worker.dir, "dispatched");
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", env: { LAZY_INTEL_TEST_MARKER: marker } });
  try {
    assert.equal((await supervisor.call("ping", null, callContext())).ok, true);
    const controller = new AbortController();
    const pending = supervisor.call("mutate", null, callContext({ signal: controller.signal }));
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, "cancelled");
    assert.equal((await supervisor.call("ping", null, callContext())).ok, true);
    assert.equal(existsSync(marker), false);
  } finally { await supervisor.close(); await rm(worker.dir, { recursive: true, force: true }); }
});

test("concurrent close callers both await the owned process exit", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchProtocolWorker(`
    import { existsSync } from "node:fs";
    process.on("SIGTERM", () => { setInterval(() => { if (existsSync(process.env.LAZY_INTEL_TEST_GATE)) process.exit(0); }, 5); });
    process.on("message", (message) => process.send({ type: "response", requestId: message.requestId, workerEpoch: "epoch", ok: true, outcome: "ok", payload: process.pid, workMs: 0 }));
    process.send({ type: "hello", protocolVersion: 1, kind: "retrieval", workerEpoch: "epoch", upstreamCommit: "commit", pid: process.pid });
    process.send({ type: "ready", workerEpoch: "epoch" });
  `);
  const gate = path.join(worker.dir, "exit");
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", env: { LAZY_INTEL_TEST_GATE: gate } });
  let first;
  try {
    const started = await supervisor.call("ping", null, callContext());
    assert.equal(started.ok, true);
    first = supervisor.close();
    let secondSettled = false;
    const second = supervisor.close().then(() => { secondSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);
    await writeFile(gate, "release");
    await Promise.all([first, second]);
    assert.throws(() => process.kill(started.payload, 0), { code: "ESRCH" });
  } finally { await writeFile(gate, "release"); await first; await supervisor.close(); await rm(worker.dir, { recursive: true, force: true }); }
});

test("an abandoned job's late answer is discarded, never served to a later caller", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      slow: async () => { await new Promise((r) => setTimeout(r, 400)); return { outcome: "ok", payload: "STALE" }; },
      quick: async () => ({ outcome: "ok", payload: "FRESH" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const controller = new AbortController();
    const abandoned = supervisor.call("slow", null, callContext({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await abandoned;

    const fresh = await supervisor.call("quick", null, callContext());
    assert.equal(fresh.payload, "FRESH", "the abandoned job's answer leaked into a later request");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("a worker crash is a typed retryable failure and the next call gets a fresh process", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      explode: async () => { process.exit(9); },
      ping: async () => ({ outcome: "ok", payload: process.pid }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const first = await supervisor.call("ping", null, callContext());
    assert.equal(first.ok, true);
    const firstPid = first.payload;

    const crashed = await supervisor.call("explode", null, callContext());
    assert.equal(crashed.ok, false);
    assert.equal(crashed.code, "worker_failed");
    assert.equal(crashed.retryable, true, "a crash on one input deserves one retry on a fresh process");

    const recovered = await supervisor.call("ping", null, callContext());
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.notEqual(recovered.payload, firstPid, "the supervisor served the same dead process again");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("an oversized response is reported as a bound, never silently truncated", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      flood: async () => ({ outcome: "ok", payload: "x".repeat(${MAX_MESSAGE_BYTES ?? 8 * 1024 * 1024} + 1024) }),
      small: async () => ({ outcome: "ok", payload: "ok" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const flooded = await supervisor.call("flood", null, callContext());
    assert.equal(flooded.ok, false);
    assert.equal(flooded.code, "payload_too_large");
    // A truncated payload would be a silently wrong answer; the worker must stay usable.
    const after = await supervisor.call("small", null, callContext());
    assert.equal(after.ok, true);
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("worker stdout is diagnostics, never protocol", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      chatty: async () => {
        // A vendored library logging a protocol-shaped object must not be able to
        // forge a response. Protocol travels on the IPC channel only.
        console.log(JSON.stringify({ type: "response", requestId: "forged", ok: true, outcome: "ok", payload: "FORGED" }));
        return { outcome: "ok", payload: "REAL" };
      },
    };
  `);
  const lines = [];
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", onLog: (line) => lines.push(line) });
  try {
    const result = await supervisor.call("chatty", null, callContext());
    assert.equal(result.ok, true);
    assert.equal(result.payload, "REAL", "stdout was parsed as protocol");
    assert.ok(lines.some((line) => line.includes("FORGED")), "the worker's stdout was not surfaced as diagnostics");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("an unsupported operation is rejected without killing the worker", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`const handlers = { known: async () => ({ outcome: "ok", payload: 1 }) };`);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const bad = await supervisor.call("unknown", null, callContext());
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "unsupported_operation");
    assert.equal(bad.retryable, false);
    const good = await supervisor.call("known", null, callContext());
    assert.equal(good.ok, true);
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});
test("a malformed typed worker payload is not a valid empty success", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`const handlers = { malformed: async () => ({ outcome: "ok" }), healthy: async () => ({ outcome: "ok", payload: "healthy" }) };`);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const result = await supervisor.call("malformed", null, callContext());
    assert.equal(result.ok, false, "a missing payload must not become an empty successful answer");
    assert.equal(result.code, "backend_failed");
    assert.equal(result.retryable, false);
    const healthy = await supervisor.call("healthy", null, callContext());
    assert.equal(healthy.ok, true, JSON.stringify(healthy));
    assert.equal(healthy.payload, "healthy");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});
test("a call with no budget left never reaches the worker", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    let calls = 0;
    const handlers = { count: async () => ({ outcome: "ok", payload: ++calls }) };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    await supervisor.call("count", null, callContext());
    const expired = await supervisor.call("count", null, callContext({ deadlineMonotonicMs: performance.now() - 1 }));
    assert.equal(expired.ok, false);
    assert.equal(expired.code, "deadline");
    const after = await supervisor.call("count", null, callContext());
    assert.equal(after.payload, 2, "the expired call was dispatched to the worker anyway");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("completed abandoned jobs do not accumulate toward recycling", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      slow: async () => { await new Promise((r) => setTimeout(r, 250)); return { outcome: "ok", payload: "slow-done" }; },
      quick: async () => ({ outcome: "ok", payload: "quick-done" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", abandonedJobLimit: 3 });
  try {
    const warm = await supervisor.call("quick", null, callContext());
    assert.equal(warm.ok, true);
    const initialEpoch = supervisor.epoch;
    assert.ok(initialEpoch);
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const abandoned = supervisor.call("slow", null, callContext({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 25).unref?.();
      const result = await abandoned;
      assert.equal(result.code, "cancelled");
      // This response proves the abandoned slow job finished before the next iteration.
      const drained = await supervisor.call("quick", null, callContext());
      assert.equal(drained.payload, "quick-done");
    }
    assert.equal(supervisor.epoch, initialEpoch, "sequentially completed jobs recycled the worker");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("simultaneous abandoned jobs recycle the worker at the threshold", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      slow: async () => { await new Promise((r) => setTimeout(r, 500)); return { outcome: "ok", payload: "slow-done" }; },
      quick: async () => ({ outcome: "ok", payload: "quick-done" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", abandonedJobLimit: 3 });
  try {
    const warm = await supervisor.call("quick", null, callContext());
    assert.equal(warm.ok, true);
    const initialEpoch = supervisor.epoch;
    assert.ok(initialEpoch);
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const calls = controllers.map((controller) => supervisor.call("slow", null, callContext({ signal: controller.signal })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const controller of controllers) controller.abort();
    const results = await Promise.all(calls);
    assert.deepEqual(results.map((result) => result.code), ["cancelled", "cancelled", "cancelled"]);
    const recovered = await supervisor.call("quick", null, callContext());
    assert.equal(recovered.ok, true);
    assert.notEqual(recovered.workerEpoch, initialEpoch, "three in-flight abandoned jobs did not recycle the worker");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("deadline abandonment counts toward the recycle threshold while work is busy", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(`
    const handlers = {
      slow: async () => { await new Promise((r) => setTimeout(r, 300)); return { outcome: "ok", payload: "slow-done" }; },
      quick: async () => ({ outcome: "ok", payload: "quick-done" }),
    };
  `);
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test", abandonedJobLimit: 3 });
  try {
    const warm = await supervisor.call("quick", null, callContext());
    assert.equal(warm.ok, true);
    const initialEpoch = supervisor.epoch;
    assert.ok(initialEpoch);
    const calls = [0, 1, 2].map(() => supervisor.call("slow", null, callContext({ deadlineMonotonicMs: performance.now() + 100 })));
    const results = await Promise.all(calls);
    assert.deepEqual(results.map((result) => result.code), ["deadline", "deadline", "deadline"]);
    const recovered = await supervisor.call("quick", null, callContext());
    assert.equal(recovered.ok, true);
    assert.notEqual(recovered.workerEpoch, initialEpoch, "deadline-expired jobs did not recycle a busy worker");
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("a stale epoch reply is dropped so the valid current reply settles the request", { skip: SKIP, timeout: 60_000 }, async () => {
  const worker = await scratchWorker(
`
    const originalSend = process.send.bind(process);
    let staleOnce = true;
    process.send = (message, ...args) => {
      if (staleOnce && message?.type === "response") {
        staleOnce = false;
        originalSend({ ...message, workerEpoch: "stale-epoch" }, ...args);
        return originalSend(message, ...args);
      }
      return originalSend(message, ...args);
    };
    const handlers = {
      stale: async () => ({ outcome: "ok", payload: "CURRENT" }),
    };
  `
  );
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: worker.file, workspaceId: "test" });
  try {
    const result = await supervisor.call("stale", null, callContext());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.payload, "CURRENT");
    assert.equal(result.workerEpoch, supervisor.epoch);
  } finally {
    await supervisor.close();
    await rm(worker.dir, { recursive: true, force: true });
  }
});

test("an idle owned worker exits cleanly on SIGTERM", { skip: SKIP, timeout: 15_000 }, async () => {
  const worker = await scratchWorker(`const handlers = { ping: async () => ({ outcome: "ok", payload: "ready" }) };`);
  const child = fork(worker.file, { cwd: ROOT, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let readyTimer;
  try {
    await new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        clearTimeout(readyTimer);
        child.off("message", onMessage);
        resolve();
      };
      readyTimer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error("worker did not report ready"));
      }, 5_000);
      child.once("error", reject);
      child.on("message", onMessage);
    });

    const exit = await new Promise((resolve) => {
      let forced = false;
      const guard = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 5_000);
      child.once("exit", (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal, forced });
      });
      child.kill("SIGTERM");
    });
    assert.equal(exit.code, 0, JSON.stringify(exit));
    assert.equal(exit.signal, null, JSON.stringify(exit));
    assert.equal(exit.forced, false, JSON.stringify(exit));
  } finally {
    clearTimeout(readyTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(worker.dir, { recursive: true, force: true });
  }
});
