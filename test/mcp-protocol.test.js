import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer() {
  const child = spawn(process.execPath, [path.join(repo, "src/cli.js"), "serve"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LAZY_INTEL_AUTO_INDEX: "false" },
  });
  const waiting = new Map();
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const listeners = waiting.get(message.id);
    if (!listeners) return;
    waiting.delete(message.id);
    for (const resolve of listeners) resolve(message);
  });
  const waitFor = (id, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response ${id}`)), timeoutMs);
    const listeners = waiting.get(id) ?? [];
    listeners.push((message) => { clearTimeout(timer); resolve(message); });
    waiting.set(id, listeners);
  });
  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return waitFor(message.id);
  };
  return { child, rl, send, waitFor };
}

test("MCP negotiates, frames, validates, and preserves stdio protocol behavior", async (t) => {
  const server = startServer();
  t.after(() => {
    server.rl.close();
    server.child.kill("SIGTERM");
  });

  const init = await server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.notEqual(init.result.protocolVersion, "2099-01-01");

  server.child.stdin.write(`${"x".repeat(256 * 1024 + 1)}\n`);
  const oversized = await server.waitFor(null);
  assert.equal(oversized.error.code, -32600);
  const afterOversized = await server.send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
  assert.deepEqual(afterOversized.result, {});

  server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const notificationFollowup = await server.send({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
  assert.equal(notificationFollowup.id, 3);

  const unknown = await server.send({ jsonrpc: "2.0", id: 4, method: "unknown/method", params: {} });
  assert.equal(unknown.error.code, -32601);

  const invalidBoolean = await server.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "status", includeBody: "false" } },
  });
  assert.equal(invalidBoolean.error.code, -32602);

  const duplicate = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "code_intel", arguments: { operation: "status" } } };
  server.child.stdin.write(`${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`);
  const duplicateResponse = await server.waitFor(6, 10000);
  assert.equal(duplicateResponse.error.code, -32600);
});
