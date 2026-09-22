import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codegraphDb from "../../vendor/codegraph/dist/db/index.js";
const { DatabaseConnection } = codegraphDb;
import codegraphQueries from "../../vendor/codegraph/dist/db/queries.js";
const { QueryBuilder } = codegraphQueries;
import { ExtractionOrchestrator } from "../../vendor/codegraph/dist/extraction/index.js";
import { initGrammars, loadGrammarsForLanguages } from "../../vendor/codegraph/dist/extraction/grammars.js";
import { statsForSnapshot } from "../../vendor/codegraph/dist/extraction/snapshot-input.js";

const corpus = [
  ["sample.js", "export function greet(name) { return `hello ${name}`; }\n", "javascript"],
  ["sample.ts", "export const answer: number = 42;\n", "typescript"],
  ["sample.py", "def greet(name):\n    return name\n", "python"],
];

function stableExtraction(result) {
  return {
    nodes: result.nodes.map(({ updatedAt, ...node }) => node),
    edges: result.edges.map(({ updatedAt, ...edge }) => edge),
    unresolvedReferences: result.unresolvedReferences,
    errors: result.errors,
  };
}

async function indexWith(root, relativePath, content, mode) {
  const db = DatabaseConnection.initialize(join(root, "graph.db"));
  try {
    const queries = new QueryBuilder(db.getDb());
    const orchestrator = new ExtractionOrchestrator(root, queries);
    const result = mode === "disk"
      ? await orchestrator.indexFile(relativePath)
      : await orchestrator.indexSnapshot({ relativePath, content });
    const files = queries.getAllFiles().map(({ path, contentHash, language, nodeCount }) => ({ path, contentHash, language, nodeCount }));
    return { result, files };
  } finally {
    db.close();
  }
}

async function rootsFor(t, relativePath, diskContent) {
  const diskRoot = await mkdtemp(join(tmpdir(), "lazy-intel-extraction-disk-"));
  const snapshotRoot = await mkdtemp(join(tmpdir(), "lazy-intel-extraction-snapshot-"));
  t.after(async () => {
    await Promise.all([
      rm(diskRoot, { recursive: true, force: true }),
      rm(snapshotRoot, { recursive: true, force: true }),
    ]);
  });
  await writeFile(join(diskRoot, relativePath), diskContent);
  // The snapshot path may contain stale bytes; indexSnapshot must use its payload.
  await writeFile(join(snapshotRoot, relativePath), diskContent);
  return { diskRoot, snapshotRoot };
}

test("snapshot extraction preserves complete structures for enabled languages", async (t) => {
  await initGrammars();
  await loadGrammarsForLanguages(corpus.map(([, , language]) => language));
  for (const [relativePath, content] of corpus) {
    const { diskRoot, snapshotRoot } = await rootsFor(t, relativePath, content);
    const disk = await indexWith(diskRoot, relativePath, content, "disk");
    const snapshot = await indexWith(snapshotRoot, relativePath, content, "snapshot");
    assert.deepEqual(stableExtraction(snapshot.result), stableExtraction(disk.result), relativePath);
    assert.equal(statsForSnapshot({ relativePath, content }).size, Buffer.byteLength(content));
  }
});

test("snapshot bytes win when disk content differs", async (t) => {
  await initGrammars();
  await loadGrammarsForLanguages(["javascript"]);
  const relativePath = "sample.js";
  const diskContent = "export function diskOnly() {}\n";
  const snapshotContent = "export function snapshotOnly() {}\n";
  const { diskRoot, snapshotRoot } = await rootsFor(t, relativePath, diskContent);
  const disk = await indexWith(diskRoot, relativePath, diskContent, "disk");
  const snapshot = await indexWith(snapshotRoot, relativePath, snapshotContent, "snapshot");
  assert.ok(disk.result.nodes.some((node) => node.name === "diskOnly"));
  assert.ok(!disk.result.nodes.some((node) => node.name === "snapshotOnly"));
  assert.ok(snapshot.result.nodes.some((node) => node.name === "snapshotOnly"));
  assert.ok(!snapshot.result.nodes.some((node) => node.name === "diskOnly"));
});

test("snapshot extraction retains symbols and the full hash above one MiB", async (t) => {
  await initGrammars();
  await loadGrammarsForLanguages(["typescript"]);
  const relativePath = "large.ts";
  const content = "export function largeSnapshotProbe(value: number) { return value + 1; }\n" + " ".repeat(1_200_000);
  const { diskRoot, snapshotRoot } = await rootsFor(t, relativePath, content);
  const disk = await indexWith(diskRoot, relativePath, content, "disk");
  const snapshot = await indexWith(snapshotRoot, relativePath, content, "snapshot");
  const expectedHash = createHash("sha256").update(content).digest("hex");
  assert.ok(disk.result.nodes.some((node) => node.name === "largeSnapshotProbe"));
  assert.ok(snapshot.result.nodes.some((node) => node.name === "largeSnapshotProbe"));
  assert.equal(disk.files.find((file) => file.path === relativePath)?.contentHash, expectedHash);
  assert.equal(snapshot.files.find((file) => file.path === relativePath)?.contentHash, expectedHash);
  assert.equal(Buffer.byteLength(content), 1_200_072);
});
