import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWorkspaceRuntime } from "../packages/core/dist/workspace/runtime.js";

const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-security-"));
const workspace = path.join(base, "workspace");
const outside = path.join(base, "workspace-outside");
const approved = path.join(base, "approved");
for (const directory of [workspace, outside, approved]) await mkdir(directory, { recursive: true });
process.env.LAZY_INTEL_ROOT = workspace;
process.env.LAZY_INTEL_ALLOWED_ROOTS = approved;
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
process.env.LAZY_INTEL_MAX_ROOTS = "2";
process.env.ZVEC_GREP_HOME = path.join(base, "zvec-home");
const { codeIntel } = await import("../src/engine.js");
const { installOmp } = await import("../src/admin.js");
const { closeUnified } = await import("../src/unified.js");
const { indexStatus, closeIndexManager } = await import("../src/index-manager.js");
afterEach(async () => { closeIndexManager(); await closeUnified(); });
after(async () => { closeIndexManager(); await closeUnified(); await rm(base, { recursive: true, force: true }); });

async function directory(name) {
  const root = path.join(workspace, name);
  await mkdir(root, { recursive: true });
  return root;
}

test("source and state identities cannot be confused across workspaces", async () => {
  const first = await directory("state-first");
  const second = await directory("state-second");
  const stateRoot = path.join(base, "shared-state");
  const runtime = await openWorkspaceRuntime({ sourceRoot: first, stateRoot });
  try {
    assert.equal(runtime.canonicalSourceRoot, await realpath(first));
    assert.equal(runtime.canonicalStateRoot, await realpath(stateRoot));
    assert.notEqual(runtime.canonicalSourceRoot, runtime.canonicalStateRoot);
  } finally {
    await runtime.release();
  }
  await assert.rejects(
    () => openWorkspaceRuntime({ sourceRoot: second, stateRoot }),
    /workspace identity mismatch/,
  );
});

test("request roots reject sibling prefixes and symlink escapes before indexing", async () => {
  const alias = path.join(workspace, "escape");
  await symlink(outside, alias);
  for (const root of [outside, alias]) {
    await assert.rejects(codeIntel({ operation: "reindex", root, backend: "codegraph" }), /outside allowed workspaces/);
  }
  await assert.rejects(stat(path.join(outside, ".codegraph")), { code: "ENOENT" });
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

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportedRuntime = (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5)) && nodeMajor < 25;

test("installer refuses to record an unsupported runtime", { skip: supportedRuntime && "runtime is inside the supported range" }, async () => {
  const root = await directory("unsupported-runtime");
  await assert.rejects(installOmp(root), /requires >=22\.5 <25/);
});

test("installer atomically preserves other servers and settings with mode 0600", { skip: !supportedRuntime && `Node ${process.version} is outside the supported engine range` }, async () => {
  const root = await directory("atomic-config");
  const configDir = path.join(root, ".omp"); await mkdir(configDir);
  const configPath = path.join(configDir, "mcp.json");
  const original = { mcpServers: { unrelated: { command: "trusted-server" }, serena: { command: "standalone-serena" }, "zvec-grep": { command: "standalone-zvec" }, lazy: { env: { LAZY_INTEL_ALLOWED_ROOTS: approved } } }, disabledServers: ["unrelated"] };
  const text = JSON.stringify(original);
  await writeFile(configPath, text); await chmod(configPath, 0o644);
  const oldHandle = await open(configPath, "r");
  try {
    await installOmp(root);
    assert.equal(await oldHandle.readFile("utf8"), text, "open readers retain the complete original inode");
    const installed = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(installed.mcpServers.unrelated, original.mcpServers.unrelated);
    assert.ok(installed.disabledServers.includes("unrelated"));
    assert.deepEqual(Object.keys(installed.mcpServers).sort(), ["lazy", "lazy-intel", "unrelated"]);
    assert.ok(["zvec-grep", "codegraph", "serena"].every((name) => installed.disabledServers.includes(name)));
    assert.equal(installed.mcpServers.lazy["env"].LAZY_INTEL_ALLOWED_ROOTS, approved);
    assert.equal(Object.hasOwn(installed.mcpServers["lazy-intel"].env, "LAZY_INTEL_ZVEC_MODE"), false);
    assert.equal(Object.hasOwn(installed.mcpServers["lazy-intel"].env, "LAZY_INTEL_SERENA_CONTEXT"), false);
    assert.equal(Object.hasOwn(installed.mcpServers["lazy-intel"].env, "LAZY_INTEL_SERENA_BIN"), false);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(configDir)).sort(), ["mcp.json"]);
  } finally { await oldHandle.close(); }
});
