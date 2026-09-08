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
