import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { openWorkspaceRuntime } = await import("../../packages/core/dist/workspace/runtime.js");

async function workspace() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "lazy-intel-workspace-sharing-")));
}

async function clean(root) {
  await rm(root, { recursive: true, force: true });
}

test("read runtimes share a workspace while publication ownership remains exclusive", async () => {
  const root = await workspace();
  const owner = await openWorkspaceRuntime({ sourceRoot: root, mode: "write" });
  const firstReader = await openWorkspaceRuntime({ sourceRoot: root, mode: "read" });
  const secondReader = await openWorkspaceRuntime({ sourceRoot: root, mode: "read" });
  try {
    assert.equal(firstReader.mode, "read");
    assert.equal(secondReader.mode, "read");
    assert.throws(() => firstReader.assertWritable(), /read-mode workspace runtime cannot publish/);
    assert.doesNotThrow(() => owner.assertWritable());
    await assert.rejects(
      () => openWorkspaceRuntime({ sourceRoot: root, mode: "write", lockRetryMs: 1 }),
      /workspace already owned by (?:this|another) process/,
    );
  } finally {
    await Promise.all([secondReader.release(), firstReader.release(), owner.release()]);
    await clean(root);
  }
});

test("a dead write holder is reclaimed", async () => {
  const root = await workspace();
  const stateRoot = path.join(root, ".lazy-intel");
  const lockPath = path.join(stateRoot, "runtime", "workspace.lock");
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "holder.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-holder",
    sourceRoot: root,
    sourceIdentity: "dead-holder-source",
  }), "utf8");
  const runtime = await openWorkspaceRuntime({ sourceRoot: root, mode: "write", lockRetryMs: 1 });
  try {
    const holder = JSON.parse(await readFile(path.join(stateRoot, "runtime", "workspace.lock", "holder.json"), "utf8"));
    assert.equal(holder.pid, process.pid);
    assert.equal(runtime.mode, "write");
  } finally {
    await runtime.release();
    await clean(root);
  }
});
