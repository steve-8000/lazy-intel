import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocator, createSourceVerifier, observationSpan } from "../src/lib/source.js";
import { buildContextPack } from "../src/context-pack.js";
import { makeEvidence } from "../src/evidence.js";
import { createHash } from "node:crypto";

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

test("public context preserves indexed and semantic observation boundaries", () => {
  const source = makeEvidence({
    ...evidence("/workspace", "indexed", "function f() {}"),
    anchor: { contentHash: "captured", relativePath: "a.js", span: { startByte: 0, endByte: 15 } },
    projectionView: { projection: "graph", appliedManifestId: "manifest", viewId: "view", state: "clean" },
    semanticObservation: { sessionEpoch: "session", documentVersion: 4, fileHash: "captured", scope: "own-buffer" },
    coverage: { kind: "bounded_graph", completeWithinScope: false, omitted: null },
  });
  const pack = buildContextPack({ items: [source], envelopes: [{ coverage: "bounded", returned: 1, total: null }], maxChars: 4000 });
  const metadata = JSON.parse(pack.metaText);
  assert.equal(metadata.coverage, "bounded");
  assert.equal(metadata.evidence[0].projectionView.appliedManifestId, "manifest");
  assert.equal(metadata.evidence[0].semanticObservation.documentVersion, 4);
  assert.equal(metadata.evidence[0].anchor.contentHash, "captured");
});

test("matching revision alone cannot verify a wrong source excerpt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-revision-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "const original = 1;";
  await writeFile(path.join(root, "a.js"), content);
  const locator = await resolveLocator(root, "a.js");
  const hash = createHash("sha256").update(content).digest("hex");
  const verifier = createSourceVerifier(root);
  assert.equal((await verifier.verify(locator, "invented excerpt", hash)).status, "mismatch");
  assert.equal((await verifier.verify(locator, content, hash)).status, "matched");
  assert.equal((await verifier.verify(locator, content, "previous-revision")).status, "mismatch");
});

test("empty diagnostics retain completion observations within the response budget", () => {
  const observation = { sessionEpoch: "owned-session", fileHash: "captured", diagnosticsStatus: "complete" };
  const pack = buildContextPack({ envelopes: [{ outcome: "empty", returned: 0, total: 0, coverage: "backend_complete", semanticObservations: [observation] }], maxChars: 2000 });
  assert.deepEqual(JSON.parse(pack.metaText).semanticObservations, [observation]);
  assert.equal(pack.evidence.length, 0);
  assert.ok(pack.text.length + pack.metaText.length <= 2000);
});
test("bounded output keeps headers, warnings, and metadata while reporting honest truncation", () => {
  const observation = { sessionEpoch: "session", fileHash: "hash", diagnosticsStatus: "complete" };
  const issue = { code: "SOURCE_MISMATCH", message: "source changed" };
  const pack = buildContextPack({
    envelopes: [{ backend: "codegraph", outcome: "error", error: { message: "backend warning" }, truncated: true, returned: 1, total: 2, views: ["published-view"], semanticObservations: [observation], issues: [issue] }],
    items: [evidence("/workspace", "bounded", "function bounded() {}")],
    status: "partial",
    fulfillment: { requiredMet: false, unmet: ["definitions"] },
    stopReason: "backend_failed",
    maxChars: 4_000,
  });
  assert.match(pack.text, /Status: partial/);
  assert.match(pack.text, /Limits: maxChars=4000; wireCapBytes=1048576/);
  assert.match(pack.text, /Stop reason: backend_failed/);
  assert.match(pack.text, /Errors: codegraph: backend warning/);
  assert.match(pack.text, /Unmet obligations: definitions/);
  assert.match(pack.text, /Backend output was truncated; coverage is incomplete\./);
  assert.match(pack.text, /Omitted items: /);
  const metadata = JSON.parse(pack.metaText);
  assert.equal(metadata.truncated, true);
  assert.deepEqual(metadata.views, ["published-view"]);
  assert.deepEqual(metadata.semanticObservations, [observation]);
  assert.deepEqual(metadata.issues, [issue]);
  assert.ok(Buffer.byteLength(pack.text + pack.metaText, "utf8") <= 1_048_576);
});
test("evidence too large for the budget is returned as a location, and no readable body means partial", () => {
  const large = evidence("/workspace", "large", "x".repeat(20_000));
  const small = evidence("/workspace", "small", "function small() {}");
  const only = buildContextPack({ envelopes: [{ outcome: "ok", returned: 1, total: 1 }], items: [large], status: "ok", maxChars: 6_000 });
  assert.equal(only.status, "partial");
  assert.equal(JSON.parse(only.metaText).evidence[0].bodyOmitted, true);
  assert.match(only.text, /Location: a\.js:1-2[\s\S]*Body omitted: 20000 characters/);
  assert.ok(!only.text.includes("x".repeat(100)));
  assert.ok(only.text.length + only.metaText.length <= 6_000);

  const mixed = buildContextPack({ envelopes: [{ outcome: "ok", returned: 2, total: 2 }], items: [large, small], status: "ok", maxChars: 6_000 });
  assert.equal(mixed.status, "ok");
  assert.deepEqual(JSON.parse(mixed.metaText).evidence.map(({ id, bodyOmitted }) => [id, Boolean(bodyOmitted)]).sort(), [["large", true], ["small", false]]);
});
test("canonical span verifies exact UTF-8 bytes and detects a later source revision", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-span-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "const café = 'value';\r\n";
  await writeFile(path.join(root, "a.js"), content);
  const locator = { ...await resolveLocator(root, "a.js"), range: { startLine: 0, endLineExclusive: 1 } };
  const hash = createHash("sha256").update(content).digest("hex");
  const span = { coordinateSystem: "utf8-bytes", startByte: 0, endByte: Buffer.byteLength(content) };
  const verifier = createSourceVerifier(root);
  assert.equal((await verifier.verify(locator, content, hash, span)).status, "matched");
  assert.equal((await verifier.verify(locator, content, hash, { ...span, endByte: span.endByte - 1 })).status, "mismatch");
  assert.equal((await verifier.verify({ ...locator, range: { startLine: 1, endLineExclusive: 2 } }, content, hash, span)).status, "mismatch");
  await writeFile(path.join(root, "a.js"), "const café = 'changed';\r\n");
  assert.equal((await createSourceVerifier(root).verify(locator, content, hash, span)).status, "mismatch");
});

test("descriptions verify anchors without claiming verbatim source text", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-description-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "const value = 1;";
  await writeFile(path.join(root, "a.js"), content);
  const locator = await resolveLocator(root, "a.js");
  const hash = createHash("sha256").update(content).digest("hex");
  const span = { coordinateSystem: "utf8-bytes", startByte: 0, endByte: Buffer.byteLength(content) };
  const verifier = createSourceVerifier(root);
  const description = "This declaration has an unused value";
  assert.equal((await verifier.verify(locator, description, hash, span)).status, "mismatch");
  assert.equal((await verifier.verify(locator, description, hash, span, "description")).status, "matched");
  assert.equal((await verifier.verify(locator, description, "old-revision", span, "description")).status, "mismatch");
  const item = makeEvidence({ ...evidence(root, "diagnostic", description), kind: "diagnostic", locator, textKind: "description" });
  const pack = buildContextPack({ items: [item], maxChars: 4000 });
  assert.equal(JSON.parse(pack.metaText).evidence[0].textKind, "description");
  assert.ok(pack.text.includes(description));
});
