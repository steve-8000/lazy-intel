import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(env = {}) {
  const child = spawn(process.execPath, [path.join(repo, "src/cli.js"), "serve"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LAZY_INTEL_AUTO_INDEX: "false", ...env },
  });
  const waiting = new Map();
  const wireFrames = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    wireFrames.push(line);
    const message = JSON.parse(line);
    const listeners = waiting.get(message.id);
    if (!listeners) return;
    waiting.delete(message.id);
    for (const resolve of listeners) resolve(message);
  });
  const waitFor = (id, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response ${id}`)), timeoutMs);
    const listeners = waiting.get(id) ?? [];
    listeners.push((message) => { clearTimeout(timer); resolve(message); });
    waiting.set(id, listeners);
  });
  const send = (message, timeoutMs) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return waitFor(message.id, timeoutMs);
  };
  return { child, rl, send, waitFor, wireFrames };
}

function stopServer(server) {
  server.rl.close();
  server.child.kill("SIGTERM");
}

async function workspace(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "source.mjs"), "export function searchable() { return 'needle'; }\n");
  return root;
}

test("MCP negotiates, frames, validates, and preserves stdio protocol behavior", async (t) => {
  const server = startServer();
  t.after(() => stopServer(server));

  const init = await server.send({
    jsonrpc: "2.0", id: 1, method: "initialize",
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
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "status", includeBody: "false" } },
  });
  assert.equal(invalidBoolean.error.code, -32602);

  const duplicate = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "code_intel", arguments: { operation: "status" } } };
  server.child.stdin.write(`${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`);
  const duplicateResponse = await server.waitFor(6, 30_000);
  assert.equal(duplicateResponse.error.code, -32600);
});

test("MCP tool output preserves the engine response budget as valid JSON text", async (t) => {
  const root = await workspace("lazy-intel-mcp-budget-");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const server = startServer({ LAZY_INTEL_ROOT: root, LAZY_INTEL_ALLOWED_ROOTS: root, LAZY_INTEL_MAINTENANCE_MS: "0" });
  t.after(() => stopServer(server));
  await server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });

  // A cold workspace now reports "building" instead of blocking a read past its
  // budget, so publish once explicitly before measuring the response envelope.
  await server.send({
    jsonrpc: "2.0", id: 99, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "search", root, query: "needle", freshness: "strict", maxChars: 4_000, timeoutMs: 120_000, indexTimeoutMs: 600_000 } },
  }, 900_000);

  const response = await server.send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "search", root, query: "needle", maxChars: 4_000, timeoutMs: 120_000, indexTimeoutMs: 600_000 } },
  }, 900_000);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  const text = response.result.content.filter((block) => block.type === "text").map((block) => block.text);
  assert.equal(text.length, 1, "structured sessions must not duplicate metadata in a text block");
  assert.ok(text.some((value) => value.includes("Status:") && value.includes("Limits:") && value.includes("Stop reason:")), "MCP text must retain complete headers");
  assert.ok(text.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) <= 4_000);
  assert.ok(response.result.structuredContent, "structured sessions must receive machine-readable metadata");
  const metadata = response.result.structuredContent;
  assert.ok(["ok", "partial", "empty"].includes(metadata.status));
  const wire = server.wireFrames.at(-1);
  assert.ok(wire, "the response must cross the actual stdio wire");
  assert.ok(Buffer.byteLength(wire + "\n", "utf8") <= 1_048_576, "MCP frame including newline exceeded the wire cap");
  assert.deepEqual(JSON.parse(wire), response);
  assert.ok(text.reduce((sum, value) => sum + value.length, 0) <= 4_000);
});

test("MCP legacy sessions retain metadata as a text block", { timeout: 900_000 }, async (t) => {
  const root = await workspace("lazy-intel-mcp-legacy-");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const server = startServer({ LAZY_INTEL_ROOT: root, LAZY_INTEL_ALLOWED_ROOTS: root, LAZY_INTEL_MAINTENANCE_MS: "0" });
  t.after(() => stopServer(server));
  await server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-test", version: "0" } } });
  await server.send({
    jsonrpc: "2.0", id: 99, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "search", root, query: "needle", freshness: "strict", maxChars: 4_000, timeoutMs: 120_000, indexTimeoutMs: 600_000 } },
  }, 900_000);
  const response = await server.send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "search", root, query: "needle", maxChars: 4_000, timeoutMs: 120_000, indexTimeoutMs: 600_000 } },
  }, 900_000);
  const text = response.result.content.filter((block) => block.type === "text").map((block) => block.text);
  assert.equal(text.length, 2);
  assert.ok(text[1].startsWith("{"), "legacy metadata remains a JSON text block");
  assert.equal(response.result.structuredContent, undefined);
  assert.doesNotThrow(() => JSON.parse(text[1]));
 });

test("MCP admits four active requests, queues thirty-two, then reports busy", { timeout: 900_000 }, async (t) => {
  const root = await workspace("lazy-intel-mcp-queue-");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const server = startServer({ LAZY_INTEL_ROOT: root, LAZY_INTEL_ALLOWED_ROOTS: root, LAZY_INTEL_MAINTENANCE_MS: "0" });
  t.after(() => stopServer(server));
  await server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });

  const requests = Array.from({ length: 37 }, (_, index) => ({
    jsonrpc: "2.0", id: index + 2, method: "tools/call",
    params: { name: "code_intel", arguments: { operation: "status", root, backend: "serena", maxChars: 4_000, timeoutMs: 120_000, indexTimeoutMs: 600_000 } },
  }));
  const responses = await Promise.all(requests.map((request) => server.send(request, 900_000)));
  const busy = responses.filter((response) => response.result?.structuredContent?.error?.code === "BUSY");
  assert.equal(busy.length, 1, `expected one queue admission rejection, got ${busy.length}`);
});
