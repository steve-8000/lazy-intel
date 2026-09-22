#!/usr/bin/env node
// Exercise installation and binary/state rollback only inside disposable roots.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StdioMcpClient } from "../src/mcp/client.js";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => process.argv.find((value) => value.startsWith(name + "="))?.slice(name.length + 1);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const report = { schema_version: 2, status: "FAIL", generated_at: new Date().toISOString(), scope: "temporary HOME, source roots, archived binary and derived state", phases: {}, rollback: { status: "NOT_RUN" }, user_config_mutated: false };

async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("verification deadline exceeded")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function close(client) {
  if (!client.child || client.child.exitCode !== null || client.child.signalCode !== null) return;
  const exited = new Promise((resolve) => client.child.once("close", resolve));
  client.close();
  let timer;
  try {
    timer = setTimeout(() => client.child.kill("SIGKILL"), 5000);
    await within(exited, 10000);
  } finally { clearTimeout(timer); }
}
async function withServer(entry, root, home, action) {
  const client = new StdioMcpClient(entry.command, entry.args, {
    cwd: entry.cwd ?? root, timeoutMs: 60000, name: "install-verification",
    env: { ...entry.env, HOME: home, LAZY_INTEL_ROOT: root, LAZY_INTEL_ALLOWED_ROOTS: root, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0", LAZY_INTEL_LOG: "off", HF_HUB_OFFLINE: "1", CODEGRAPH_NO_DOWNLOAD: "1" },
  });
  try {
    await within(client.start(), 10000);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["code_intel"]);
    return await action(client);
  } finally { await close(client); }
}
const input = (root) => ({ operation: "architecture", backend: "codegraph", root, query: "invoiceTotal", freshness: "strict", maxChars: 16000, timeoutMs: 60000, indexTimeoutMs: 60000 });
async function query(client, root, typed) {
  const result = await client.callTool("code_intel", input(root));
  const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.equal(result.isError, false, JSON.stringify(result));
  const metadata = result.structuredContent;
  assert.equal(metadata?.backends?.find((row) => row.backend === "codegraph")?.ok, true, JSON.stringify(result));
  assert.ok(text.includes("invoiceTotal") && text.includes("invoice.mjs"), "successful graph result must locate the known fixture symbol");
  if (typed) {
    const evidence = metadata.evidence.find((entry) => entry.anchor?.relativePath === "invoice.mjs");
    assert.ok(evidence, "candidate must return the fixture's canonical anchor");
    assert.equal(evidence.anchor.contentHash, hash(await readFile(path.join(root, "invoice.mjs"))));
    assert.equal(evidence.projectionView.state, "clean");
  }
  return { successful: true, evidenceFormat: typed ? "canonical-anchor" : "legacy-textual-locator", response: result };
}
async function digestTree(root) {
  assert.equal((await stat(root)).isDirectory(), true);
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push({ path: path.relative(root, file), sha256: hash(await readFile(file)) });
      else throw new Error("unexpected non-file in archived derived state: " + file);
    }
  }
  await visit(root);
  assert.ok(files.length > 0, "a missing/empty directory is not rollback state");
  return { sha256: hash(JSON.stringify(files)), files };
}
async function install(root, home, global) {
  await exec(process.execPath, [path.join(ROOT, "src/cli.js"), "install-omp", root, ...(global ? ["--global"] : [])], { cwd: ROOT, env: { ...process.env, HOME: home }, timeout: 30000 });
  const file = global ? path.join(home, ".omp/agent/mcp.json") : path.join(root, ".omp/mcp.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  return json(file);
}
async function fixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "discount.mjs"), "export function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
  await writeFile(path.join(root, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
}

const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "lazy-intel-install-")));
try {
  const home = path.join(scratch, "home");
  const rootA = path.join(scratch, "root-a");
  const rootB = path.join(scratch, "root-b");
  await Promise.all([fixture(rootA), fixture(rootB), mkdir(path.join(home, ".omp/agent"), { recursive: true })]);
  const configPath = path.join(home, ".omp/agent/mcp.json");
  const original = { mcpServers: { unrelated: { command: "/usr/bin/true", env: { KEEP: "yes" } } }, disabledServers: ["unrelated-disabled"], marker: "preserve" };
  await writeFile(configPath, JSON.stringify(original));
  const first = await install(rootA, home, true);
  assert.deepEqual(first.mcpServers.unrelated, original.mcpServers.unrelated);
  assert.equal(first.marker, original.marker);
  assert.deepEqual(Object.keys(first.mcpServers).sort(), ["lazy-intel", "unrelated"]);
  report.phases.install = { status: "PASS", oneCodeIntelligenceRegistration: true, preservedOtherServer: true, mode: "0600" };
  first.mcpServers["lazy-intel"].env.EXPLICIT_USER_SETTING = "preserve";
  first.mcpServers["lazy-intel"].env.LAZY_INTEL_SERENA_BIN = "/obsolete/serena";
  await writeFile(configPath, JSON.stringify(first));
  const upgraded = await install(rootB, home, true);
  assert.equal(upgraded.mcpServers["lazy-intel"].env.EXPLICIT_USER_SETTING, "preserve");
  assert.equal(upgraded.mcpServers["lazy-intel"].env.LAZY_INTEL_SERENA_BIN, undefined);
  assert.deepEqual(upgraded.mcpServers.unrelated, original.mcpServers.unrelated);
  assert.ok(upgraded.disabledServers.includes("unrelated-disabled"));
  report.phases.upgrade = { status: "PASS", explicitEnvironmentPreserved: true, obsoleteExecutableRemoved: true };
  const projectA = await install(rootA, home, false);
  const projectB = await install(rootB, home, false);
  assert.equal(projectA.mcpServers["lazy-intel"].cwd, rootA);
  assert.equal(projectB.mcpServers["lazy-intel"].cwd, rootB);
  report.phases.multiRoot = { status: "PASS", roots: [rootA, rootB], independentProjectRegistrations: true };
  const candidateEntry = upgraded.mcpServers["lazy-intel"];
  report.phases.realMcp = await withServer(candidateEntry, rootA, home, (client) => query(client, rootA, true));
  report.phases.abort = await withServer(projectB.mcpServers["lazy-intel"], rootB, home, async (client) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled installed MCP request");
    const pending = client.callTool("code_intel", input(rootB), { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(reason), 10);
    try { await assert.rejects(pending, (error) => error === reason); }
    finally { clearTimeout(timer); }
    assert.deepEqual(await client.request("ping"), {});
    const following = await query(client, rootB, true);
    return { status: "PASS", cancelledCaller: true, connectionReusable: true, following };
  });

  const baseline = flag("--old-source") ?? process.env.LAZY_INTEL_BASELINE_SOURCE ?? path.resolve(ROOT, "../lazy-intel-source-baselines/lazy-intel");
  const oldRelease = path.join(scratch, "old-release");
  await cp(baseline, oldRelease, { recursive: true });
  await symlink(path.join(ROOT, "node_modules"), path.join(oldRelease, "node_modules"), "dir");
  const oldEntry = { command: process.execPath, args: [path.join(oldRelease, "src/cli.js"), "serve"] };
  const oldState = path.join(rootA, ".codegraph");
  const backup = path.join(scratch, "old-state-backup");
  const oldBefore = await withServer(oldEntry, rootA, home, (client) => query(client, rootA, false));
  const before = await digestTree(oldState);
  await cp(oldState, backup, { recursive: true });
  const candidate = await withServer(candidateEntry, rootA, home, (client) => query(client, rootA, true));
  const afterCandidate = await digestTree(oldState);
  assert.equal(afterCandidate.sha256, before.sha256, "candidate must not migrate the archived old graph state");
  await rm(oldState, { recursive: true });
  await cp(backup, oldState, { recursive: true });
  const restored = await digestTree(oldState);
  assert.equal(restored.sha256, before.sha256);
  const oldAfter = await withServer(oldEntry, rootA, home, (client) => query(client, rootA, false));
  report.rollback = { status: "PASS", method: "restore archived old binary and actual .codegraph state after a successful candidate read", selector_switch_is_not_rollback: true, baseline_source: baseline, archived_binary_sha256: hash(await readFile(oldEntry.args[0])), old_state: oldState, candidate_state: path.join(rootA, ".lazy-intel"), before, afterCandidate, restored, oldBefore, candidate, oldAfter };
  report.status = "PASS";
} catch (error) {
  report.failure = String(error?.stack ?? error);
} finally {
  await rm(scratch, { recursive: true, force: true });
  const output = JSON.stringify(report, null, 2) + "\n";
  const destination = flag("--write");
  if (destination) await writeFile(path.resolve(ROOT, destination), output);
  process.stdout.write(output);
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
