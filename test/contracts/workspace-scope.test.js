import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const execFileAsync = promisify(execFile);
import { openWorkspaceRuntime } from "../../packages/core/dist/workspace/runtime.js";
import { captureWorkspaceSnapshot, discoverWorkspaceFiles } from "../../packages/core/dist/workspace/snapshots.js";

function childHoldingRoot(root) {
  const runtimePath = path.resolve("packages/core/dist/workspace/runtime.js");
  const script = `import { openWorkspaceRuntime } from ${JSON.stringify(runtimePath)}; await openWorkspaceRuntime({sourceRoot: process.argv[1], mode: "write"}); console.log("READY"); process.stdin.resume();`;
  return spawn(process.execPath, ["--input-type=module", "-e", script, root], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY")) resolve();
    });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== null && !output.includes("READY")) reject(new Error(`child exited ${code}: ${errorOutput}`)); });
  });
}

test("workspace scope separates source and state and canonical aliases share one owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-scope-"));
  await writeFile(path.join(root, "source.swift"), "func value() {}\n");
  const alias = `${root}-alias`;
  await symlink(root, alias);
  const child = childHoldingRoot(alias);
  try {
    await waitForReady(child);
    await assert.rejects(() => openWorkspaceRuntime({ sourceRoot: root, mode: "write" }), /already owned/);
  } finally {
    child.kill("SIGTERM");
    await rm(alias, { force: true });
  }
  const runtime = await openWorkspaceRuntime({ sourceRoot: root, mode: "write" });
  assert.notEqual(runtime.canonicalSourceRoot, runtime.canonicalStateRoot);
  assert.equal(path.basename(runtime.canonicalStateRoot), ".lazy-intel");
  await runtime.release();
  await rm(root, { recursive: true, force: true });
});

test("a lock whose holder is dead is reclaimed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-reclaim-"));
  await mkdir(path.join(root, ".lazy-intel", "runtime"), { recursive: true });
  await writeFile(path.join(root, "dead.txt"), "x");
  const lock = path.join(root, ".lazy-intel", "runtime", "workspace.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "holder.json"), JSON.stringify({ pid: 999999, token: "dead", sourceRoot: root, createdAt: new Date().toISOString() }));
  const runtime = await openWorkspaceRuntime({ sourceRoot: root, mode: "write" });
  assert.equal(runtime.canonicalSourceRoot, await realpath(root));
  await runtime.release();
  await rm(root, { recursive: true, force: true });
});

test("non-git nested ignore policy excludes files and invalidates the captured scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-ignore-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "nested", ".gitignore"), "drop.ts\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  await writeFile(path.join(root, "kept.ts"), "kept\n");
  await writeFile(path.join(root, "nested", "drop.ts"), "drop\n");
  await writeFile(path.join(root, "nested", "keep.ts"), "keep\n");
  const files = await discoverWorkspaceFiles(root);
  assert.equal(files.includes("ignored.txt"), false);
  assert.equal(files.includes("nested/drop.ts"), false);
  assert.equal(files.includes("nested/keep.ts"), true);
  const before = await captureWorkspaceSnapshot({ workspaceId: "workspace", sourceRoot: root, observedSeq: "1", parserProfileDigest: "parser", resolverProfileDigest: "resolver" });
  await rm(path.join(root, "nested", ".gitignore"));
  const after = await captureWorkspaceSnapshot({ workspaceId: "workspace", sourceRoot: root, observedSeq: "1", parserProfileDigest: "parser", resolverProfileDigest: "resolver" });
  assert.notEqual(before.manifest.id, after.manifest.id);
  assert.equal(after.sources.some((source) => source.relativePath === "nested/drop.ts"), true);
  await rm(root, { recursive: true, force: true });
});

test("nested TypeScript and JavaScript resolver configs invalidate captured scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-config-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "tsconfig.base.json"), '{"compilerOptions":{"baseUrl":"."}}');
  const options = { workspaceId: "workspace", sourceRoot: root, observedSeq: "1", parserProfileDigest: "parser", resolverProfileDigest: "resolver" };
  const initial = await captureWorkspaceSnapshot(options);
  await writeFile(path.join(root, "nested", "tsconfig.base.json"), '{"compilerOptions":{"baseUrl":"src"}}');
  const changed = await captureWorkspaceSnapshot(options);
  assert.notEqual(changed.manifest.scopeDigest, initial.manifest.scopeDigest);
  await writeFile(path.join(root, "nested", "jsconfig.json"), '{"compilerOptions":{"checkJs":true}}');
  const added = await captureWorkspaceSnapshot(options);
  assert.notEqual(added.manifest.scopeDigest, changed.manifest.scopeDigest);
  await rm(path.join(root, "nested", "jsconfig.json"));
  const deleted = await captureWorkspaceSnapshot(options);
  assert.equal(deleted.manifest.scopeDigest, changed.manifest.scopeDigest);
});

test("default state and runtime metadata reject symlink escape", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-state-escape-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "source");
  const outside = path.join(base, "outside");
  await mkdir(root); await mkdir(outside);
  await symlink(outside, path.join(root, ".lazy-intel"));
  await assert.rejects(openWorkspaceRuntime({ sourceRoot: root, mode: "write" }), /state.*symlink|state.*outside/);
  await rm(path.join(root, ".lazy-intel"));
  await mkdir(path.join(root, ".lazy-intel"));
  await symlink(outside, path.join(root, ".lazy-intel", "runtime"));
  await assert.rejects(openWorkspaceRuntime({ sourceRoot: root, mode: "write" }), /runtime.*symlink|runtime.*outside/);
});

test("prepared source transport rejects escaped directories and altered bytes", async (t) => {
  const { stagePreparedBatch, readPreparedBatch } = await import("../../packages/core/dist/runtime/prepared.js");
  const base = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-prepared-escape-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const state = path.join(base, "state");
  const outside = path.join(base, "outside");
  await mkdir(state); await mkdir(outside);
  const batch = { batchId: "batch", part: 0, final: true, manifestId: "manifest", sources: [], deletedPaths: [], full: true };
  await symlink(outside, path.join(state, ".prepared"));
  await assert.rejects(stagePreparedBatch(state, batch), /prepared.*symlink|prepared.*outside/);
  await rm(path.join(state, ".prepared"));
  const staged = await stagePreparedBatch(state, batch);
  await writeFile(staged.reference.path, JSON.stringify({ ...batch, full: false }));
  await assert.rejects(readPreparedBatch(state, staged.reference), /changed/);
  await staged.release();
});
test("workspace ignore policy filters tracked and walked vendor files and changes scope digest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-shared-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "vendor"));
  await writeFile(path.join(root, "keep.ts"), "keep\n");
  await writeFile(path.join(root, "vendor", "fork.ts"), "fork\n");
  await writeFile(path.join(root, ".lazy-intel-ignore"), "# pinned fork\nvendor/\n");
  const walked = await discoverWorkspaceFiles(root);
  assert.equal(walked.includes("vendor/fork.ts"), false);
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  const tracked = await discoverWorkspaceFiles(root);
  assert.equal(tracked.includes("vendor/fork.ts"), false);
  const before = await captureWorkspaceSnapshot({ workspaceId: "scope", sourceRoot: root, observedSeq: "1", parserProfileDigest: "p", resolverProfileDigest: "r" });
  await writeFile(path.join(root, ".lazy-intel-ignore"), "# pinned fork\nvendor/\nkeep.ts\n");
  const after = await captureWorkspaceSnapshot({ workspaceId: "scope", sourceRoot: root, observedSeq: "1", parserProfileDigest: "p", resolverProfileDigest: "r" });
  assert.notEqual(after.manifest.scopeDigest, before.manifest.scopeDigest);
  assert.equal(after.sources.some((source) => source.relativePath === "keep.ts"), false);
});
