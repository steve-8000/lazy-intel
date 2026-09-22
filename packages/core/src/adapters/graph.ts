import { createHash } from "node:crypto";

import type {
  CanonicalAnchor,
  Coverage,
  EngineIssue,
  Evidence,
  GraphPort,
  GraphRequest,
  NativeAlias,
  ReadResult,
  RequestContext,
} from "../contracts.js";
import type { WorkerSupervisor } from "../runtime/supervisor.js";

export interface GraphAdapterOptions {
  readonly supervisor: WorkerSupervisor;
  readonly sourceRoot: string;
}
interface WireNode { readonly id: string; readonly kind: string; readonly name: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly [key: string]: unknown; }
interface WireEdge { readonly source: string; readonly target: string; readonly kind: string; readonly [key: string]: unknown; }
interface WireSubgraph { readonly nodes: WireNode[]; readonly edges: WireEdge[]; readonly roots: string[]; readonly confidence?: "high" | "low"; }
interface WireContextData {
  readonly context: { readonly query: string; readonly subgraph: WireSubgraph; readonly entryPoints: WireNode[]; readonly codeBlocks: readonly { readonly content: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly language: string; readonly node?: WireNode }[]; readonly summary: string };
  readonly callPaths: readonly { readonly nodeIds: readonly string[]; readonly synthesizedHops: readonly { readonly source: string; readonly target: string; readonly label: string }[] }[];
  readonly confidence?: "high" | "low";
}
interface WireResponse { readonly result: "context" | "subgraph"; readonly data?: WireContextData; readonly subgraph?: WireSubgraph; }
const graphCoverage = (returned: number, omitted: number | null = null): Coverage => ({ kind: "bounded_graph", completeWithinScope: false, scopeDescription: "CodeGraph indexed graph result bounded by the request depth and evidence limit", returned, omitted });

export function createGraphAdapter(options: GraphAdapterOptions): GraphPort {
  const getFileBytes = (relativePath: string, sources: GraphRequest["sources"] = []): Buffer => {
    const captured = sources.find((source) => source.relativePath === relativePath);
    if (!captured || captured.encoding !== "utf-8") throw new Error("captured source unavailable: " + relativePath);
    const bytes = Buffer.from(captured.content, "utf8");
    if (bytes.length !== captured.byteLength || createHash("sha256").update(bytes).digest("hex") !== captured.contentHash) throw new Error("captured source hash mismatch: " + relativePath);
    return bytes;
  };
  const alias = (nativeId: string, revision: string): NativeAlias => ({ engine: "codegraph", engineRevision: revision, nativeId });
  async function anchorFor(workspaceId: string, node: { readonly id: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly kind: string }, sources: GraphRequest["sources"] = []): Promise<CanonicalAnchor | null> {
    if (!node.filePath || !Number.isInteger(node.startLine) || !Number.isInteger(node.endLine) || node.startLine < 1 || node.endLine < node.startLine) return null;
    try {
      const bytes = getFileBytes(node.filePath, sources);
      const lineStart = (line: number): number => { if (line <= 1) return 0; let current = 1; for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 10 && ++current === line) return i + 1; } return bytes.length; };
      const startByte = lineStart(node.startLine);
      const endByte = node.endLine < Number.MAX_SAFE_INTEGER ? lineStart(node.endLine + 1) : bytes.length;
      const captured = sources.find((source) => source.relativePath === node.filePath);
      if (!captured || endByte <= startByte || endByte > bytes.length) return null;
      return { workspaceId, fileId: captured.fileId, relativePath: node.filePath, contentHash: captured.contentHash, span: { coordinateSystem: "utf8-bytes", startByte, endByte }, kind: node.kind, occurrenceId: node.id };
    } catch { return null; }
  }
  async function makeEvidence(workspaceId: string, revision: string, node: WireNode, kind: Evidence["kind"], text: string | null, projectionView: GraphRequest["view"] | null, textKind: "source" | "description", sources: GraphRequest["sources"] = []): Promise<Evidence | null> {
    const anchor = await anchorFor(workspaceId, node, sources);
    if (!anchor) return null;
    const observed = Buffer.from(sources.find((source) => source.relativePath === node.filePath)?.content ?? "", "utf8").subarray(anchor.span.startByte, anchor.span.endByte).toString("utf8");
    const evidenceText = textKind === "description" ? text : observed;
    return { id: "codegraph:" + kind + ":" + node.id, kind, anchor, aliases: [alias(node.id, revision)], method: "resolved_graph", sourceCheck: "unchecked", textKind, projectionView, semanticObservation: null, relevanceScore: null, text: evidenceText || null, coverage: graphCoverage(1) };
  }
  async function read(input: GraphRequest, context: RequestContext): Promise<ReadResult> {
    const stateRoot = input.view?.storeRoot;
    // A defined empty source snapshot is the authoritative graph state after
    // deleting the last file. Only an omitted snapshot is invalid input.
    const missingSources = input.sources === undefined;
    if (missingSources || !stateRoot || input.view?.state !== "clean") {
      const code: EngineIssue["code"] = missingSources ? "invalid_input" : input.view?.state === "needs_recovery" ? "needs_recovery" : "index_building";
      return { outcome: "unavailable", evidence: [], issues: [{ code, component: "graph", message: missingSources ? "indexed graph requires captured source snapshots" : input.view?.state === "needs_recovery" ? "graph store needs recovery" : "graph store is not cleanly published", retryable: code !== "invalid_input" }], coverage: graphCoverage(0), consistency: "unknown" };
    }
    const result = await options.supervisor.call<{ root: string; stateRoot: string; request: GraphRequest }, WireResponse>(input.operation, { root: options.sourceRoot, stateRoot, request: { ...input, sources: [] } }, context);
    if (!result.ok) {
      const issue: EngineIssue = { code: result.code === "cancelled" ? "cancelled" : result.code === "deadline" ? "deadline" : "worker_failed", component: "graph", message: result.message, retryable: result.retryable };
      return { outcome: result.code === "cancelled" ? "unavailable" : "error", evidence: [], issues: [issue], coverage: graphCoverage(0), consistency: "unknown" };
    }
    const payload = result.payload;
    const evidence: Evidence[] = [];
    const issues: EngineIssue[] = [];
    const revision = options.supervisor.upstreamCommit ?? "unknown";
    const workspaceId = context.workspaceId;
    const sources = input.sources ?? [];
    const subgraph = payload.result === "context" ? payload.data!.context.subgraph : payload.subgraph!;
    let omittedAnchors = 0;
    for (const node of subgraph.nodes) { if (evidence.length >= context.maxEvidence) break; const item = await makeEvidence(workspaceId, revision, node, input.operation === "impact" ? "impact" : "definition", node.name, input.view, "description", sources); if (item) evidence.push(item); else omittedAnchors += 1; }
    if (payload.result === "context") {
      const data = payload.data!;
      for (const block of data.context.codeBlocks) { if (evidence.length >= context.maxEvidence) break; const node = block.node ?? { id: "block:" + block.filePath + ":" + block.startLine, kind: "code", name: block.filePath, filePath: block.filePath, startLine: block.startLine, endLine: block.endLine }; const item = await makeEvidence(workspaceId, revision, node, "retrieval", block.content, input.view, "source", sources); if (item) evidence.push(item); else omittedAnchors += 1; }
      for (const callPath of data.callPaths) { if (evidence.length >= context.maxEvidence) break; const first = subgraph.nodes.find((node) => node.id === callPath.nodeIds[0]); if (!first) continue; const callNode = { ...first, id: "call:" + callPath.nodeIds.join(">"), kind: "call", name: callPath.nodeIds.map((id) => subgraph.nodes.find((node) => node.id === id)?.name ?? id).join(" -> ") }; const item = await makeEvidence(workspaceId, revision, callNode, "call", callPath.synthesizedHops.map((hop) => hop.label).join("; ") || null, input.view, "description", sources); if (!item) { omittedAnchors += 1; continue; } const relatedAnchors = (await Promise.all(callPath.nodeIds.slice(1).map(async (id) => { const node = subgraph.nodes.find((candidate) => candidate.id === id); return node ? anchorFor(workspaceId, node, sources) : null; }))).filter((anchor): anchor is CanonicalAnchor => anchor !== null).map((anchor) => ({ role: "target" as const, anchor })); evidence.push(relatedAnchors.length > 0 ? { ...item, relatedAnchors } : item); }
      if (data.confidence === "low") issues.push({ code: "ambiguous_subject", component: "graph", message: "CodeGraph context confidence is low; the returned entry points are not comprehensive.", retryable: false });
    } else if (subgraph.confidence === "low") issues.push({ code: "ambiguous_subject", component: "graph", message: "CodeGraph graph confidence is low; the returned nodes are not comprehensive.", retryable: false });
    if (omittedAnchors > 0) issues.push({ code: "output_truncated", component: "graph", message: "graph omitted nodes without matching captured source bytes", retryable: false });
    return { outcome: omittedAnchors > 0 ? "partial" : evidence.length === 0 ? "empty" : issues.length > 0 ? "partial" : result.outcome, evidence, issues, coverage: graphCoverage(evidence.length, omittedAnchors > 0 ? omittedAnchors : null), consistency: "captured-manifest" };
  }
  return { read, close: async () => options.supervisor.close() };
}
