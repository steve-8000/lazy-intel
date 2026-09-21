import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocator, createSourceVerifier, observationSpan } from "../src/lib/source.js";
import { buildContextPack } from "../src/context-pack.js";
import { makeEvidence } from "../src/evidence.js";

const p = { backend: "serena", operation: "symbol", backendVersion: "1", adapterVersion: "1", executionId: "e" };
const obs = { before: { processEpoch: 1, generation: 1, appliedGeneration: 1, watcher: "active", baseline: "applied" }, after: { processEpoch: 1, generation: 1, appliedGeneration: 1, watcher: "active", baseline: "applied" }, consistency: "observed_stable" };
function evidence(root, id, text = "한국어 😀\r\nsource") {
  return makeEvidence({ id, kind: "definition", method: "lsp", locator: { rootKey: root, relativePath: "a.js", range: { startLine: 0, endLineExclusive: 2 } }, text, sourceCheck: { status: "unchecked", reason: "not checked" }, observation: obs, provenance: [p] });
}

test("resolveLocator rejects traversal and symlink escapes", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "lazy-intel-source-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, "secret.js"), "secret");
  await symlink(outside, path.join(root, "link"));
  await assert.rejects(resolveLocator(root, "../outside/secret.js"));
  await assert.rejects(resolveLocator(root, "link/secret.js"));
});

test("source budget reports skipped files as unchecked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-budget-"));
  await writeFile(path.join(root, "a.js"), "a");
  await writeFile(path.join(root, "b.js"), "b");
  const verifier = createSourceVerifier(root, { maxFiles: 1, maxBytes: 100 });
  const a = await resolveLocator(root, "a.js");
  const b = await resolveLocator(root, "b.js");
  assert.equal((await verifier.verify(a, "a")).status, "matched");
  assert.equal((await verifier.verify(b, "b")).status, "unchecked");
});

test("observation span distinguishes concurrent and unverified observations", () => {
  const before = { processEpoch: 1, generation: 1, appliedGeneration: 1, watcher: "active", baseline: "applied" };
  assert.equal(observationSpan(before, { ...before, generation: 2 }).consistency, "concurrent_change_observed");
  assert.equal(observationSpan(before, { ...before, watcher: "unavailable" }).consistency, "unverified");
});

test("context pack stays within character budget and emits valid metadata", () => {
  const root = "/workspace";
  const long = evidence(root, "long", "가😀".repeat(10000));
  const pack = buildContextPack({ input: { operation: "symbol" }, items: [long], opaque: [], status: "ok", fulfillment: { requiredMet: true, unmet: [] }, stopReason: "plan_complete", maxChars: 400 });
  assert.ok(pack.text.length + pack.metaText.length <= 400);
  assert.doesNotThrow(() => JSON.parse(pack.metaText));
  assert.equal(pack.omittedItems, null);
});

test("unknown totals report null omitted count", () => {
  const pack = buildContextPack({ items: [evidence("/workspace", "x", "x".repeat(1000))], maxChars: 100, status: "ok", fulfillment: { requiredMet: true, unmet: [] }, stopReason: "plan_complete" });
  assert.equal(pack.omittedItems, null);
});
