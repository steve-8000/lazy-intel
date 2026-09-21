import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { openWorkspaceRuntime } from "../../packages/core/dist/workspace/runtime.js";

function childHoldingRoot(root) {
  const runtimePath = path.resolve("packages/core/dist/workspace/runtime.js");
  const script = `import { openWorkspaceRuntime } from ${JSON.stringify(runtimePath)}; await openWorkspaceRuntime({sourceRoot: process.argv[1]}); console.log("READY"); process.stdin.resume();`;
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
    await assert.rejects(() => openWorkspaceRuntime({ sourceRoot: root }), /already owned/);
  } finally {
    child.kill("SIGTERM");
    await rm(alias, { force: true });
  }
  const runtime = await openWorkspaceRuntime({ sourceRoot: root });
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
  const runtime = await openWorkspaceRuntime({ sourceRoot: root });
  assert.equal(runtime.canonicalSourceRoot, await realpath(root));
  await runtime.release();
  await rm(root, { recursive: true, force: true });
});
