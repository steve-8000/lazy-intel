import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractFromSource } from "../../vendor/codegraph/dist/extraction/tree-sitter.js";
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

test("snapshot extraction preserves complete structures for enabled languages", async () => {
  await initGrammars();
  await loadGrammarsForLanguages(corpus.map(([, , language]) => language));
  for (const [relativePath, content, language] of corpus) {
    const root = await mkdtemp(join(tmpdir(), "lazy-intel-extraction-"));
    const diskPath = join(root, relativePath);
    await writeFile(diskPath, content);
    const diskContent = await readFile(diskPath, "utf8");
    const stock = extractFromSource(relativePath, diskContent, language, []);
    const snapshot = extractFromSource(relativePath, content, language, []);
    assert.deepEqual(stableExtraction(snapshot), stableExtraction(stock), relativePath);
    assert.equal(statsForSnapshot({ relativePath, content }).size, Buffer.byteLength(content));
  }
});

test("snapshot bytes win when disk content differs", async () => {
  await initGrammars();
  await loadGrammarsForLanguages(["javascript"]);
  const root = await mkdtemp(join(tmpdir(), "lazy-intel-extraction-"));
  const relativePath = "sample.js";
  await writeFile(join(root, relativePath), "export function diskOnly() {}\n");
  const snapshotResult = extractFromSource(
    relativePath,
    "export function snapshotOnly() {}\n",
    "javascript",
    [],
  );
  assert.ok(snapshotResult.nodes.some((node) => node.name === "snapshotOnly"));
  assert.ok(!snapshotResult.nodes.some((node) => node.name === "diskOnly"));
});
