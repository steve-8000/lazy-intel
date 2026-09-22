import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { CodeGraph } from "../../vendor/codegraph/dist/lazy-entry.js";
import { WorkerSupervisor, newRequestId } from "../../packages/core/dist/index.js";
import { createGraphAdapter } from "../../packages/core/dist/adapters/graph.js";

const source = [
  "export function start() { return middle(); }",
  "export function middle() { return finish(); }",
  "export function finish() { return 1; }",
  "",
].join("\n");

function snapshot(content, relativePath = "flow.js") {
  return { fileId: "graph-file:" + relativePath, relativePath, content, encoding: "utf-8", byteLength: Buffer.byteLength(content, "utf8"), contentHash: createHash("sha256").update(content).digest("hex"), observedSeq: "1" };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lazy-intel-graph-"));
  const stateRoot = join(root, ".state");
  await writeFile(join(root, "flow.js"), source);
  const graph = await CodeGraph.init(root, { index: true, stateRoot });
  return { root, stateRoot, graph };
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
  const { root, stateRoot, graph } = await fixture();
  graph.close();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspaceId = "graph-test-workspace";
  const supervisor = new WorkerSupervisor({ kind: "graph", workspaceId, modulePath: resolve("workers/graph/main.mjs") });
  const adapter = createGraphAdapter({ supervisor, sourceRoot: root });
  t.after(() => adapter.close());
  const view = { projection: "graph", viewId: "test-view", appliedManifestId: "test-manifest", profileDigest: "test-profile", state: "clean", storeRoot: stateRoot };
  const sources = [snapshot(source)];
  const request = { operation: "context", query: "start middle finish", subject: null, depth: 3, view, sources };
  const first = await adapter.read(request, callContext(workspaceId));
  assert.notEqual(first.outcome, "error");
  const nodeEvidence = first.evidence.find((item) => item.aliases[0]?.nativeId.startsWith("function:"));
  assert.ok(nodeEvidence);
  assert.equal(nodeEvidence.method, "resolved_graph");
  assert.equal(nodeEvidence.aliases[0].engine, "codegraph");
  assert.ok(nodeEvidence.anchor);
  assert.equal(nodeEvidence.anchor.fileId, "graph-file:flow.js");
  assert.equal(nodeEvidence.anchor.span.coordinateSystem, "utf8-bytes");
  assert.equal(nodeEvidence.textKind, "description");
  const second = await adapter.read(request, callContext(workspaceId));
  assert.equal(second.evidence.length, first.evidence.length);
  const architecture = await adapter.read({ ...request, operation: "architecture" }, callContext(workspaceId));
  assert.ok(architecture.evidence.length > 0);
  const impact = await adapter.read({ ...request, operation: "impact", subject: { namePath: "start", relativePath: "flow.js", anchor: null, nativeAlias: { engine: "codegraph", engineRevision: "dfccdf62547fcd76d343344d823a0e1998d3a89f", nativeId: nodeEvidence.aliases[0].nativeId } } }, callContext(workspaceId));
  assert.ok(impact.evidence.some((item) => item.kind === "impact"));
  assert.equal(supervisor.running, true);
});

test("graph adapter requires a clean published view and captured source snapshots", async (t) => {
  const { root, stateRoot, graph } = await fixture();
  graph.close();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspaceId = "graph-gate-workspace";
  const adapter = createGraphAdapter({ supervisor: new WorkerSupervisor({ kind: "graph", workspaceId, modulePath: resolve("workers/graph/main.mjs") }), sourceRoot: root });
  t.after(() => adapter.close());
  const base = { operation: "architecture", query: "start", subject: null, depth: 2, view: { projection: "graph", viewId: "v", appliedManifestId: "m", profileDigest: "p", state: "clean", storeRoot: stateRoot }, sources: [snapshot(source)] };
  const missingSources = await adapter.read({ ...base, sources: undefined }, callContext(workspaceId));
  assert.equal(missingSources.outcome, "unavailable");
  assert.equal(missingSources.issues[0].code, "invalid_input");
  const emptySources = await adapter.read({ ...base, sources: [] }, callContext(workspaceId));
  assert.notEqual(emptySources.issues[0]?.code, "invalid_input");
  const unpublished = await adapter.read({ ...base, view: { ...base.view, state: "needs_recovery" } }, callContext(workspaceId));
  assert.equal(unpublished.outcome, "unavailable");
  assert.equal(unpublished.issues[0].code, "needs_recovery");
});
