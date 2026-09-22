import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readdir, realpath, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createDeadline } = await import("../../src/lib/deadline.js");
const unified = await import("../../src/unified.js");
const { PublicationCrash, PublicationNotReadable } = await import("../../packages/core/dist/workspace/publication.js");

const failurePoints = [
  "before-component-write",
  "after-component-write-before-ack",
  "after-ack-before-catalog-publication",
  "after-catalog-publication",
];

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-publication-live-"));
  await writeFile(path.join(root, "a.js"), "export function target() { return 1; }\n", "utf8");
  await writeFile(path.join(root, "b.js"), "import { target } from './a.js'; target();\n", "utf8");
  return realpath(root);
}

async function digestTree(root) {
  const files = [];
  async function visit(current, relative = "") {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (/(?:-wal|-shm|-journal)$/.test(entry.name)) continue;
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else files.push([childRelative, await readFile(child)]);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const [relative, bytes] of files) hash.update(relative).update("\0").update(bytes);
  return { sha256: hash.digest("hex"), files: files.map(([relative, bytes]) => ({ relative, bytes: bytes.byteLength })) };
}
async function clean(root) {
  await unified.closeUnified();
  await rm(root, { recursive: true, force: true });
}

async function status(root) {
  return unified.unifiedIndexStatus(root);
}

async function graphBatch(root) {
  const runtime = await unified.__internals.runtimeFor(root, "write");
  return runtime.publication.currentBatch("graph");
}

for (const failureAt of failurePoints) {
  test(`live unified publication recovers at ${failureAt}`, { timeout: 600_000 }, async () => {
    const root = await workspace();
    try {
      await unified.synchronizeWorkspace(root, ["codegraph"]);
      const old = await status(root);
      const oldStoreRoot = old.backends.codegraph.view.storeRoot;
      await writeFile(path.join(root, "a.js"), "export function target() { return 2; }\n", "utf8");

      const runtime = await unified.__internals.runtimeFor(root, "write");
      const publish = runtime.publication.publishBatch.bind(runtime.publication);
      runtime.publication.publishBatch = (batch, apply, options = {}) => publish(batch, apply, { ...options, failureAt });
      await assert.rejects(
        () => unified.synchronizeWorkspace(root, ["codegraph"]),
        (error) => error instanceof PublicationCrash && error.failurePoint === failureAt,
      );

      const interrupted = await status(root);
      if (failureAt === "after-catalog-publication") {
        assert.equal(interrupted.backends.codegraph.ready, true);
        assert.equal(interrupted.backends.codegraph.view.state, "clean");
        assert.equal(interrupted.backends.codegraph.view.storeRoot, oldStoreRoot);
      } else {
        assert.equal(interrupted.backends.codegraph.ready, false);
        assert.equal(interrupted.backends.codegraph.view.state, "needs_recovery");
      }

      await unified.closeUnified();
      await unified.synchronizeWorkspace(root, ["codegraph"]);
      const recovered = await status(root);
      assert.equal(recovered.backends.codegraph.ready, true);
      assert.equal(recovered.backends.codegraph.view.state, "clean");
      const batch = await graphBatch(root);
      assert.equal(batch.sources.filter((source) => source.relativePath === "a.js").length, 1);
      assert.equal(batch.sources.find((source) => source.relativePath === "a.js").content, "export function target() { return 2; }\n");
      assert.equal(new Set(batch.sources.map((source) => source.relativePath)).size, batch.sources.length);
    } finally {
      await clean(root);
    }
  });
}

test("a staged rebuild publishes into a distinct store and leaves the old store intact", { timeout: 600_000 }, async () => {
  const root = await workspace();
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    const before = await status(root);
    const oldStoreRoot = before.backends.codegraph.view.storeRoot;
    await unified.synchronizeWorkspace(root, ["codegraph"], { rebuild: true });
    const after = await status(root);
    const newStoreRoot = after.backends.codegraph.view.storeRoot;
    assert.notEqual(newStoreRoot, oldStoreRoot);
    assert.equal(after.backends.codegraph.ready, true);
    await access(oldStoreRoot);
    const oldStore = await stat(oldStoreRoot);
    assert.equal(oldStore.isDirectory(), true);
    await unified.closeUnified();
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    const reopened = await status(root);
    assert.equal(reopened.backends.codegraph.ready, true);
    assert.equal(reopened.backends.codegraph.view.storeRoot, newStoreRoot);
  } finally {
    await clean(root);
  }
});
test("a failed staged rebuild restores the operator backup and serves the old generation", { timeout: 600_000 }, async () => {
  const root = await workspace();
  const stateRoot = path.join(root, ".lazy-intel");
  const backup = path.join(path.dirname(root), path.basename(root) + "-operator-backup");
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    const before = await status(root);
    const oldStoreRoot = before.backends.codegraph.view.storeRoot;
    await unified.closeUnified();
    const oldGeneration = await digestTree(oldStoreRoot);
    await cp(stateRoot, backup, { recursive: true });
    const backupDigest = await digestTree(backup);
    await writeFile(path.join(root, "a.js"), "export function target() { return 99; }\n", "utf8");
    const runtime = await unified.__internals.runtimeFor(root, "write");
    const publish = runtime.publication.publishBatch.bind(runtime.publication);
    runtime.publication.publishBatch = (batch, apply, options = {}) => publish(batch, apply, { ...options, failureAt: "after-component-write-before-ack" });
    await assert.rejects(() => unified.synchronizeWorkspace(root, ["codegraph"], { rebuild: true }), PublicationCrash);
    assert.deepEqual(await digestTree(oldStoreRoot), oldGeneration, "failed candidate publication modified the old generation bytes");
    await unified.closeUnified();
    await rm(stateRoot, { recursive: true, force: true });
    await cp(backup, stateRoot, { recursive: true });
    assert.equal((await digestTree(stateRoot)).sha256, backupDigest.sha256, "operator restore did not restore the archived catalog/state");
    const restored = await status(root);
    assert.equal(restored.backends.codegraph.ready, true);
    assert.equal(restored.backends.codegraph.view.state, "clean");
    assert.equal(restored.backends.codegraph.view.storeRoot, oldStoreRoot);
    const deadline = createDeadline({ requestTimeoutMs: 120_000 });
    const input = { root, freshness: "fast", query: "target", operation: "context", limit: 5, maxChars: 8_000, timeoutMs: 30_000, indexTimeoutMs: 90_000 };
    const read = { backend: "codegraph", operation: "context" };
    const [settled] = await unified.unifiedStage([read], input, deadline, async (selected, lease) => unified.unifiedRead(selected, input, deadline, lease));
    assert.equal(settled.status, "fulfilled");
    assert.notEqual(settled.value.outcome, "error");
    assert.ok(settled.value.items?.some((item) => item.text.includes("target")), "restored old catalog was not queryable");
  } finally {
    await rm(backup, { recursive: true, force: true });
    await clean(root);
  }
});
test("strict staged read rejects a source changed after its read lease was pinned", { timeout: 600_000 }, async () => {
  const root = await workspace();
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    const deadline = createDeadline({ requestTimeoutMs: 120_000 });
    const input = { root, freshness: "strict", query: "target", operation: "context", limit: 5, timeoutMs: 30_000, indexTimeoutMs: 90_000 };
    const read = { backend: "codegraph", operation: "context" };
    const [settled] = await unified.unifiedStage([read], input, deadline, async (selected, lease) => {
      await writeFile(path.join(root, "a.js"), "export function target() { return 99; }\n", "utf8");
      return unified.unifiedRead(selected, input, deadline, lease);
    });
    assert.equal(settled.status, "rejected");
    assert.match(String(settled.reason?.message), /source_changed/);
  } finally {
    await clean(root);
  }
});

test("mixed graph and retrieval publication recovers a real multipart retrieval partial write", { timeout: 900_000 }, async () => {
  const root = await workspace();
  const large = (marker) => `// ${marker}\n` + "x".repeat(180_000) + "\n";
  try {
    for (let index = 0; index < 4; index += 1) await writeFile(path.join(root, `large-${index}.js`), large(`initial-${index}`), "utf8");
    await writeFile(path.join(root, "deleted.js"), "export const deleted = true;\n", "utf8");
    const projections = ["codegraph", "zvec"];
    await unified.synchronizeWorkspace(root, projections);
    const initial = await status(root);
    assert.equal(initial.backends.codegraph.ready, true);
    assert.equal(initial.backends.zvec.ready, true);
    const initialBatch = await unified.__internals.runtimeFor(root, "write").then((runtime) => runtime.publication.currentBatch("graph"));

    await writeFile(path.join(root, "large-0.js"), large("changed-0"), "utf8");
    for (let index = 0; index < 4; index += 1) await writeFile(path.join(root, `large-${index}.js`), large(`changed-${index}`), "utf8");
    await rm(path.join(root, "deleted.js"));
    const runtime = await unified.__internals.runtimeFor(root, "write");
    // Reads and applies are routed per store root, so a single supervisor is not a
    // stable interception point. Wrapping the pool catches whichever worker serves.
    const pool = runtime.retrievalPool;
    const originalAcquire = pool.acquire.bind(pool);
    const patched = new WeakSet();
    let retrievalApplies = 0;
    pool.acquire = (key) => {
      const supervisor = originalAcquire(key);
      if (patched.has(supervisor)) return supervisor;
      patched.add(supervisor);
      const originalCall = supervisor.call.bind(supervisor);
      supervisor.call = async (operation, ...args) => {
        const part = args[0]?.batchRef?.part;
        if (operation === "apply") {
          assert.ok(args[0]?.batchRef, "retrieval apply must use a staged batch reference");
          retrievalApplies += 1;
          if (part === 1) throw new Error("injected retrieval multipart failure");
        }
        return originalCall(operation, ...args);
      };
      return supervisor;
    };
    await assert.rejects(() => unified.synchronizeWorkspace(root, projections), /injected retrieval multipart failure|retrieval worker exited/);
    assert.ok(retrievalApplies >= 2);
    await assert.rejects(
      () => runtime.publication.read(["graph", "retrieval"]),
      (error) => error instanceof PublicationNotReadable && error.code === "needs_recovery",
    );

    await unified.closeUnified();
    await unified.synchronizeWorkspace(root, projections);
    const recovered = await status(root);
    assert.equal(recovered.backends.codegraph.ready, true);
    assert.equal(recovered.backends.zvec.ready, true);
    assert.equal(recovered.backends.codegraph.view.state, "clean");
    assert.equal(recovered.backends.zvec.view.state, "clean");
    assert.equal(recovered.backends.codegraph.view.appliedManifestId, recovered.backends.zvec.view.appliedManifestId);
    assert.equal(recovered.backends.codegraph.view.storeRoot, recovered.backends.zvec.view.storeRoot);
    const finalRuntime = await unified.__internals.runtimeFor(root, "write");
    const graph = finalRuntime.publication.currentBatch("graph");
    const retrieval = finalRuntime.publication.currentBatch("retrieval");
    assert.equal(graph.manifestId, retrieval.manifestId);
    assert.equal(graph.sources.some((source) => source.relativePath === "deleted.js"), false);
    assert.equal(retrieval.sources.some((source) => source.relativePath === "deleted.js"), false);
    assert.notEqual(graph.sources.find((source) => source.relativePath === "large-0.js").contentHash, initialBatch.sources.find((source) => source.relativePath === "large-0.js").contentHash);
    assert.deepEqual(graph.sources.map((source) => source.relativePath), retrieval.sources.map((source) => source.relativePath));
  } finally {
    await clean(root);
  }
});
test("a profile-mismatched pending publication is abandoned before a fresh capture", { timeout: 600_000 }, async () => {
  const root = await workspace();
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    await writeFile(path.join(root, ".lazy-intel-ignore"), "b.js\n", "utf8");
    const runtime = await unified.__internals.runtimeFor(root, "write");
    const publish = runtime.publication.publishBatch.bind(runtime.publication);
    runtime.publication.publishBatch = (batch, apply, options = {}) => publish(batch, apply, { ...options, failureAt: "before-component-write" });
    await assert.rejects(() => unified.synchronizeWorkspace(root, ["codegraph"]), /injected publication crash/);
    runtime.publication.publishBatch = publish;
    await writeFile(path.join(root, ".lazy-intel-ignore"), "a.js\n", "utf8");

    const result = await unified.synchronizeWorkspace(root, ["codegraph"]);
    const current = await status(root);
    assert.equal(result[0].ready, true);
    assert.equal(current.backends.codegraph.ready, true);
    assert.equal(current.needsRecovery, false);
    const batch = await graphBatch(root);
    assert.equal(batch.sources.some((source) => source.relativePath === "a.js"), false);
    assert.equal(batch.sources.some((source) => source.relativePath === "b.js"), true);
  } finally { await clean(root); }
});

test("a failed roll-forward is abandoned so unified publication can proceed", { timeout: 600_000 }, async () => {
  const root = await workspace();
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    await writeFile(path.join(root, "a.js"), "export function target() { return 2; }\n", "utf8");
    const runtime = await unified.__internals.runtimeFor(root, "write");
    const publish = runtime.publication.publishBatch.bind(runtime.publication);
    runtime.publication.publishBatch = (batch, apply, options = {}) => publish(batch, apply, { ...options, failureAt: "before-component-write" });
    await assert.rejects(() => unified.synchronizeWorkspace(root, ["codegraph"]), /injected publication crash/);
    runtime.publication.publishBatch = publish;
    const recover = runtime.publication.recover.bind(runtime.publication);
    runtime.publication.recover = () => recover(async () => { throw new Error("injected roll-forward failure"); });

    const result = await unified.synchronizeWorkspace(root, ["codegraph"]);
    runtime.publication.recover = recover;
    assert.equal(result[0].ready, true);
    assert.equal((await status(root)).backends.codegraph.ready, true);
    assert.equal((await graphBatch(root)).sources.find((source) => source.relativePath === "a.js").content, "export function target() { return 2; }\n");
  } finally { await clean(root); }
});
test("an idle unified writer releases ownership for another process", { timeout: 600_000 }, async () => {
  const root = await workspace();
  const previousIdle = process.env.LAZY_INTEL_WRITER_IDLE_MS;
  process.env.LAZY_INTEL_WRITER_IDLE_MS = "50";
  try {
    await unified.synchronizeWorkspace(root, ["codegraph"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runtimeModule = new URL("../../packages/core/dist/workspace/runtime.js", import.meta.url).href;
    const script = `const { openWorkspaceRuntime } = await import(${JSON.stringify(runtimeModule)}); const runtime = await openWorkspaceRuntime({ sourceRoot: ${JSON.stringify(root)}, mode: "write", lockRetryMs: 1 }); await runtime.release();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
    assert.equal(exitCode, 0);
  } finally {
    if (previousIdle === undefined) delete process.env.LAZY_INTEL_WRITER_IDLE_MS;
    else process.env.LAZY_INTEL_WRITER_IDLE_MS = previousIdle;
    await clean(root);
  }
});
