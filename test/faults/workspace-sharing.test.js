import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
test("live other-process ownership errors carry the holder pid", async () => {
  const root = await workspace();
  const runtimeModule = new URL("../../packages/core/dist/workspace/runtime.js", import.meta.url).href;
  const script = `const { openWorkspaceRuntime } = await import(${JSON.stringify(runtimeModule)}); const runtime = await openWorkspaceRuntime({ sourceRoot: ${JSON.stringify(root)}, mode: "write" }); console.log(process.pid); process.stdin.once("data", async () => { await runtime.release(); process.exit(0); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  let holderPid;
  const exit = new Promise((resolve) => child.once("exit", resolve));
  try {
    holderPid = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; const line = output.split("\n")[0]; if (line) resolve(Number(line)); });
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(new Error(`lock holder exited with ${code}`)); });
    });
    await assert.rejects(
      () => openWorkspaceRuntime({ sourceRoot: root, mode: "write", lockRetryMs: 1 }),
      (error) => error.message === "workspace already owned by another process" && error.code === "WORKSPACE_OWNED" && error.holderPid === holderPid,
    );
  } finally {
    child.stdin.end("done\n");
    await exit;
    await clean(root);
  }
});
