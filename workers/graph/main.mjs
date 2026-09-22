import { createRequire } from "node:module";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { serveWorker, WorkerError, readPreparedBatch } from "../../packages/core/dist/index.js";

const require = createRequire(import.meta.url);
const { CodeGraph, LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT } = require("../../vendor/codegraph/dist/lazy-entry.js");

const handles = new Map();
const keyFor = (workspaceId, stateRoot) => workspaceId + "\0" + stateRoot;
const sourceMapPath = (stateRoot) => join(stateRoot, ".codegraph", "lazy-source-snapshots.json");

async function loadSources(stateRoot) {
  try {
    const raw = JSON.parse(await readFile(sourceMapPath(stateRoot), "utf8"));
    return new Map(Object.entries(raw).filter(([, source]) => source && typeof source.content === "string"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}
async function saveSources(stateRoot, sources) {
  const directory = join(stateRoot, ".codegraph");
  await mkdir(directory, { recursive: true });
  const path = sourceMapPath(stateRoot);
  const temporary = path + ".tmp-" + process.pid + "-" + Date.now();
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(Object.fromEntries(sources)), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  try { const directoryHandle = await open(directory, "r"); await directoryHandle.sync(); await directoryHandle.close(); } catch { /* directory fsync is unavailable on some platforms */ }
}
function requireRoot(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.root !== "string" || typeof payload.stateRoot !== "string") {
    throw new WorkerError("invalid_request", "graph payload requires root and stateRoot");
  }
}

async function graphFor(workspaceId, root, stateRoot) {
  const key = keyFor(workspaceId, stateRoot);
  let handle = handles.get(key);
  if (handle) {
    if (handle.root !== root) throw new WorkerError("invalid_request", "workspace source root changed while graph worker was alive");
    await handle.ready;
    return handle;
  }
  try {
    // Attach both handlers before awaiting either promise. A missing fresh store
    // is an expected first-use condition during staged rebuild, not an unhandled
    // rejection that can terminate the worker before apply() initializes it.
    const opening = CodeGraph.open(root, { sync: false, stateRoot });
    const loadingSources = loadSources(stateRoot);
    handle = { root, stateRoot, graph: null, queue: Promise.resolve(), batches: new Map(), sources: new Map(), staged: new Map(), ready: null };
    const ready = Promise.all([opening, loadingSources]).then(([graph, sources]) => {
      handle.graph = graph;
      handle.sources = sources;
      return handle;
    });
    handle.ready = ready;
    handles.set(key, handle);
    await ready;
    return handle;
  } catch (error) {
    handles.delete(key);
    throw error;
  }
}
function serialized(handle, operation) {
  const next = handle.queue.then(operation, operation);
  handle.queue = next.catch(() => {});
  return next;
}
function asSubgraph(subgraph) {
  return { nodes: Array.from(subgraph.nodes.values(), (node) => ({ ...node })), edges: subgraph.edges, roots: subgraph.roots, confidence: subgraph.confidence };
}
function asContextData(data, sources) {
  const sourceByPath = new Map((sources ?? []).map((source) => [source.relativePath, source.content]));
  const lineSlice = (content, startLine, endLine) => content.split(/\n/).slice(Math.max(0, startLine - 1), endLine).join("\n");
  const blocks = data.context.codeBlocks.map((block) => {
    const content = sourceByPath.get(block.filePath);
    return content === undefined ? { ...block } : { ...block, content: lineSlice(content, block.startLine, block.endLine) };
  });
  return { context: { ...data.context, subgraph: asSubgraph(data.context.subgraph), entryPoints: data.context.entryPoints.map((node) => ({ ...node })), codeBlocks: blocks }, callPaths: data.callPaths, confidence: data.confidence };
}
function subjectId(graph, request) {
  const alias = request.subject?.nativeAlias;
  if (alias?.engine === "codegraph" && alias.nativeId) return alias.nativeId;
  const query = request.subject?.namePath || request.query;
  const match = graph.searchNodes(query, { limit: 1 })[0];
  if (!match) throw new WorkerError("invalid_request", "CodeGraph could not resolve the graph subject");
  return match.node.id;
}
function assertPublished(request, stateRoot) {
  const view = request?.view;
  if (!view || view.state !== "clean" || (view.storeRoot && view.storeRoot !== stateRoot)) {
    throw new WorkerError("invalid_request", "graph query requires a clean published view for this stateRoot");
  }
}
async function apply(payload, context) {
  requireRoot(payload);
  const batch = await readPreparedBatch(payload.stateRoot, payload.batchRef);
  if (!batch || typeof batch.batchId !== 'string' || typeof batch.manifestId !== 'string' || !Array.isArray(batch.sources) || !Array.isArray(batch.deletedPaths)) {
    throw new WorkerError("invalid_request", "graph apply requires a batch with sources and deletedPaths");
  }
  let handle;
  try { handle = await graphFor(context.workspaceId, payload.root, payload.stateRoot); }
  catch (error) {
    if (!batch.full || !/not initialized|does not exist/i.test(String(error?.message))) throw error;
    const graph = await CodeGraph.init(payload.root, { index: false, stateRoot: payload.stateRoot });
    const key = keyFor(context.workspaceId, payload.stateRoot);
    handle = { root: payload.root, stateRoot: payload.stateRoot, graph, queue: Promise.resolve(), batches: new Map(), sources: new Map(), staged: new Map(), ready: Promise.resolve() };
    handles.set(key, handle);
  }
  return serialized(handle, async () => {
    const replayKey = batch.batchId + "\0" + String(batch.part ?? 0);
    const replay = handle.batches.get(replayKey);
    if (replay) return replay;
    let pending = handle.staged.get(batch.batchId);
    if (!pending) {
      pending = { sources: batch.full ? new Map() : new Map(handle.sources), upserts: new Map(), deletedPaths: new Set(), full: batch.full, manifestId: batch.manifestId };
      handle.staged.set(batch.batchId, pending);
    }
    for (const source of batch.sources) { pending.sources.set(source.relativePath, source); pending.upserts.set(source.relativePath, source); }
    for (const deletedPath of batch.deletedPaths) { pending.sources.delete(deletedPath); pending.deletedPaths.add(deletedPath); }
    if (!batch.final) {
      const ack = { batchId: batch.batchId, part: batch.part, projection: "graph", state: "staged", manifestId: batch.manifestId, durableBoundary: null, storeRoot: payload.stateRoot };
      handle.batches.set(replayKey, ack);
      return ack;
    }
    if (pending.full) {
      handle.graph.close();
      handle.graph = await CodeGraph.recreate(payload.root, { stateRoot: payload.stateRoot });
    }
    const snapshots = [...pending.upserts.values()].map((source) => ({ relativePath: source.relativePath, content: source.content, modifiedAt: source.observedSeq ?? 0 }));
    const result = await handle.graph.syncSnapshots(snapshots, [...pending.deletedPaths], new Map([...pending.sources].map(([relativePath, source]) => [relativePath, source.content])));
    handle.sources = pending.sources;
    handle.staged.delete(batch.batchId);
    await saveSources(payload.stateRoot, handle.sources);
    const ack = { batchId: batch.batchId, part: batch.part ?? 0, projection: "graph", state: "applied", manifestId: batch.manifestId, durableBoundary: "codegraph.sqlite+source-manifest", storeRoot: payload.stateRoot, result };
    handle.batches.set(replayKey, ack);
    return ack;
  });
}

async function query(payload, context) {
  requireRoot(payload);
  const request = payload.request;
  if (!request || typeof request.operation !== "string") throw new WorkerError("invalid_request", "graph query requires request");
  assertPublished(request, payload.stateRoot);
  const handle = await graphFor(context.workspaceId, payload.root, payload.stateRoot);
  return serialized(handle, async () => {
    const sources = [...handle.sources.values()];
    if (request.operation === "context") {
      const data = await handle.graph.buildContextData(request.query, { traversalDepth: request.depth, maxNodes: request.limit ?? 20, format: "json" });
      return { result: "context", data: asContextData(data, sources) };
    }
    if (request.operation === "architecture") return { result: "subgraph", subgraph: asSubgraph(await handle.graph.findRelevantContext(request.query, { traversalDepth: request.depth, maxNodes: request.limit ?? 20 })) };
    if (request.operation === "impact") return { result: "subgraph", subgraph: asSubgraph(handle.graph.getImpactRadius(subjectId(handle.graph, request), request.depth)) };
    throw new WorkerError("invalid_request", "unsupported graph operation: " + String(request.operation));
  });
}
async function lifecycle(payload, context, operation) {
  requireRoot(payload);
  if (operation === "close-store") {
    const key = keyFor(context.workspaceId, payload.stateRoot);
    const handle = handles.get(key);
    if (!handle) return { closed: false, stateRoot: payload.stateRoot };
    await serialized(handle, async () => { handle.graph.close(); handles.delete(key); });
    return { closed: true, stateRoot: payload.stateRoot };
  }
  const handle = await graphFor(context.workspaceId, payload.root, payload.stateRoot);
  return serialized(handle, async () => ({ stats: handle.graph.getStats() }));
}
await serveWorker({
  kind: "graph",
  upstreamCommit: LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT,
  handlers: {
    apply: (payload, context) => apply(payload, context).then((ack) => ({ outcome: "ok", payload: ack })),
    context: (payload, context) => query(payload, context).then((result) => ({ outcome: "ok", payload: result })),
    impact: (payload, context) => query(payload, context).then((result) => ({ outcome: "ok", payload: result })),
    architecture: (payload, context) => query(payload, context).then((result) => ({ outcome: "ok", payload: result })),
    probe: (payload, context) => lifecycle(payload, context, "probe").then((result) => ({ outcome: "ok", payload: result })),
    "close-store": (payload, context) => lifecycle(payload, context, "close-store").then((result) => ({ outcome: "ok", payload: result })),
  },
  dispose: async () => {
    for (const handle of handles.values()) await serialized(handle, async () => handle.graph.close());
    handles.clear();
  },
});