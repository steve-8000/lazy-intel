import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/mcp/client.js";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-cancel-"));
await writeFile(path.join(base, "package.json"), '{"type":"module"}\n');
await run("git", ["init", "--quiet", base]);
// A large source snapshot gives the owned retrieval worker real work to cancel;
// this is intentionally not a fake backend or a mocked MCP transport.
const newline = String.fromCharCode(10);
await writeFile(path.join(base, "large.mjs"), `${("// needle keeps this source searchable" + newline).repeat(250_000)}export const value = 1;${newline}`);

const serverEnv = {
  LAZY_INTEL_ROOT: base,
  LAZY_INTEL_ALLOWED_ROOTS: base,
  LAZY_INTEL_AUTO_INDEX: "false",
  LAZY_INTEL_MAINTENANCE_MS: "0",
  LAZY_INTEL_LSP: "",
};

async function client(t) {
  const c = new StdioMcpClient(process.execPath, [path.join(repo, "src/cli.js"), "serve"], {
    cwd: repo,
    env: serverEnv,
    timeoutMs: 120_000,
  });
  t.after(() => c.close());
  await c.start();
  return c;
}

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test("aborting an in-flight owned-worker MCP request leaves the connection usable", { timeout: 900_000 }, async (t) => {
  const c = await client(t);
  const controller = new AbortController();
  const pending = c.callTool("code_intel", {
    operation: "search",
    root: base,
    query: "needle",
    limit: 100,
    maxChars: 80_000,
    timeoutMs: 120_000,
    indexTimeoutMs: 600_000,
  }, { signal: controller.signal }).then(() => null, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  assert.equal((await pending).name, "AbortError");

  const ping = await c.request("ping", {});
  assert.deepEqual(ping, {}, "cancelling a request must not tear down the MCP connection");
});

test("a pre-aborted MCP request is rejected before dispatch", async (t) => {
  const c = await client(t);
  await assert.rejects(c.callTool("code_intel", {
    operation: "search", root: base, query: "needle",
  }, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(await c.request("ping", {}), {});
});
