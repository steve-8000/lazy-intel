import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const worker = join(root, "workers/semantic/main.mjs");
function startWorker(python) {
  const child = fork(worker, [], {
    cwd: root,
    env: { ...process.env, LAZY_INTEL_PYTHON: python },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
    serialization: "json",
  });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  return { child, messages };
}

async function waitFor(messages, predicate) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("worker response timeout");
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

test("semantic worker frames a real child and reports a dead interpreter as retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazy-semantic-"));
  const dead = join(directory, "dead-python");
  await writeFile(dead, "#!/bin/sh\nexit 17\n");
  await chmod(dead, 0o755);
  const { child, messages } = startWorker(dead);
  try {
    await waitFor(messages, (message) => message.type === "ready");
    child.send({ type: "request", requestId: "dead", workerEpoch: messages.find((m) => m.type === "ready").workerEpoch, workspaceId: "ws", operation: "initialize", remainingBudgetMs: 500, payload: { root, language: "python" } });
    const response = await waitFor(messages, (message) => message.requestId === "dead");
    assert.equal(response.ok, false);
    assert.equal(response.code, "backend_failed");
    assert.equal(response.retryable, true);
  } finally {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic worker enforces the parent budget around a real framed child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazy-semantic-"));
  const slow = join(directory, "slow-python");
  await writeFile(slow, "#!/bin/sh\nwhile read line; do sleep 1; echo '{\"ok\":true,\"payload\":{}}'; done\n");
  await chmod(slow, 0o755);
  const { child, messages } = startWorker(slow);
  try {
    await waitFor(messages, (message) => message.type === "ready");
    const epoch = messages.find((m) => m.type === "ready").workerEpoch;
    child.send({ type: "request", requestId: "budget", workerEpoch: epoch, workspaceId: "ws", operation: "initialize", remainingBudgetMs: 30, payload: { root, language: "python" } });
    const response = await waitFor(messages, (message) => message.requestId === "budget");
    assert.equal(response.ok, false);
    assert.equal(response.code, "deadline");
    assert.equal(response.retryable, true);
  } finally {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});
