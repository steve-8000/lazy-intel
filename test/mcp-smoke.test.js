import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("stdio MCP exposes exactly one tool", async (t) => {
  const child = spawn(process.execPath, [path.join(repo, "src/cli.js"), "serve"], { cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LAZY_INTEL_AUTO_INDEX: "false" } });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiting = [];
  rl.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
  const send = (msg) => new Promise((resolve) => {
    waiting.push(resolve);
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  });
  const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.result.serverInfo.name, "lazy-intel");
  assert.equal(init.result.serverInfo.version, "0.2.0");
  const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((x) => x.name), ["code_intel"]);
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
});

// 회귀: 삭제된 allowed root 하나가 import 시점에 throw를 일으켜 서버가 initialize에
// 응답하기 전에 stdout을 닫았다. 클라이언트는 "MCP subprocess closed stdout before
// responding"만 보고 원인을 알 수 없었다. 잘못된 root는 경고 후 버려져야 한다.
test("a deleted or relative allowed root does not stop the server from serving", async () => {
  const missing = path.join(repo, "does-not-exist-allowed-root");
  const child = spawn(process.execPath, [path.join(repo, "src/cli.js"), "serve"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_ALLOWED_ROOTS: `${missing}${path.delimiter}relative/dir` },
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responded = new Promise((resolve) => rl.once("line", (line) => resolve(JSON.parse(line))));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`);
  const init = await responded;
  assert.equal(init.result.serverInfo.name, "lazy-intel");
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
});
