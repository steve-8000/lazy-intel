import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codegraphDb from "../../vendor/codegraph/dist/db/index.js";
const { DatabaseConnection } = codegraphDb;
import codegraphQueries from "../../vendor/codegraph/dist/db/queries.js";
import codegraph from "../../vendor/codegraph/dist/index.js";
const { QueryBuilder } = codegraphQueries;
const { CodeGraph, NODE_KINDS } = codegraph;
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


function publicGraphState(graph) {
  const nodes = NODE_KINDS.flatMap((kind) => graph.getNodesByKind(kind))
    .map(({ id, kind, name, qualifiedName, filePath, language, startLine, endLine, startColumn, endColumn }) => ({
      id,
      kind,
      name,
      qualifiedName,
      filePath,
      language,
      startLine,
      endLine,
      startColumn,
      endColumn,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const edges = nodes
    .flatMap(({ id }) => graph.getOutgoingEdges(id))
    .filter(({ source, target }) => nodeIds.has(source) && nodeIds.has(target))
    .map(({ source, target, kind, metadata, line, column, provenance }) => ({ source, target, kind, metadata, line, column, provenance }))
    .sort((a, b) => (a.source+"\0"+a.target+"\0"+a.kind).localeCompare(b.source+"\0"+b.target+"\0"+b.kind));
  return { nodes, edges };
}

function incomingCallSources(graph, qualifiedName) {
  const target = graph.getNodesByKind("method").find((node) => node.qualifiedName === qualifiedName);
  assert.ok(target, "expected method " + qualifiedName);
  return graph.getIncomingEdges(target.id)
    .filter((edge) => edge.kind === "calls")
    .map((edge) => graph.getNode(edge.source)?.qualifiedName)
    .filter(Boolean)
    .sort();
}

const passCorpus = {
  "package.json": JSON.stringify({ dependencies: { astro: "^5" } }),
  "src/pages/index.astro": [
    "---",
    "const message = 'captured';",
    "---",
    "<html><body>{message}</body></html>",
    "",
  ].join("\n"),
  "Main.java": [
    "class Base { void draw() {} }",
    "class Widget extends Base {}",
    "class Decoy { void draw() {} }",
    "class Factory { static Widget create() { return new Widget(); } }",
    "class Caller {",
    "  void run() { Factory.create().draw(); }",
    "}",
    "",
  ].join("\n"),
  "Base.php": "<?php\nclass Base { public function baseMethod() { return 1; } }\n",
  "Sub.php": "<?php\nclass Sub extends Base { public function other() { return 2; } }\n",
  "App.php": [
    "<?php",
    "class App {",
    "  public function __construct(private Sub $s) {}",
    "  public function run() { return $this->s->baseMethod(); }",
    "}",
    "",
  ].join("\n"),
};

test("captured snapshots run framework, conformance, and deferred passes like stock disk", async () => {
  const stockRoot = await mkdtemp(join(tmpdir(), "lazy-intel-graph-stock-"));
  const snapshotRoot = await mkdtemp(join(tmpdir(), "lazy-intel-graph-snapshot-"));
  for (const [relativePath, content] of Object.entries(passCorpus)) {
    await mkdir(join(stockRoot, relativePath, ".."), { recursive: true });
    await writeFile(join(stockRoot, relativePath), content);
  }
  const stock = await CodeGraph.init(stockRoot, { index: true });
  const snapshot = await CodeGraph.init(snapshotRoot, { index: false });
  try {
    await snapshot.syncSnapshots(Object.entries(passCorpus).map(([relativePath, content]) => ({ relativePath, content })));
    assert.deepEqual(publicGraphState(snapshot), publicGraphState(stock));
    assert.deepEqual(snapshot.getNodesByKind("route").map(({ name, filePath }) => ({ name, filePath })), [{ name: "/", filePath: "src/pages/index.astro" }]);
    assert.deepEqual(incomingCallSources(snapshot, "Base::draw"), ["Caller::run"]);
    assert.deepEqual(incomingCallSources(snapshot, "Base::baseMethod"), ["App::run"]);
    assert.deepEqual(incomingCallSources(snapshot, "Decoy::draw"), []);
  } finally {
    snapshot.close();
    stock.close();
  }
});

test("existing-store snapshot edits preserve untouched graph state and match a fresh build", async () => {
  const incrementalRoot = await mkdtemp(join(tmpdir(), "lazy-intel-graph-incremental-"));
  const freshRoot = await mkdtemp(join(tmpdir(), "lazy-intel-graph-fresh-"));
  const initial = {
    "base.js": "export function stable() { return 1; }\n",
    "caller.js": "import { stable } from './base.js'; export function call() { return stable(); }\n",
  };
  const added = "export function added() { return 2; }\n";
  const incremental = await CodeGraph.init(incrementalRoot, { index: false });
  try {
    await incremental.syncSnapshots(Object.entries(initial).map(([relativePath, content]) => ({ relativePath, content })));
    const stable = incremental.getNodesByKind("function").find((node) => node.qualifiedName === "stable");
    assert.ok(stable);
    const untouchedEdge = incremental.getIncomingEdges(stable.id).find((edge) => edge.kind === "calls");
    assert.ok(untouchedEdge);
    await incremental.syncSnapshots([{ relativePath: "added.js", content: added }]);
    const after = publicGraphState(incremental);
    assert.ok(after.nodes.some(({ qualifiedName }) => qualifiedName === "added"));
    assert.ok(after.nodes.some(({ id }) => id === stable.id));
    assert.ok(after.edges.some(({ source, target, kind }) => source === untouchedEdge.source && target === untouchedEdge.target && kind === untouchedEdge.kind));

    for (const [relativePath, content] of Object.entries({ ...initial, "added.js": added })) {
      await writeFile(join(freshRoot, relativePath), content);
    }
    const fresh = await CodeGraph.init(freshRoot, { index: true });
    try {
      assert.deepEqual(after, publicGraphState(fresh));
    } finally {
      fresh.close();
    }
  } finally {
    incremental.close();
  }
});
