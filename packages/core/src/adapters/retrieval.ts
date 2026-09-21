/** The typed retrieval port over the private zvec-grep worker. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CanonicalAnchor,
  Coverage,
  EngineIssue,
  Evidence,
  ReadResult,
  RetrievalPort,
  SearchRequest,
  SourceSpan,
} from "../contracts.js";
import { WorkerSupervisor, type CallResult, type SupervisorOptions } from "../runtime/supervisor.js";

const ZVEC_UPSTREAM_COMMIT = "309a66995809243d3274fa8b5bea63ab11dda1a0";

type RetrievalWorkerOptions = {
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly rg?: boolean;
  readonly rgOptions?: Readonly<Record<string, unknown>>;
  readonly root: string;
  readonly routes?: readonly { readonly mode: "fts" | "vector"; readonly query: string }[];
  readonly fuse?: boolean;
  readonly limit: number;
};

type WorkerContextPayload = {
  readonly root: string;
  readonly options: RetrievalWorkerOptions;
};

type WorkerContextResult = {
  readonly query: string;
  readonly root: string;
  readonly source: "index" | "rg";
  readonly coverage: "ranked_sample" | "rg_exhaustive" | "rg_truncated";
  readonly items: readonly WorkerContextItem[];
  readonly diagnostics: {
    readonly emptyReason?: "no_matches" | "no_searchable_files";
  };
};

type WorkerContextItem = {
  readonly kind: "indexed_entity" | "lexical_match";
  readonly rank: number;
  readonly file: { readonly absolutePath: string; readonly relativePath: string };
  readonly range: WorkerRange;
  readonly content: string;
  readonly matchedBy: "fts" | "vector" | "fts+vector" | "lexical";
  readonly score?: number;
  readonly entityId?: string;
};

type WorkerRange =
  | { readonly kind: "file" }
  | { readonly kind: "byte"; readonly startOffset: number; readonly endOffset: number }
  | { readonly kind: "text"; readonly startLine: number; readonly endLine: number; readonly startOffset: number; readonly endOffset: number }
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "page_text"; readonly page: number; readonly startOffset: number; readonly endOffset: number }
  | { readonly kind: "page_region"; readonly page: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export interface RetrievalAdapterOptions {
  readonly workspaceId?: string;
  readonly workerPath?: string;
  readonly supervisor?: Omit<SupervisorOptions, "kind" | "modulePath" | "workspaceId">;
}

export interface RetrievalAdapter extends RetrievalPort {
  readonly supervisor: WorkerSupervisor;
}

function defaultWorkerPath(): string {
  return fileURLToPath(new URL("../../../../workers/retrieval/main.mjs", import.meta.url));
}

function makeIssue(
  code: EngineIssue["code"],
  message: string,
  retryable: boolean,
): EngineIssue {
  return { code, component: "retrieval", message, retryable };
}

function coverageFor(result: WorkerContextResult): Coverage {
  const kind = result.coverage;
  return {
    kind,
    completeWithinScope: kind === "rg_exhaustive" ? true : kind === "rg_truncated" ? false : false,
    scopeDescription: `source=${result.source}; zvec-grep ${kind}`,
    returned: result.items.length,
    omitted: kind === "rg_exhaustive" ? 0 : null,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function byteOffsetAtCharacter(text: string, offset: number): number {
  return Buffer.byteLength(text.slice(0, Math.max(0, offset)), "utf8");
}

function textRangeToSpan(
  range: Extract<WorkerRange, { kind: "text" }>,
  item: WorkerContextItem,
  fileText: string,
  fileBytes: Buffer,
): SourceSpan {
  const starts = lineStarts(fileText);
  const startLine = Math.max(1, range.startLine);
  const endLine = Math.max(startLine, range.endLine);
  const startLineOffset = starts[startLine - 1] ?? 0;
  const endLineOffset = starts[endLine - 1] ?? fileText.length;

  // Indexed code entities use tree-sitter byte offsets or extractor-wide character
  // offsets, while ripgrep context items use line-relative character columns. The
  // source bytes let us distinguish the two without pretending the units agree.
  if (item.kind === "indexed_entity") {
    const byteStart = range.startOffset;
    const byteEnd = range.endOffset;
    if (byteStart >= 0 && byteEnd >= byteStart && byteEnd <= fileBytes.length) {
      const candidate = fileBytes.subarray(byteStart, byteEnd).toString("utf8");
      if (candidate.length > 0 && item.content.includes(candidate.slice(0, Math.min(candidate.length, 16)))) {
        return { coordinateSystem: "utf8-bytes", startByte: byteStart, endByte: byteEnd };
      }
    }

    const charStart = range.startOffset >= startLineOffset ? range.startOffset : startLineOffset + range.startOffset;
    const charEnd = range.endOffset >= endLineOffset ? range.endOffset : endLineOffset + range.endOffset;
    return {
      coordinateSystem: "utf8-bytes",
      startByte: byteOffsetAtCharacter(fileText, charStart),
      endByte: byteOffsetAtCharacter(fileText, Math.max(charStart, charEnd)),
    };
  }

  const charStart = startLineOffset + range.startOffset;
  const charEnd = endLineOffset + range.endOffset;
  return {
    coordinateSystem: "utf8-bytes",
    startByte: byteOffsetAtCharacter(fileText, charStart),
    endByte: byteOffsetAtCharacter(fileText, Math.max(charStart, charEnd)),
  };
}

function anchorFor(
  input: SearchRequest,
  item: WorkerContextItem,
): CanonicalAnchor | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(item.file.absolutePath);
  } catch {
    return null;
  }
  const fileText = bytes.toString("utf8");
  let span: SourceSpan;
  switch (item.range.kind) {
    case "byte":
      span = { coordinateSystem: "utf8-bytes", startByte: item.range.startOffset, endByte: item.range.endOffset };
      break;
    case "text":
      span = textRangeToSpan(item.range, item, fileText, bytes);
      break;
    case "file":
      span = { coordinateSystem: "utf8-bytes", startByte: 0, endByte: bytes.length };
      break;
    default:
      return null;
  }
  const relativePath = item.file.relativePath;
  const fileId = `zvec:${input.scope.workspaceId}:${relativePath}`;
  const occurrenceId = sha256(Buffer.from(`${relativePath}\0${JSON.stringify(item.range)}`));
  const stableEntityId = item.entityId;
  return {
    workspaceId: input.scope.workspaceId,
    fileId,
    relativePath,
    contentHash: sha256(bytes),
    span,
    kind: item.kind,
    occurrenceId,
    ...(stableEntityId ? { stableEntityId } : {}),
  };
}

function methodFor(matchedBy: WorkerContextItem["matchedBy"]): Evidence["method"] {
  if (matchedBy === "vector") return "vector";
  if (matchedBy === "fts+vector") return "hybrid";
  return "lexical";
}

function nativeIdFor(item: WorkerContextItem): string {
  return item.entityId ?? sha256(Buffer.from(`${item.file.relativePath}\0${JSON.stringify(item.range)}`));
}

function evidenceFor(input: SearchRequest, result: WorkerContextResult, revision: string): Evidence[] {
  const coverage = coverageFor(result);
  return result.items.map((item) => ({
    id: `zvec:${nativeIdFor(item)}`,
    kind: "retrieval",
    anchor: anchorFor(input, item),
    aliases: [{ engine: "zvec", engineRevision: revision, nativeId: nativeIdFor(item) }],
    method: methodFor(item.matchedBy),
    sourceCheck: "unchecked",
    projectionView: input.view,
    semanticObservation: null,
    relevanceScore: item.score ?? null,
    text: item.content,
    coverage,
  }));
}

function optionsFor(input: SearchRequest): RetrievalWorkerOptions {
  const common = { root: input.scope.canonicalSourceRoot, limit: input.limit };
  switch (input.mode) {
    case "exact":
      return { ...common, query: input.query, rg: true, rgOptions: { fixedStrings: true } };
    case "lexical":
      return { ...common, query: input.query, rg: true };
    case "semantic":
      return { ...common, query: input.query, routes: [{ mode: "vector", query: input.query }] };
    case "hybrid":
      return {
        ...common,
        query: input.query,
        routes: [
          { mode: "fts", query: input.query },
          { mode: "vector", query: input.query },
        ],
        fuse: true,
      };
  }
}

type FailedCall = Extract<CallResult<unknown>, { readonly ok: false }>;

function resultForFailure(call: FailedCall): ReadResult {
  const code: EngineIssue["code"] = call.code === "payload_too_large" ? "output_truncated" : call.code === "cancelled" ? "cancelled" : call.code === "deadline" ? "deadline" : call.code === "invalid_request" ? "invalid_input" : "worker_failed";
  return {
    outcome: code === "output_truncated" ? "partial" : "unavailable",
    evidence: [],
    issues: [makeIssue(code, call.message, call.retryable)],
    coverage: { kind: "unknown", completeWithinScope: null, scopeDescription: "retrieval worker unavailable", returned: 0, omitted: null },
    consistency: "unknown",
  };
}

export function createRetrievalAdapter(options: RetrievalAdapterOptions = {}): RetrievalAdapter {
  const supervisorOptions = options.supervisor ?? {};
  const supervisor = new WorkerSupervisor({
    ...supervisorOptions,
    kind: "retrieval",
    modulePath: options.workerPath ?? defaultWorkerPath(),
    workspaceId: options.workspaceId ?? "retrieval",
  });

  return {
    supervisor,
    async read(input, context): Promise<ReadResult> {
      const payload: WorkerContextPayload = { root: resolve(input.scope.canonicalSourceRoot), options: optionsFor(input) };
      const call = await supervisor.call<WorkerContextPayload, WorkerContextResult>("context", payload, {
        requestId: context.requestId,
        signal: context.signal,
        deadlineMonotonicMs: context.deadlineMonotonicMs,
      });
      if (!call.ok) {
        if (call.code === "cancelled") {
          const error = new Error(call.message) as Error & { code: string; retryable: boolean };
          error.code = "cancelled";
          error.retryable = false;
          throw error;
        }
        return resultForFailure(call);
      }
      const result = call.payload;
      const coverage = coverageFor(result);
      const issues: EngineIssue[] = [];
      if (result.diagnostics.emptyReason === "no_searchable_files") {
        issues.push(makeIssue("unsupported_capability", "no_searchable_files: zvec-grep found no searchable files", false));
      }
      return {
        outcome: result.items.length === 0 ? "empty" : result.coverage === "rg_truncated" ? "partial" : "ok",
        evidence: evidenceFor(input, result, supervisor.upstreamCommit ?? ZVEC_UPSTREAM_COMMIT),
        issues,
        coverage,
        consistency: "live-observation",
      };
    },
    close(): Promise<void> {
      return supervisor.close();
    },
  };
}
