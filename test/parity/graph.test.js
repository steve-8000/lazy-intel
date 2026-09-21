import assert from "node:assert/strict";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codegraphDb from "../../vendor/codegraph/dist/db/index.js";
const { DatabaseConnection } = codegraphDb;
import codegraphQueries from "../../vendor/codegraph/dist/db/queries.js";
const { QueryBuilder } = codegraphQueries;
import { ExtractionOrchestrator } from "../../vendor/codegraph/dist/extraction/index.js";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "lazy-intel-graph-"));
  const db = DatabaseConnection.initialize(join(root, "graph.db"));
  const queries = new QueryBuilder(db.getDb());
  return { root, db, queries, orchestrator: new ExtractionOrchestrator(root, queries) };
}

function fileState(queries) {
  return queries.getAllFiles().map(({ path, contentHash, language, nodeCount }) => ({
    path,
    contentHash,
    language,
    nodeCount,
  }));
}

function unresolvedState(queries) {
  return queries.getUnresolvedReferences().map(({ fromNodeId, referenceName, referenceKind, filePath }) => ({
    fromNodeId,
    referenceName,
    referenceKind,
    filePath,
  }));
}
function incomingEdges(queries, filePath) {
  return queries.getCrossFileIncomingEdgesWithTarget(filePath).map(({ source, targetKind, targetName, kind }) => ({
    source,
    targetKind,
    targetName,
    kind,
  }));
}

test("snapshot graph updates match stock deletion, rename, and definition rebind", async () => {
  const stock = await harness();
  const snapshot = await harness();
  const initial = {
    "a.js": "export function target() { return 1; }\n",
    "b.js": "import { target } from './a.js'; target();\n",
  };
  for (const [relativePath, content] of Object.entries(initial)) {
    await writeFile(join(stock.root, relativePath), content);
    await writeFile(join(snapshot.root, relativePath), content);
    await stock.orchestrator.indexFile(relativePath);
    await snapshot.orchestrator.indexFile(relativePath);
  }

  const bodyChanged = "export function target() { return 2; }\n";
  await writeFile(join(stock.root, "a.js"), bodyChanged);
  const stockBodyChange = await stock.orchestrator.sync(undefined, ["a.js"]);
  const snapshotBodyChange = await snapshot.orchestrator.syncSnapshots([
    { relativePath: "a.js", content: bodyChanged },
  ]);
  assert.deepEqual(snapshotBodyChange.definitionDelta, stockBodyChange.definitionDelta);
  assert.deepEqual(incomingEdges(snapshot.queries, "a.js"), incomingEdges(stock.queries, "a.js"));

  const changed = "export function replacement() { return 2; }\n";
  await writeFile(join(stock.root, "a.js"), changed);
  const stockDefinitionChange = await stock.orchestrator.sync(undefined, ["a.js"]);
  const snapshotDefinitionChange = await snapshot.orchestrator.syncSnapshots([
    { relativePath: "a.js", content: changed },
  ]);
  assert.deepEqual(
    [...(snapshotDefinitionChange.definitionDelta ?? [])].sort(),
    [...(stockDefinitionChange.definitionDelta ?? [])].sort(),
  );
  assert.deepEqual(unresolvedState(snapshot.queries), unresolvedState(stock.queries));

  await unlink(join(stock.root, "a.js"));
  await writeFile(join(stock.root, "renamed.js"), changed);
  const stockRename = await stock.orchestrator.sync(undefined, ["a.js", "renamed.js"]);
  const snapshotRename = await snapshot.orchestrator.syncSnapshots(
    [{ relativePath: "renamed.js", content: changed }],
    ["a.js"],
  );
  assert.equal(stockRename.filesRemoved, snapshotRename.filesRemoved);
  assert.equal(stockRename.filesAdded, snapshotRename.filesAdded);
  assert.deepEqual(fileState(snapshot.queries), fileState(stock.queries));
  assert.deepEqual(unresolvedState(snapshot.queries), unresolvedState(stock.queries));

  stock.db.close();
  snapshot.db.close();
});
