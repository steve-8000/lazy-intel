/**
 * The semantic worker talks to Python over a line protocol. Both tests here exist
 * because that protocol used to resolve whichever caller happened to be first in
 * the waiter map, which is only ever correct by accident.
 *
 * Note what cannot be tested from here: `serveWorker` serialises requests
 * (`queue = queue.then(...)`), so two semantic jobs are never in flight at once
 * and an out-of-order pair cannot be produced through the IPC path. The reachable
 * failures are a stale answer from a job the caller already abandoned, and a line
 * whose id matches nobody.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const worker = join(root, "workers/semantic/main.mjs");

// Stands in for the Python bridge via LAZY_INTEL_PYTHON, so neither Serena nor a
// language server is needed to exercise the protocol. It answers strictly in
// arrival order and never overlaps two jobs, because the real bridge is a
// single-threaded `for line in sys.stdin` loop: a request that arrives while a
// slow job is running cannot be answered before that job finishes. A fake that
// replied out of turn would make the collision untestable.
const FAKE_INTERPRETER = `#!/usr/bin/env node
import readline from "node:readline";

const emit = (requestId, payload) => process.stdout.write(JSON.stringify({ requestId, ok: true, payload }) + "\\n");
const queued = [];
let busyUntil = null;

function drain() {
  busyUntil = null;
  for (const request of queued.splice(0)) {
    if (request.payload?.marker === "unknown-first") emit("no-such-request", { marker: "stray" });
    emit(request.requestId, { marker: request.payload?.marker });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  queued.push(request);
  if (busyUntil !== null) return;
  // "slow" outlives the caller's budget and still finishes: the job Python cannot cancel.
  busyUntil = setTimeout(drain, request.payload?.marker === "slow" ? 120 : 0);
});
`;

async function fakePython() {
  const directory = await mkdtemp(join(tmpdir(), "lazy-semantic-correlation-"));
  const interpreter = join(directory, "fake-python.mjs");
  await writeFile(interpreter, FAKE_INTERPRETER);
  await chmod(interpreter, 0o755);
  return { directory, interpreter };
}

function startWorker(interpreter) {
  const child = fork(worker, [], {
    cwd: root,
    env: { ...process.env, LAZY_INTEL_PYTHON: interpreter },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
    serialization: "json",
  });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  return { child, messages };
}

async function waitFor(messages, predicate, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() - started >= timeoutMs) throw new Error("worker produced no matching message in time");
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

function ask(child, workerEpoch, requestId, marker, remainingBudgetMs) {
  child.send({ type: "request", requestId, workerEpoch, workspaceId: "ws", operation: "initialize", remainingBudgetMs, payload: { marker } });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((exited) => child.once("exit", exited));
}

test("an answer to an abandoned job never settles the next caller", async () => {
  const { directory, interpreter } = await fakePython();
  const { child, messages } = startWorker(interpreter);
  try {
    const ready = await waitFor(messages, (message) => message.type === "ready");

    ask(child, ready.workerEpoch, "A", "slow", 30);
    const abandoned = await waitFor(messages, (message) => message.requestId === "A");
    assert.equal(abandoned.code, "deadline");

    ask(child, ready.workerEpoch, "B", "fast", 2_000);
    const answer = await waitFor(messages, (message) => message.requestId === "B");
    assert.equal(answer.ok, true, JSON.stringify(answer));
    // The whole point: B's evidence must be B's. Handing it the abandoned job's
    // answer would attach one request's symbols to a different request.
    assert.deepEqual(answer.payload, { marker: "fast" });
  } finally {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a response whose id matches no caller is discarded, not handed to whoever is waiting", async () => {
  const { directory, interpreter } = await fakePython();
  const { child, messages } = startWorker(interpreter);
  try {
    const ready = await waitFor(messages, (message) => message.type === "ready");

    // The stray line is written before the real one, so a first-waiter dispatch
    // settles the caller with it. No timing involved: both lines are already sent.
    ask(child, ready.workerEpoch, "C", "unknown-first", 2_000);
    const answer = await waitFor(messages, (message) => message.requestId === "C");
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.payload, { marker: "unknown-first" });
  } finally {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});
