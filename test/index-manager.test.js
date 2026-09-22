import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
const DENIED_HOME = path.join(os.tmpdir(), "lazy-intel-denied-home");
process.env.OMP_HOME = DENIED_HOME;

const { ensureIndexes, indexStatus, isDeniedRoot, syncIndexes, reindexIndexes, observeIndexState, closeIndexManager } =
  await import("../src/index-manager.js");
const { closeUnified } = await import("../src/unified.js");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-index-"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "main.js"), "export function hello() { return 1; }\n");
  await writeFile(path.join(root, "caller.js"), "import { hello } from './main.js'; hello();\n");
  t.after(async () => {
    closeIndexManager();
    await closeUnified();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function waitFor(read, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return value;
}

test("publication catalog is the readiness oracle for an embedded graph worker", async (t) => {
  const root = await fixture(t);
  const before = await indexStatus(root);
  assert.equal(before.backends.codegraph.ready, false);
  assert.equal(before.backends.codegraph.baseline, "unverified");

  const [row] = await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  assert.equal(row.ok, true, JSON.stringify(row));
  assert.equal(row.ready, true);

  const status = await indexStatus(root);
  assert.equal(status.backends.codegraph.ready, true);
  assert.equal(status.backends.codegraph.view.state, "clean");
  assert.equal(status.backends.codegraph.baseline, "applied");
  assert.equal(status.backends.codegraph.dirty, false);
  assert.equal(status.needsRecovery, false);

  const catalog = JSON.parse(await readFile(path.join(root, ".lazy-intel/runtime/publication-catalog.json"), "utf8"));
  assert.equal(catalog.views.graph.state, "clean");
  assert.equal(catalog.views.graph.appliedManifestId, status.backends.codegraph.view.appliedManifestId);
});

test("an unchanged workspace reuses the published graph view", async (t) => {
  const root = await fixture(t);
  const [first] = await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  const initial = await indexStatus(root);
  const [second] = await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  const settled = await indexStatus(root);

  assert.equal(first.action, "rebuilt");
  assert.equal(second.action, "ready");
  assert.equal(second.dirty, false);
  assert.equal(settled.backends.codegraph.view.viewId, initial.backends.codegraph.view.viewId);
  assert.equal(settled.backends.codegraph.view.storeRoot, initial.backends.codegraph.view.storeRoot);
});
test("cancelling one ensure waiter does not cancel the shared publication", async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const first = ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  const second = ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  const [row] = await first;
  assert.equal(row.ok, true, JSON.stringify(row));
  assert.equal((await indexStatus(root)).backends.codegraph.ready, true);
});

test("a queued explicit reindex publishes after sync into a distinct store", async (t) => {
  const root = await fixture(t);
  await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  const before = await indexStatus(root);
  await writeFile(path.join(root, "main.js"), "export function hello() { return 2; }\n");

  const syncing = syncIndexes(root, ["codegraph"], { timeoutMs: 120_000 });
  const rebuilding = reindexIndexes(root, ["codegraph"], { timeoutMs: 120_000 });
  const [[synced], [rebuilt]] = await Promise.all([syncing, rebuilding]);

  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
  assert.equal(rebuilt.action, "rebuilt");
  const after = await indexStatus(root);
  assert.equal(after.backends.codegraph.view.state, "clean");
  assert.notEqual(after.backends.codegraph.view.storeRoot, before.backends.codegraph.view.storeRoot);
  assert.notEqual(after.backends.codegraph.view.appliedManifestId, before.backends.codegraph.view.appliedManifestId);
});

test("dirtiness is unknown until publication establishes a baseline", async (t) => {
  const root = await fixture(t);
  const before = await indexStatus(root);
  assert.equal(before.backends.codegraph.dirty, null);
  assert.equal(before.backends.codegraph.baseline, "unverified");

  await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  const synced = await indexStatus(root);
  assert.equal(synced.backends.codegraph.baseline, "applied");

  await writeFile(path.join(root, "extra.js"), "export const added = true;\n");
  const changed = await waitFor(() => indexStatus(root), (status) => status.backends.codegraph.dirty === true);
  assert.equal(changed.backends.codegraph.dirty, true);
});

test("compiler and build configuration changes invalidate the published graph projection", async (t) => {
  const root = await fixture(t);
  const config = {
    "tsconfig.json": "{\"compilerOptions\":{\"strict\":true}}\n",
    "jsconfig.json": "{\"compilerOptions\":{\"checkJs\":true}}\n",
    "build.config.js": "export default { mode: \"development\" };\n",
  };
  for (const [relativePath, content] of Object.entries(config)) await writeFile(path.join(root, relativePath), content);
  await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  for (const [relativePath, content] of Object.entries(config)) {
    const before = await indexStatus(root);
    const beforeGeneration = observeIndexState(root).generation;
    await writeFile(path.join(root, relativePath), content + "// mutation\n");
    const changed = await waitFor(() => observeIndexState(root), (state) => state.generation > beforeGeneration);
    assert.ok(changed.generation > beforeGeneration, relativePath + " did not reach the watcher");
    const dirty = await indexStatus(root);
    assert.equal(dirty.backends.codegraph.dirty, true, relativePath + " must invalidate the published projection");
    await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
    const rebuilt = await indexStatus(root);
    assert.equal(rebuilt.backends.codegraph.dirty, false);
    assert.equal(rebuilt.backends.codegraph.view.state, "clean");
    assert.notEqual(rebuilt.backends.codegraph.view.appliedManifestId, before.backends.codegraph.view.appliedManifestId, relativePath + " was omitted from the published manifest");
  }
});

test("new directories and deletions advance freshness while derived writes stay ignored", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "node_modules/dep"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  assert.equal((await indexStatus(root)).backends.codegraph.dirty, false);

  const initial = observeIndexState(root);
  await writeFile(path.join(root, "node_modules/dep/generated.js"), "module.exports = 1;\n");
  await writeFile(path.join(root, ".codegraph-scratch.tmp"), "ignored\n");
  await writeFile(path.join(root, "dist/bundle.js"), "built\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(observeIndexState(root).generation, initial.generation);
  assert.equal((await indexStatus(root)).backends.codegraph.dirty, false);

  await mkdir(path.join(root, "newdir"));
  const afterDirectory = await waitFor(() => observeIndexState(root), (state) => state.generation > initial.generation);
  assert.ok(afterDirectory.generation > initial.generation);

  await writeFile(path.join(root, "newdir/source.js"), "export const source = true;\n");
  const afterSource = await waitFor(() => observeIndexState(root), (state) => state.generation > afterDirectory.generation);
  await unlink(path.join(root, "newdir/source.js"));
  const afterDelete = await waitFor(() => observeIndexState(root), (state) => state.generation > afterSource.generation);
  assert.ok(afterDelete.generation > afterSource.generation);

  const stable = await indexStatus(root);
  assert.equal(stable.backends.codegraph.dirty, true);
});

test("an aborted index request does not publish or advance its baseline", async (t) => {
  const root = await fixture(t);
  await assert.rejects(ensureIndexes(root, ["codegraph"], { signal: AbortSignal.abort() }), { name: "AbortError" });
  const status = await indexStatus(root);
  assert.equal(status.backends.codegraph.ready, false);
  assert.equal(status.backends.codegraph.baseline, "unverified");
  assert.equal(status.backends.codegraph.appliedGeneration, 0);
});

test("Serena is not a derived-index target", async (t) => {
  const root = await fixture(t);
  await assert.rejects(() => ensureIndexes(root, ["serena"], { timeoutMs: 5_000 }), /no derived-index backend/);
});

test("the agent home and every repository nested inside it are refused as roots", async (t) => {
  const root = await fixture(t);
  const nested = path.join(DENIED_HOME, "agent");
  await mkdir(path.join(nested, "extensions"), { recursive: true });
  await writeFile(path.join(nested, "main.js"), "export const hidden = true;\n");
  t.after(() => rm(DENIED_HOME, { recursive: true, force: true }));

  await assert.rejects(() => ensureIndexes(DENIED_HOME, ["codegraph"]), /agent private state/);
  await assert.rejects(() => indexStatus(DENIED_HOME), /agent private state/);
  await assert.rejects(() => ensureIndexes(nested, ["codegraph"]), /agent private state/);
  await assert.rejects(() => indexStatus(path.join(nested, "extensions")), /agent private state/);

  const [row] = await ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
  assert.equal(row.ok, true, JSON.stringify(row));
});

test("the home directory itself is never a workspace, but its children are", () => {
  assert.equal(isDeniedRoot(os.homedir()), true);
  assert.equal(isDeniedRoot(path.join(os.homedir(), "some-project")), false);
});

test("observeIndexState does not create an untracked root", async (t) => {
  const root = await fixture(t);
  assert.equal(observeIndexState(root), null);
  assert.equal(observeIndexState(root), null);
});

test("a null-filename watcher event marks the generation dirty", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const originalWatch = fs.default.watch;
  let event;
  fs.default.watch = (_root, _options, callback) => {
    event = callback;
    return { on() { return this; }, close() {} };
  };
  syncBuiltinESMExports();
  const fresh = await import(`../src/index-manager.js?null-filename=${Date.now()}`);
  try {
    const root = await fixture(t);
    await fresh.ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
    const before = fresh.observeIndexState(root);
    event("change", null);
    const after = fresh.observeIndexState(root);
    assert.equal(after.generation, before.generation + 1);
  } finally {
    fresh.closeIndexManager();
    fs.default.watch = originalWatch;
    syncBuiltinESMExports();
  }
});
test("recursive watcher attach noise does not dirty the initial publication", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const originalWatch = fs.default.watch;
  let event;
  fs.default.watch = (_root, _options, callback) => {
    event = callback;
    callback("rename", "main.js");
    return { on() { return this; }, close() {} };
  };
  syncBuiltinESMExports();
  const fresh = await import("../src/index-manager.js?initial-watcher-noise=" + Date.now());
  try {
    const root = await fixture(t);
    await fresh.ensureIndexes(root, ["codegraph"], { freshness: "auto", timeoutMs: 120_000 });
    const baseline = fresh.observeIndexState(root);
    assert.equal((await fresh.indexStatus(root)).backends.codegraph.dirty, false);
    event("change", "main.js");
    assert.equal(fresh.observeIndexState(root).generation, baseline.generation + 1);
    assert.equal((await fresh.indexStatus(root)).backends.codegraph.dirty, true);
  } finally {
    fresh.closeIndexManager();
    fs.default.watch = originalWatch;
    syncBuiltinESMExports();
  }
});
