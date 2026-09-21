import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

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

interface WireNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly [key: string]: unknown;
}
interface WireEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}
interface WireSubgraph {
  readonly nodes: WireNode[];
  readonly edges: WireEdge[];
  readonly roots: string[];
  readonly confidence?: "high" | "low";
}
interface WireContextData {
  readonly context: {
    readonly query: string;
    readonly subgraph: WireSubgraph;
    readonly entryPoints: WireNode[];
    readonly codeBlocks: readonly {
      readonly content: string;
      readonly filePath: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly language: string;
      readonly node?: WireNode;
    }[];
    readonly summary: string;
  };
  readonly callPaths: readonly {
    readonly nodeIds: readonly string[];
    readonly synthesizedHops: readonly { readonly source: string; readonly target: string; readonly label: string }[];
  }[];
  readonly confidence?: "high" | "low";
}
interface WireResponse {
  readonly result: "context" | "subgraph";
  readonly data?: WireContextData;
  readonly subgraph?: WireSubgraph;
}

const graphCoverage = (returned: number): Coverage => ({
  kind: "bounded_graph",
  completeWithinScope: false,
  scopeDescription: "CodeGraph indexed graph result bounded by the request depth and evidence limit",
  returned,
  omitted: null,
});

export function createGraphAdapter(options: GraphAdapterOptions): GraphPort {
  const getFileBytes = (cache: Map<string, Promise<Buffer>>, root: string, relativePath: string): Promise<Buffer> => {
    const key = root + "\0" + relativePath;
    let bytes = cache.get(key);
    if (!bytes) {
      bytes = readFile(resolve(root, relativePath));
      cache.set(key, bytes);
    }
    return bytes;
  };

  const alias = (nativeId: string, revision: string): NativeAlias => ({
    engine: "codegraph",
    engineRevision: revision,
    nativeId,
  });

  async function anchorFor(
    cache: Map<string, Promise<Buffer>>,
    root: string,
    workspaceId: string,
    node: { readonly id: string; readonly filePath: string; readonly startLine: number; readonly endLine: number; readonly kind: string },
  ): Promise<CanonicalAnchor | null> {
    if (!node.filePath || !Number.isInteger(node.startLine) || !Number.isInteger(node.endLine) || node.startLine < 1 || node.endLine < node.startLine) return null;
    try {
      const bytes = await getFileBytes(cache, root, node.filePath);
      const lineStart = (line: number): number => {
        if (line <= 1) return 0;
        let current = 1;
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] === 10 && ++current === line) return i + 1;
        }
        return bytes.length;
      };
      const startByte = lineStart(node.startLine);
      const endByte = node.endLine < Number.MAX_SAFE_INTEGER ? lineStart(node.endLine + 1) : bytes.length;
      return {
        workspaceId,
        fileId: workspaceId + ":" + node.filePath,
        relativePath: node.filePath,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        span: { coordinateSystem: "utf8-bytes", startByte, endByte },
        kind: node.kind,
        occurrenceId: node.id,
      };
    } catch {
      return null;
    }
  }

  async function makeEvidence(
    cache: Map<string, Promise<Buffer>>,
    root: string,
    workspaceId: string,
    revision: string,
    node: WireNode,
    kind: Evidence["kind"],
    text: string | null,
    relevanceScore: number | null = null,
    projectionView: GraphRequest["view"] | null = null,
  ): Promise<Evidence> {
    return {
      id: "codegraph:" + kind + ":" + node.id,
      kind,
      anchor: await anchorFor(cache, root, workspaceId, node),
      aliases: [alias(node.id, revision)],
      method: "resolved_graph",
      sourceCheck: "unchecked",
      projectionView,
      semanticObservation: null,
      relevanceScore,
      text,
      coverage: graphCoverage(1),
    };
  }

  async function read(input: GraphRequest, context: RequestContext): Promise<ReadResult> {
    const fileBytes = new Map<string, Promise<Buffer>>();
    const result = await options.supervisor.call<{ root: string; request: GraphRequest }, WireResponse>(
      input.operation,
      { root: options.sourceRoot, request: input },
      context,
    );
    if (!result.ok) {
      const issue: EngineIssue = {
        code: result.code === "cancelled" ? "cancelled" : result.code === "deadline" ? "deadline" : "worker_failed",
        component: "graph",
        message: result.message,
        retryable: result.retryable,
      };
      return { outcome: result.code === "cancelled" ? "unavailable" : "error", evidence: [], issues: [issue], coverage: graphCoverage(0), consistency: "unknown" };
    }

    const payload = result.payload;
    const evidence: Evidence[] = [];
    const issues: EngineIssue[] = [];
    const revision = options.supervisor.upstreamCommit ?? "unknown";
    const root = options.sourceRoot;
    const workspaceId = context.workspaceId;
    const subgraph = payload.result === "context" ? payload.data!.context.subgraph : payload.subgraph!;

    for (const node of subgraph.nodes) {
      if (evidence.length >= context.maxEvidence) break;
      evidence.push(await makeEvidence(fileBytes, root, workspaceId, revision, node, input.operation === "impact" ? "impact" : "definition", node.name, null, input.view));
    }

    if (payload.result === "context") {
      const data = payload.data!;
      for (const block of data.context.codeBlocks) {
        if (evidence.length >= context.maxEvidence) break;
        const node = block.node ?? { id: "block:" + block.filePath + ":" + block.startLine, kind: "code", name: block.filePath, filePath: block.filePath, startLine: block.startLine, endLine: block.endLine };
        evidence.push(await makeEvidence(fileBytes, root, workspaceId, revision, node, "retrieval", block.content, null, input.view));
      }
      for (const callPath of data.callPaths) {
        if (evidence.length >= context.maxEvidence) break;
        const first = subgraph.nodes.find((node) => node.id === callPath.nodeIds[0]);
        const last = subgraph.nodes.find((node) => node.id === callPath.nodeIds.at(-1));
        if (!first || !last) continue;
        const callNode = { ...first, id: "call:" + callPath.nodeIds.join(">"), kind: "call", name: callPath.nodeIds.map((id) => subgraph.nodes.find((node) => node.id === id)?.name ?? id).join(" -> "), endLine: last.endLine };
        const callEvidence = await makeEvidence(fileBytes, root, workspaceId, revision, callNode, "call", callPath.synthesizedHops.map((hop) => hop.label).join("; " ) || null, null, input.view);
        evidence.push(callEvidence);
      }
      if (data.confidence === "low") issues.push({ code: "ambiguous_subject", component: "graph", message: "CodeGraph context confidence is low; the returned entry points are not comprehensive.", retryable: false });
    } else if (subgraph.confidence === "low") {
      issues.push({ code: "ambiguous_subject", component: "graph", message: "CodeGraph graph confidence is low; the returned nodes are not comprehensive.", retryable: false });
    }

    return {
      outcome: evidence.length === 0 ? "empty" : issues.length > 0 ? "partial" : result.outcome,
      evidence,
      issues,
      coverage: graphCoverage(evidence.length),
      consistency: "unknown",
    };
  }

  return { read, close: async () => options.supervisor.close() };
}
