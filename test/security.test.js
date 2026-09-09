import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/mcp/client.js";

const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-security-"));
const workspace = path.join(base, "workspace");
const outside = path.join(base, "workspace-outside");
const approved = path.join(base, "approved");
const home = path.join(base, "home");
for (const directory of [workspace, outside, approved, path.join(home, ".local/bin")]) await mkdir(directory, { recursive: true });
process.env.LAZY_INTEL_ROOT = workspace;
process.env.LAZY_INTEL_ALLOWED_ROOTS = approved;
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
process.env.LAZY_INTEL_MAX_ROOTS = "2";
process.env.ZVEC_GREP_HOME = path.join(base, "zvec-home");
const trusted = path.join(home, ".local/bin/serena");
await writeFile(trusted, `#!${process.execPath}\nconsole.log("trusted 1 symbols ready");\n`, { mode: 0o755 });
process.env.LAZY_INTEL_SERENA_BIN = trusted;
process.env.LAZY_INTEL_ZG_BIN = trusted;
process.env.LAZY_INTEL_CODEGRAPH_BIN = trusted;
const { codeIntel } = await import("../src/engine.js");
const { installOmp } = await import("../src/admin.js");
const { resolveBin, run } = await import("../src/lib/process.js");
const { indexStatus, closeIndexManager } = await import("../src/index-manager.js");
afterEach(() => closeIndexManager());
after(async () => { closeIndexManager(); await rm(base, { recursive: true, force: true }); });

async function directory(name) {
  const root = path.join(workspace, name);
  await mkdir(root, { recursive: true });
  return root;
}

test("repo cwd and PATH cannot select Serena; explicit absolute overrides are canonical", async () => {
  const root = await directory("malicious");
  const bin = path.join(root, "node_modules/.bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "serena"), `#!${process.execPath}\nconsole.log("hijacked");\n`, { mode: 0o755 });
  const previous = { cwd: process.cwd(), HOME: process.env.HOME, PATH: process.env.PATH };
  try {
    process.chdir(root); process.env.HOME = home; process.env.PATH = `${bin}${path.delimiter}${previous.PATH}`;
    delete process.env.LAZY_INTEL_SERENA_BIN;
    const executable = await resolveBin("serena");
    assert.equal((await run(executable)).stdout, "trusted 1 symbols ready");
    process.env.LAZY_INTEL_SERENA_BIN = "node_modules/.bin/serena";
    await assert.rejects(resolveBin("serena"), /absolute executable/);
    const alias = path.join(base, "installed-serena");
    await symlink(trusted, alias);
    process.env.LAZY_INTEL_SERENA_BIN = alias;
    assert.equal(await resolveBin("serena"), await realpath(trusted));
  } finally {
    process.chdir(previous.cwd);
    if (previous.HOME == null) delete process.env.HOME; else process.env.HOME = previous.HOME;
    process.env.PATH = previous.PATH;
    process.env.LAZY_INTEL_SERENA_BIN = trusted;
  }
});

test("request roots reject sibling prefixes and symlink escapes before indexing", async () => {
  const alias = path.join(workspace, "escape");
  await symlink(outside, alias);
  for (const root of [outside, alias]) {
    await assert.rejects(codeIntel({ operation: "reindex", root, backend: "codegraph" }), /outside allowed workspaces/);
  }
  await assert.rejects(access(path.join(outside, ".codegraph")), { code: "ENOENT" });
  const nested = await directory("nested");
  const inTree = path.join(workspace, "inside-link");
  await symlink(nested, inTree);
  const result = await codeIntel({ operation: "status", root: inTree, backend: "serena" });
  assert.equal(result.meta.root, await realpath(nested));
  assert.equal((await codeIntel({ operation: "status", root: approved, backend: "serena" })).meta.root, await realpath(approved));
});

test("source paths cannot escape a permitted root through traversal or symlinks", async () => {
  await writeFile(path.join(outside, "secret.js"), "export const secret = 1;");
  await symlink(path.join(outside, "secret.js"), path.join(workspace, "linked.js"));
  for (const relativePath of ["../workspace-outside/secret.js", "linked.js", path.join(outside, "secret.js")]) {
    await assert.rejects(codeIntel({ operation: "references", symbol: "secret", relativePath }), /inside the requested workspace/);
  }
});

test("engine rejects incomplete semantic contracts before starting a backend", async () => {
  await assert.rejects(codeIntel({ operation: "impact", query: "Foo change impact" }), /impact requires symbol/);
  await assert.rejects(codeIntel({ operation: "references", symbol: "Foo" }), /symbol and relativePath/);
  await assert.rejects(codeIntel({ operation: "diagnostics", query: "errors" }), /requires relativePath/);
});

test("canonical root aliases share watcher capacity and excess roots are refused", async () => {
  const first = await directory("watch-first"), second = await directory("watch-second"), third = await directory("watch-third");
  const alias = path.join(workspace, "watch-alias"); await symlink(first, alias);
  const initial = await indexStatus(first);
  assert.equal((await indexStatus(alias)).root, initial.root);
  await indexStatus(second);
  await assert.rejects(indexStatus(third), /workspace limit reached/);
  closeIndexManager();
  assert.equal((await indexStatus(third)).root, await realpath(third));
});

test("a partial repair failure is an MCP error, not a successful derived effect", async t => {
  const root = await directory("partial-repair");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const client = new StdioMcpClient(process.execPath, [cli, "serve"], {
    cwd: root, env: { LAZY_INTEL_ROOT: root, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_SERENA_BIN: path.join(base, "missing-serena") },
  });
  t.after(() => client.close());
  await client.start();
  const result = await client.callTool("code_intel", { operation: "repair", backend: "all", root });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.backends.map(row => [row.backend, row.ok]), [["zvec", true], ["codegraph", true], ["serena", false]]);
});

test("installer refuses malformed or unreadable configuration without replacing it", async () => {
  const root = await directory("invalid-config");
  const configDir = path.join(root, ".omp"); await mkdir(configDir);
  const configPath = path.join(configDir, "mcp.json");
  for (const content of ["{invalid", "null", "[]", '{"mcpServers":[]}']) {
    await writeFile(configPath, content);
    await assert.rejects(installOmp(root));
    assert.equal(await readFile(configPath, "utf8"), content);
  }
  await rm(configPath); await mkdir(configPath);
  await assert.rejects(installOmp(root));
  assert.equal((await stat(configPath)).isDirectory(), true);
});

test("installer atomically preserves other servers and settings with mode 0600", async () => {
  const root = await directory("atomic-config");
  const configDir = path.join(root, ".omp"); await mkdir(configDir);
  const configPath = path.join(configDir, "mcp.json");
  const original = { mcpServers: { unrelated: { command: "trusted-server" }, serena: { command: "standalone-serena" }, "zvec-grep": { command: "standalone-zvec" }, "lazy-intel": { env: { LAZY_INTEL_ALLOWED_ROOTS: approved } } }, disabledServers: ["unrelated"] };
  const text = JSON.stringify(original);
  await writeFile(configPath, text); await chmod(configPath, 0o644);
  const oldHandle = await open(configPath, "r");
  try {
    await installOmp(root);
    assert.equal(await oldHandle.readFile("utf8"), text, "open readers retain the complete original inode");
    const installed = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(installed.mcpServers.unrelated, original.mcpServers.unrelated);
    assert.ok(installed.disabledServers.includes("unrelated"));
    assert.deepEqual(Object.keys(installed.mcpServers).sort(), ["lazy-intel", "unrelated"]);
    assert.ok(["zvec-grep", "codegraph", "serena"].every(name => installed.disabledServers.includes(name)));
    assert.equal(installed.mcpServers["lazy-intel"].env.LAZY_INTEL_ALLOWED_ROOTS, approved);
    assert.equal(installed.mcpServers["lazy-intel"].env.LAZY_INTEL_SERENA_BIN, await realpath(trusted));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(configDir), ["mcp.json"]);
  } finally { await oldHandle.close(); }
});
