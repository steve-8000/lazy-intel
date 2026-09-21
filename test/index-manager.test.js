import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
delete process.env.LAZY_INTEL_EMBEDDING;
// The deny list is resolved once at import time, so the fake agent home has to be pinned
// first; otherwise the suite would assert against the developer's real ~/.omp.
const DENIED_HOME = path.join(os.tmpdir(), "lazy-intel-denied-home");
process.env.OMP_HOME = DENIED_HOME;

const { ensureIndexes, indexStatus, isDeniedRoot, syncIndexes, reindexIndexes, repairIndexes, observeIndexState, closeIndexManager } =
  await import("../src/index-manager.js");

const TEST_EMBEDDING = "local/test-embedding";

async function fixture(t, { slowIndexSeconds = 0, zvecConfig = true, buildingZvec = false } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-index-"));
  const bin = path.join(tmp, "bin");
  const project = path.join(tmp, "project");
  const callLog = path.join(tmp, "calls.log");
  const zvecHome = path.join(tmp, "zvec-home");
  await mkdir(bin);
  await mkdir(project);
  await mkdir(zvecHome);
  await writeFile(path.join(project, "main.swift"), "func hello() {}\n");
  // Hermetic: never read the developer's ~/.zvec-grep configuration.
  if (zvecConfig) {
    await writeFile(path.join(zvecHome, "config.json"), JSON.stringify({ version: 1, defaults: { embedding: TEST_EMBEDDING } }));
  }

  const marker = { zvec: ".zvec-grep/index.zvec", codegraph: ".codegraph/graph.db" };
  const zvecStatus = buildingZvec
    ? 'echo "state: indexing"; exit 1'
    : 'if [[ -f "\$2/.zvec-grep/index.zvec" ]]; then echo "Workspace index is ready"; exit 0; fi\n    echo "Workspace index is not configured"; exit 1';
  await writeFile(path.join(bin, "zg"), `#!/usr/bin/env bash
set -euo pipefail
echo "zg $*" >> "${callLog}"
case "\${1:-}" in
  index)
    sleep ${slowIndexSeconds}
    mkdir -p "\$2/.zvec-grep" && touch "\$2/${marker.zvec}" ;;
  status)
    ${zvecStatus} ;;
  query) echo "zvec-hit" ;;
esac
`);
  await writeFile(path.join(bin, "codegraph"), `#!/usr/bin/env bash
set -euo pipefail
echo "codegraph $*" >> "${callLog}"
case "\${1:-}" in
  init|index)
    mkdir -p "\$2/.codegraph" && touch "\$2/${marker.codegraph}" ;;
  sync) : ;;
  status)
    if [[ -f "\$2/${marker.codegraph}" ]]; then echo "3 symbols indexed"; exit 0; fi
    echo "Not initialized"; exit 1 ;;
esac
`);
  await chmod(path.join(bin, "zg"), 0o755);
  await chmod(path.join(bin, "codegraph"), 0o755);

  const previous = { PATH: process.env.PATH, home: process.env.ZVEC_GREP_HOME, embedding: process.env.ZVEC_GREP_EMBEDDING };
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.LAZY_INTEL_ZG_BIN = path.join(bin, "zg");
  process.env.LAZY_INTEL_CODEGRAPH_BIN = path.join(bin, "codegraph");
  process.env.ZVEC_GREP_HOME = zvecHome;
  delete process.env.ZVEC_GREP_EMBEDDING;
  t.after(async () => {
    process.env.PATH = previous.PATH;
    if (previous.home == null) delete process.env.ZVEC_GREP_HOME; else process.env.ZVEC_GREP_HOME = previous.home;
    if (previous.embedding == null) delete process.env.ZVEC_GREP_EMBEDDING; else process.env.ZVEC_GREP_EMBEDDING = previous.embedding;
    delete process.env.LAZY_INTEL_ZG_BIN;
    delete process.env.LAZY_INTEL_CODEGRAPH_BIN;
    closeIndexManager();
    await rm(tmp, { recursive: true, force: true });
  });

  const calls = async () => (await readFile(callLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { project, calls };
}

test("absent indexes are created from the backend readiness probe, not a directory guess", async (t) => {
  const { project, calls } = await fixture(t);
  const rows = await ensureIndexes(project, ["zvec", "codegraph"], { freshness: "auto", timeoutMs: 30_000 });
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows));
  const observed = await calls();
  assert.ok(observed.some((c) => c.startsWith("zg index")), JSON.stringify(observed));
  assert.ok(observed.some((c) => c.startsWith("codegraph init")), JSON.stringify(observed));
  const status = await indexStatus(project);
  assert.equal(status.backends.zvec.ready, true);
  assert.equal(status.backends.codegraph.ready, true);
  assert.equal(status.embedding, `inherited from zvec-grep configuration (${TEST_EMBEDDING})`);
});

test("a new zvec index inherits the shared embedding configuration", async (t) => {
  const { project, calls } = await fixture(t);
  await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  const create = (await calls()).find((c) => c.startsWith("zg index"));
  assert.ok(create, "expected an index call");
  assert.doesNotMatch(create, /--embedding/);
});

test("an unchanged workspace triggers no further backend work", async (t) => {
  const { project, calls } = await fixture(t);
  await ensureIndexes(project, ["zvec", "codegraph"], { freshness: "auto", timeoutMs: 30_000 });
  const settled = (await calls()).length;
  await ensureIndexes(project, ["zvec", "codegraph"], { freshness: "auto", timeoutMs: 30_000 });
  await ensureIndexes(project, ["zvec", "codegraph"], { freshness: "auto", timeoutMs: 30_000 });
  assert.equal((await calls()).length, settled);
});

test("a reindex queued behind an in-flight sync still rebuilds", async (t) => {
  const { project, calls } = await fixture(t, { slowIndexSeconds: 1 });
  await ensureIndexes(project, ["zvec"], { freshness: "strict", timeoutMs: 30_000 });
  const inFlight = syncIndexes(project, ["zvec"], { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [rebuilt] = await reindexIndexes(project, ["zvec"], { timeoutMs: 30_000 });
  await inFlight;
  assert.equal(rebuilt.action, "rebuilt");
  assert.ok((await calls()).some((c) => c.includes("--rebuild")), "explicit reindex must reach the backend");
});

test("dirtiness is unknown until this process establishes a baseline", async (t) => {
  const { project } = await fixture(t);
  const before = await indexStatus(project);
  assert.equal(before.backends.zvec.dirty, null);
  assert.equal(before.backends.zvec.baseline, "unverified");

  await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  const synced = await indexStatus(project);
  assert.equal(synced.backends.zvec.dirty, false);
  assert.equal(synced.backends.zvec.baseline, "applied");

  await writeFile(path.join(project, "extra.swift"), "func added() {}\n");
  const deadline = Date.now() + 5_000;
  let observed = synced;
  while (Date.now() < deadline) {
    observed = await indexStatus(project);
    if (observed.backends.zvec.dirty === true) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(observed.backends.zvec.dirty, true, "a source change must mark the backend dirty");
});

test("derived and vendor directory writes never mark the workspace dirty", async (t) => {
  const { project } = await fixture(t);
  // Real source layout exists before the baseline; only ignored subtrees churn afterwards.
  await mkdir(path.join(project, "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(project, "packages", "app", "dist"), { recursive: true });
  await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  assert.equal((await indexStatus(project)).backends.zvec.dirty, false);

  await writeFile(path.join(project, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(project, ".zvec-grep", "scratch.tmp"), "x");
  await writeFile(path.join(project, "packages", "app", "dist", "bundle.js"), "// built\n");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await indexStatus(project)).backends.zvec.dirty, false, "derived/vendor churn must not trigger syncs");

  await writeFile(path.join(project, "packages", "app", "feature.swift"), "func feature() {}\n");
  const deadline = Date.now() + 5_000;
  let dirty = false;
  while (Date.now() < deadline && !dirty) {
    dirty = (await indexStatus(project)).backends.zvec.dirty === true;
    if (!dirty) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(dirty, true, "a real nested source change must still mark the backend dirty");
});

test("an unconfigured embedding fails with actionable guidance instead of a raw CLI error", async (t) => {
  const { project, calls } = await fixture(t, { zvecConfig: false });
  const [row] = await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  assert.equal(row.ok, false);
  assert.match(row.error, /no zvec embedding available/);
  assert.match(row.error, /zg config model set/);
  assert.deepEqual(await calls(), (await calls()).filter((c) => c.startsWith("zg status")), "no index must be started without a model");
});

test("an aborted index request never launches a backend or advances its baseline", async (t) => {
  const { project, calls } = await fixture(t);
  await assert.rejects(ensureIndexes(project, ["zvec"], { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(await calls(), []);
  const status = await indexStatus(project);
  assert.equal(status.backends.zvec.consecutiveFailures, 0);
  assert.equal(status.backends.zvec.baseline, "unverified");
});

test("serena is rejected as a derived-index target", async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(() => ensureIndexes(project, ["serena"], { timeoutMs: 5_000 }), /no derived-index backend/);
});

test("the agent home and every repository nested inside it are refused as roots", async (t) => {
  const { calls, project } = await fixture(t);
  const nested = path.join(DENIED_HOME, "agent");
  await mkdir(path.join(nested, "extensions"), { recursive: true });
  await writeFile(path.join(nested, "main.swift"), "func hello() {}\n");
  t.after(() => rm(DENIED_HOME, { recursive: true, force: true }));

  await assert.rejects(() => ensureIndexes(DENIED_HOME, ["zvec"], { timeoutMs: 30_000 }), /agent private state/);
  await assert.rejects(() => indexStatus(DENIED_HOME), /agent private state/);

  // The harness keeps a real git repository at ~/.omp/agent holding rules, memories, skills
  // and session databases. An exact-directory deny embedded exactly that private state, so
  // the deny covers the whole tree.
  await assert.rejects(() => ensureIndexes(nested, ["zvec"], { timeoutMs: 30_000 }), /agent private state/);
  await assert.rejects(() => indexStatus(path.join(nested, "extensions")), /agent private state/);
  assert.deepEqual(await calls(), [], "a denied root must not reach a backend at all");

  // A workspace outside the denied trees is unaffected.
  const [row] = await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  assert.equal(row.ok, true, JSON.stringify(row));
});

test("the home directory itself is never a workspace, but its children are", () => {
  assert.equal(isDeniedRoot(os.homedir()), true);
  assert.equal(isDeniedRoot(path.join(os.homedir(), "some-project")), false);
});

test("a building observation is not success or a failure", async (t) => {
  const { project, calls } = await fixture(t, { buildingZvec: true });
  const [row] = await ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
  assert.equal(row.ready, false);
  assert.equal(row.ok, false);
  assert.equal(row.building, true);
  const status = await indexStatus(project);
  assert.equal(status.backends.zvec.consecutiveFailures, 0);
  assert.equal((await calls()).some((call) => call.includes(" index ")), false);
});

test("repair during a building observation does not start a second build", async (t) => {
  const { project, calls } = await fixture(t, { buildingZvec: true });
  const [row] = await repairIndexes(project, ["zvec"], { timeoutMs: 30_000 });
  assert.deepEqual({ ready: row.ready, ok: row.ok, building: row.building }, { ready: false, ok: false, building: true });
  assert.equal((await calls()).some((call) => call.includes(" index ")), false);
});

test("observeIndexState does not create an untracked root", async (t) => {
  const { project } = await fixture(t);
  assert.equal(observeIndexState(project), null);
  assert.equal(observeIndexState(project), null);
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
    const { project } = await fixture(t);
    await fresh.ensureIndexes(project, ["zvec"], { freshness: "auto", timeoutMs: 30_000 });
    const before = fresh.observeIndexState(project);
    event("change", null);
    const after = fresh.observeIndexState(project);
    assert.equal(after.generation, before.generation + 1);
  } finally {
    fresh.closeIndexManager();
    fs.default.watch = originalWatch;
    syncBuiltinESMExports();
  }
});
