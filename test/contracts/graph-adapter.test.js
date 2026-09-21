import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CodeGraph } from "../../vendor/codegraph/dist/lazy-entry.js";
import { WorkerSupervisor, newRequestId } from "../../packages/core/dist/index.js";
import { createGraphAdapter } from "../../packages/core/dist/adapters/graph.js";

const view = { projection: "graph", viewId: "test-view", appliedManifestId: "test-manifest", profileDigest: "test-profile", state: "clean" };
const source = [
  "export function start() { return middle(); }",
  "export function middle() { return finish(); }",
  "export function finish() { return 1; }",
  "",
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lazy-intel-graph-"));
  await writeFile(join(root, "flow.js"), source);
  const graph = await CodeGraph.init(root, { index: true });
  return { root, graph };
}

function callContext(workspaceId) {
  return { requestId: newRequestId("graph-test"), workspaceId, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 60_000, maxEvidence: 100, maxOutputChars: 100_000, maxWireBytes: 8 * 1024 * 1024 };
}

test("typed context data retains graph facts and renders the same call path section", async (t) => {
  const { root, graph } = await fixture();
  t.after(async () => { graph.close(); await rm(root, { recursive: true, force: true }); });
  const options = { maxNodes: 20, maxCodeBlocks: 10, traversalDepth: 3, searchLimit: 10 };
  const data = await graph.buildContextData("start middle finish", options);
  assert.ok(data.context.subgraph.nodes.size >= 3);
  assert.ok(data.context.codeBlocks.length >= 3);
  assert.equal(data.callPaths.length, 1);
  assert.equal(data.callPaths[0].nodeIds.length, 3);
  for (const id of data.callPaths[0].nodeIds) assert.ok(data.context.subgraph.nodes.has(id));
  const markdown = await graph.buildContext("start middle finish", options);
  assert.equal(typeof markdown, "string");
  const names = data.callPaths[0].nodeIds.map((id) => data.context.subgraph.nodes.get(id).name);
  const nl = String.fromCharCode(10);
  const expectedCallPathSection = ["", "## Call paths", "", "Execution flow among the key symbols (traced through the call graph):", "", "- " + names.join(" → "), "", "_codegraph_node any symbol above for its source + its own callers/callees._", ""].join(nl);
  assert.ok(markdown.includes(expectedCallPathSection));
  assert.match(markdown, /export function start/);
});

test("graph adapter returns anchored native-id evidence and reuses worker handle", async (t) => {
  const { root, graph } = await fixture();
  graph.close();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspaceId = "graph-test-workspace";
  const supervisor = new WorkerSupervisor({ kind: "graph", workspaceId, modulePath: resolve("workers/graph/main.mjs") });
  const adapter = createGraphAdapter({ supervisor, sourceRoot: root });
  t.after(() => adapter.close());
  const request = { operation: "context", query: "start middle finish", subject: null, depth: 3, view };
  const first = await adapter.read(request, callContext(workspaceId));
  assert.notEqual(first.outcome, "error");
  const nodeEvidence = first.evidence.find((item) => item.aliases[0]?.nativeId.startsWith("function:"));
  assert.ok(nodeEvidence);
  assert.equal(nodeEvidence.method, "resolved_graph");
  assert.equal(nodeEvidence.aliases[0].engine, "codegraph");
  assert.ok(nodeEvidence.anchor);
  assert.equal(nodeEvidence.anchor.fileId, workspaceId + ":flow.js");
  assert.equal(nodeEvidence.anchor.span.coordinateSystem, "utf8-bytes");
  const second = await adapter.read(request, callContext(workspaceId));
  assert.equal(second.evidence.length, first.evidence.length);
  const architecture = await adapter.read({ ...request, operation: "architecture" }, callContext(workspaceId));
  assert.ok(architecture.evidence.length > 0);
  const impact = await adapter.read({ ...request, operation: "impact", subject: { namePath: "start", relativePath: "flow.js", anchor: null, nativeAlias: { engine: "codegraph", engineRevision: "dfccdf62547fcd76d343344d823a0e1998d3a89f", nativeId: nodeEvidence.aliases[0].nativeId } } }, callContext(workspaceId));
  assert.ok(impact.evidence.some((item) => item.kind === "impact"));
  assert.equal(supervisor.running, true);
});
