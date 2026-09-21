import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/lib/process.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function killQuietly(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function waitDead(pid, allowanceMs = 1_500) {
  const started = Date.now();
  while (Date.now() - started < allowanceMs) {
    try {
      process.kill(pid, 0);
      await sleep(20);
    } catch {
      return Date.now() - started;
    }
  }
  return null;
}

function pidFrom(text) {
  return Number(String(text).split("\n", 1)[0]);
}

test("run decodes UTF-8 code points split across byte chunks", async () => {
  let pid;
  const script = `
    const bytes = Buffer.from("한글🙂");
    let index = 0;
    const write = () => {
      if (index === bytes.length) return;
      process.stdout.write(bytes.subarray(index, ++index), write);
    };
    process.stderr.write(String(process.pid));
    write();
  `;
  try {
    const result = await run(process.execPath, ["-e", script], { timeoutMs: 3_000 });
    pid = pidFrom(result.stderr);
    assert.equal(result.stdout, "한글🙂");
  } finally {
    killQuietly(pid);
  }
});

test("run preserves raw stdout indentation and trailing newline", async () => {
  let pid;
  const script = "process.stderr.write(String(process.pid)); process.stdout.write('  indented\\n')";
  try {
    const result = await run(process.execPath, ["-e", script], { timeoutMs: 3_000 });
    pid = pidFrom(result.stderr);
    assert.equal(result.stdout, "  indented\n");
  } finally {
    killQuietly(pid);
  }
});

test("abort escalates through SIGKILL and reaps a SIGTERM-resistant child", async () => {
  let pid;
  const controller = new AbortController();
  const script = "process.stdout.write(String(process.pid)+'\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  try {
    const pending = run(process.execPath, ["-e", script], { signal: controller.signal, timeoutMs: 10_000 });
    await sleep(80);
    controller.abort();
    const error = await pending.catch(value => value);
    assert.equal(error.name, "AbortError");
    pid = pidFrom(error.result.stdout);
    const elapsed = await waitDead(pid);
    assert.notEqual(elapsed, null);
    assert.ok(elapsed < 1_500, `child remained alive for ${elapsed}ms`);
    assert.equal(error.result.killedBy, "abort");
  } finally {
    killQuietly(pid);
  }
});

test("deadline timeout escalates through SIGKILL and reaps a SIGTERM-resistant child", async () => {
  let pid;
  const script = "process.stdout.write(String(process.pid)+'\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  try {
    const error = await run(process.execPath, ["-e", script], { timeoutMs: 100 }).catch(value => value);
    assert.match(error.message, /timed out/);
    pid = pidFrom(error.result.stdout);
    const elapsed = await waitDead(pid);
    assert.notEqual(elapsed, null);
    assert.ok(elapsed < 1_500, `child remained alive for ${elapsed}ms`);
    assert.equal(error.result.killedBy, "timeout");
    assert.equal(error.result.timedOut, true);
  } finally {
    killQuietly(pid);
  }
});

test("output overflow stops capture at the byte cap and terminates the child", async () => {
  let pid;
  const script = "process.stderr.write(String(process.pid)); process.stdout.write('x'.repeat(1024*1024)); setInterval(()=>{},1000)";
  try {
    const error = await run(process.execPath, ["-e", script], { timeoutMs: 3_000, maxOutputBytes: 1_024 }).catch(value => value);
    assert.match(error.message, /output exceeded/);
    pid = pidFrom(error.result.stderr);
    assert.equal(error.result.overflow, true);
    assert.ok(Buffer.byteLength(error.result.stdout) <= 1_024);
    const elapsed = await waitDead(pid);
    assert.notEqual(elapsed, null);
  } finally {
    killQuietly(pid);
  }
});
