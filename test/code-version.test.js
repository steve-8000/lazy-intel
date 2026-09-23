import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codeIsStale, startCodeVersionMonitor } from "../src/lib/code-version.js";

async function tempRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-code-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "loaded.js");
  await writeFile(file, "export const version = 1;\n");
  return { directory, file };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for code version monitor");
    await pause(5);
  }
}

test("changed loaded code marks stale and restarts after the idle quiet window", async (t) => {
  const { directory, file } = await tempRoot(t);
  let restarts = 0;
  const monitor = await startCodeVersionMonitor({ roots: [directory], quietMs: 45, debounceMs: 5, onRestart: (code) => { assert.equal(code, 0); restarts += 1; } });
  t.after(() => monitor.stop());
  await writeFile(file, "export const version = 2;\n");
  await waitFor(() => monitor.stale);
  await waitFor(() => restarts === 1);
  assert.equal(codeIsStale(), true);
});

test("an active request postpones restart until the server is idle", async (t) => {
  const { directory, file } = await tempRoot(t);
  let busy = true;
  let restarts = 0;
  const monitor = await startCodeVersionMonitor({ roots: [directory], quietMs: 35, debounceMs: 5, getBusy: () => busy, onRestart: (code) => { assert.equal(code, 0); restarts += 1; } });
  t.after(() => monitor.stop());
  await writeFile(file, "export const version = 3;\n");
  await waitFor(() => monitor.stale);
  await pause(90);
  assert.equal(restarts, 0);
  busy = false;
  await waitFor(() => restarts === 1);
});

test("a reverted on-disk fingerprint never triggers restart", async (t) => {
  const { directory, file } = await tempRoot(t);
  const originalStat = await stat(file);
  let busy = true;
  let restarts = 0;
  const monitor = await startCodeVersionMonitor({ roots: [directory], quietMs: 35, debounceMs: 5, getBusy: () => busy, onRestart: () => { restarts += 1; } });
  t.after(() => monitor.stop());
  await writeFile(file, "export const version = 2;\n");
  await waitFor(() => monitor.stale);
  await writeFile(file, "export const version = 1;\n");
  await utimes(file, originalStat.atimeMs / 1_000, originalStat.mtimeMs / 1_000);
  assert.equal((await stat(file)).size, originalStat.size);
  assert.equal((await stat(file)).mtimeMs, originalStat.mtimeMs);
  busy = false;
  await pause(120);
  await waitFor(() => !monitor.stale);
  assert.equal(codeIsStale(), false);
  assert.equal(restarts, 0);
});

test("a stale worker supervisor refuses a new process with a retryable failure", async (t) => {
  const { WorkerSupervisor, pauseWorkerStarts, resumeWorkerStarts } = await import("../packages/core/dist/index.js");
  pauseWorkerStarts("lazy-intel code changed on disk; worker startup is paused until the server reconnects");
  t.after(() => resumeWorkerStarts());
  const supervisor = new WorkerSupervisor({ kind: "retrieval", modulePath: path.join(os.tmpdir(), "must-not-spawn.mjs"), workspaceId: "test" });
  t.after(() => supervisor.close());
  const result = await supervisor.call("search", {}, { requestId: "stale-test", signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.message, /code changed on disk/);
  assert.equal(supervisor.running, false);
});
