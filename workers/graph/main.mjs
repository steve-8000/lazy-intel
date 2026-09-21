import { createRequire } from "node:module";

import { serveWorker, WorkerError } from "../../packages/core/dist/index.js";

const require = createRequire(import.meta.url);
const { CodeGraph, LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT } = require("../../vendor/codegraph/dist/lazy-entry.js");

// CodeGraph.open always runs migrations/healing despite its readOnly option.
// Keep exactly one handle per workspace so concurrent requests never open the
// same SQLite database twice and race those writes.
const handles = new Map();

async function graphFor(workspaceId, root) {
  const existing = handles.get(workspaceId);
  if (existing) {
    if (existing.root !== root) throw new WorkerError("invalid_request", "workspace root changed while graph worker was alive");
    return existing.graph;
  }
  const opening = CodeGraph.open(root, { sync: true });
  handles.set(workspaceId, { root, graph: opening });
  try {
    const graph = await opening;
    handles.set(workspaceId, { root, graph });
    return graph;
  } catch (error) {
    handles.delete(workspaceId);
    throw error;
  }
}

function asSubgraph(subgraph) {
  return { nodes: Array.from(subgraph.nodes.values(), (node) => ({ ...node })), edges: subgraph.edges, roots: subgraph.roots, confidence: subgraph.confidence };
}
function asContextData(data) {
  return {
    context: {
      ...data.context,
      subgraph: asSubgraph(data.context.subgraph),
      entryPoints: data.context.entryPoints.map((node) => ({ ...node })),
      codeBlocks: data.context.codeBlocks.map((block) => ({ ...block, ...(block.node ? { node: { ...block.node } } : {}) })),
    },
    callPaths: data.callPaths,
    confidence: data.confidence,
  };
}
function subjectId(graph, request) {
  const alias = request.subject?.nativeAlias;
  if (alias?.engine === "codegraph" && alias.nativeId) return alias.nativeId;
  const query = request.subject?.namePath || request.query;
  const match = graph.searchNodes(query, { limit: 1 })[0];
  if (!match) throw new WorkerError("invalid_request", "CodeGraph could not resolve the graph subject");
  return match.node.id;
}
async function handle(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.root !== "string" || !payload.request) {
    throw new WorkerError("invalid_request", "graph payload requires root and request");
  }
  const graph = await graphFor(payload.workspaceId, payload.root);
  const request = payload.request;
  if (request.operation === "context") {
    return { result: "context", data: asContextData(await graph.buildContextData(request.query, { traversalDepth: request.depth, maxNodes: request.limit ?? 20, format: "json" })) };
  }
  if (request.operation === "architecture") {
    return { result: "subgraph", subgraph: asSubgraph(await graph.findRelevantContext(request.query, { traversalDepth: request.depth, maxNodes: request.limit ?? 20 })) };
  }
  if (request.operation === "impact") {
    return { result: "subgraph", subgraph: asSubgraph(graph.getImpactRadius(subjectId(graph, request), request.depth)) };
  }
  throw new WorkerError("invalid_request", "unsupported graph operation: " + String(request.operation));
}

await serveWorker({
  kind: "graph",
  upstreamCommit: LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT,
  handlers: {
    context: async (payload, context) => ({ outcome: "ok", payload: await handle({ ...payload, workspaceId: context.workspaceId }) }),
    impact: async (payload, context) => ({ outcome: "ok", payload: await handle({ ...payload, workspaceId: context.workspaceId }) }),
    architecture: async (payload, context) => ({ outcome: "ok", payload: await handle({ ...payload, workspaceId: context.workspaceId }) }),
  },
  dispose: async () => {
    for (const { graph } of handles.values()) (await graph).close();
    handles.clear();
  },
});
