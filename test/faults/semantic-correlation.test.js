/**
 * The semantic worker talks to Python over a line protocol. These tests exist
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
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const emit = (requestId, payload) => process.stdout.write(JSON.stringify({ requestId, ok: true, payload }) + "\\n");
const barrier = process.env.LAZY_SEMANTIC_BARRIER;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const marker = request.payload?.marker;
  if (marker === "slow") {
    // Record A's bridge id; B will replay this stale answer only after A's
    // deadline has reached the caller.
    writeFileSync(barrier + ".abandoned-id", request.requestId);
    return;
  }
  if (marker === "fragment") {
    // Leave an unterminated JSON record in the old bridge stdout buffer.
    process.stdout.write('{"requestId":"partial"');
    return;
  }
  if (marker === "fast-fragment") {
    emit(request.requestId, { marker });
    return;
  }
  if (marker === "fast") {
    writeFileSync(barrier + ".b-seen", "");
    const abandonedId = readFileSync(barrier + ".abandoned-id", "utf8");
    emit(abandonedId, { marker: "slow" });
    emit(request.requestId, { marker });
    return;
  }
  if (marker === "unknown-first") emit("no-such-request", { marker: "stray" });
  emit(request.requestId, { marker });
});
`;

async function fakePython() {
  const directory = await mkdtemp(join(tmpdir(), "lazy-semantic-correlation-"));
  const interpreter = join(directory, "fake-python.mjs");
  const barrier = join(directory, "barrier");
  await writeFile(interpreter, FAKE_INTERPRETER);
  await chmod(interpreter, 0o755);
  return { directory, interpreter, barrier };
}

function startWorker(interpreter, barrier) {
  const child = fork(worker, [], {
    cwd: root,
    env: { ...process.env, LAZY_INTEL_PYTHON: interpreter, LAZY_SEMANTIC_BARRIER: barrier },
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
  const { directory, interpreter, barrier } = await fakePython();
  const { child, messages } = startWorker(interpreter, barrier);
  try {
    const ready = await waitFor(messages, (message) => message.type === "ready");

    // Prime the bridge so the abandoned request is processed before its deadline.
    ask(child, ready.workerEpoch, "P", "prime", 2_000);
    const primed = await waitFor(messages, (message) => message.requestId === "P");
    assert.equal(primed.ok, true, JSON.stringify(primed));
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
test("a partial response from a recycled bridge cannot poison the next generation", async () => {
  const { directory, interpreter, barrier } = await fakePython();
  const { child, messages } = startWorker(interpreter, barrier);
  try {
    const ready = await waitFor(messages, (message) => message.type === "ready");

    // Prime the bridge before writing the partial line so startup cannot race A's deadline.
    ask(child, ready.workerEpoch, "P", "prime", 2_000);
    const primed = await waitFor(messages, (message) => message.requestId === "P");
    assert.equal(primed.ok, true, JSON.stringify(primed));

    ask(child, ready.workerEpoch, "A", "fragment", 30);
    const abandoned = await waitFor(messages, (message) => message.requestId === "A");
    assert.equal(abandoned.code, "deadline");

    ask(child, ready.workerEpoch, "B", "fast-fragment", 2_000);
    const answer = await waitFor(messages, (message) => message.requestId === "B");
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.payload, { marker: "fast-fragment" });
  } finally {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a response whose id matches no caller is discarded, not handed to whoever is waiting", async () => {
  const { directory, interpreter, barrier } = await fakePython();
  const { child, messages } = startWorker(interpreter, barrier);
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
