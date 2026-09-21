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
