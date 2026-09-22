/** The typed retrieval port over the private zvec-grep worker. */

import { createHash } from "node:crypto";
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
  SourceSnapshot,
} from "../contracts.js";
import { WorkerSupervisor, type CallResult, type SupervisorOptions } from "../runtime/supervisor.js";

const ZVEC_UPSTREAM_COMMIT = "309a66995809243d3274fa8b5bea63ab11dda1a0";

type RetrievalWorkerOptions = {
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly rg?: boolean;
  readonly rgOptions?: Readonly<Record<string, unknown>>;
  readonly root: string;
  readonly stateRoot: string;
  readonly routes?: readonly { readonly mode: "fts" | "vector"; readonly query: string }[];
  readonly fuse?: boolean;
  readonly limit: number;
};

type WorkerContextPayload = {
  readonly stateRoot: string;
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
  /** The exact source excerpt range when the displayed entity range is broader. */
  readonly excerptRange?: WorkerRange;
  readonly content: string;
  readonly contentRole?: "source" | "outline";
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

/**
 * zvec-grep text ranges are UTF-16 code-unit offsets: tree-sitter's web
 * binding and line-based extractors expose offsets usable by String#slice.
 * Convert that native coordinate system at the adapter boundary before
 * publishing canonical UTF-8-byte anchors.
 */
function utf8ByteOffsetAtUtf16(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return -1;
  if (offset > 0 && offset < text.length && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff) return -1;
  return Buffer.byteLength(text.slice(0, offset), "utf8");
}

function textRangeToSpan(
  range: Extract<WorkerRange, { kind: "text" }>,
  item: WorkerContextItem,
  fileText: string,
): SourceSpan {
  const starts = lineStarts(fileText);
  const startLine = Math.max(1, range.startLine);
  const endLine = Math.max(startLine, range.endLine);
  const startLineOffset = starts[startLine - 1] ?? 0;
  const endLineOffset = starts[endLine - 1] ?? fileText.length;

  // Indexed extraction ranges are absolute UTF-16 offsets. Ripgrep context
  // ranges are line-relative UTF-16 columns (converted from ripgrep's byte
  // offsets by zvec-grep before crossing this boundary).
  if (item.kind === "indexed_entity") {
    return {
      coordinateSystem: "utf8-bytes",
      startByte: utf8ByteOffsetAtUtf16(fileText, range.startOffset),
      endByte: utf8ByteOffsetAtUtf16(fileText, range.endOffset),
    };
  }

  const charStart = startLineOffset + range.startOffset;
  const charEnd = endLineOffset + range.endOffset;
  return {
    coordinateSystem: "utf8-bytes",
    startByte: utf8ByteOffsetAtUtf16(fileText, charStart),
    endByte: utf8ByteOffsetAtUtf16(fileText, Math.max(charStart, charEnd)),
  };
}
function anchorFor(
  input: SearchRequest,
  item: WorkerContextItem,
): CanonicalAnchor | null {
  const source: SourceSnapshot | undefined = input.sources?.find(({ relativePath }) => relativePath === item.file.relativePath);
  if (!source || source.encoding !== "utf-8") return null;
  const bytes = Buffer.from(source.content, "utf8");
  if (bytes.length !== source.byteLength || sha256(bytes) !== source.contentHash) return null;
  const fileText = source.content;
  const range = item.contentRole === "source" ? item.excerptRange ?? item.range : item.range;
  let span: SourceSpan;
  switch (range.kind) {
    case "byte":
      span = { coordinateSystem: "utf8-bytes", startByte: range.startOffset, endByte: range.endOffset };
      break;
    case "text":
      span = textRangeToSpan(range, item, fileText);
      break;
    case "file":
      span = { coordinateSystem: "utf8-bytes", startByte: 0, endByte: bytes.length };
      break;
    default:
      return null;
  }
  const startByte = span.startByte;
  const endByte = span.endByte;
  if (startByte < 0 || endByte <= startByte || endByte > bytes.length) return null;
  const observed = bytes.subarray(startByte, endByte).toString("utf8");
  // Indexed source content is the native excerpt for this exact range. Keep
  // descriptions and lexical line matches separate: their displayed content
  // may intentionally be broader than the anchored match range.
  if (item.kind === "indexed_entity" && item.contentRole === "source" && observed !== item.content) return null;
  const relativePath = source.relativePath;
  const occurrenceId = sha256(Buffer.from(`${relativePath}\0${JSON.stringify(range)}`, "utf8"));
  const stableEntityId = item.entityId;
  return {
    workspaceId: input.scope.workspaceId,
    fileId: source.fileId,
    relativePath,
    contentHash: source.contentHash,
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
  const range = item.contentRole === "source" ? item.excerptRange ?? item.range : item.range;
  return item.entityId ?? sha256(Buffer.from(`${item.file.relativePath}\0${JSON.stringify(range)}`));
}

function evidenceFor(input: SearchRequest, result: WorkerContextResult, revision: string): Evidence[] {
  const coverage = coverageFor(result);
  return result.items.flatMap((item) => {
    const anchor = anchorFor(input, item);
    if (!anchor) return [];
    const source = input.sources?.find(({ relativePath }) => relativePath === item.file.relativePath);
    const capturedText = source
      ? Buffer.from(source.content, "utf8").subarray(anchor.span.startByte, anchor.span.endByte).toString("utf8")
      : "";
    const textKind = item.contentRole === "outline" ? "description" : "source";
    const nativeId = nativeIdFor(item);
    return [{
      id: "zvec:" + anchor.fileId + ":" + nativeId,
      kind: "retrieval",
      anchor,
      aliases: [{ engine: "zvec", engineRevision: revision, nativeId }],
      method: methodFor(item.matchedBy),
      sourceCheck: "unchecked",
      projectionView: input.view,
      semanticObservation: null,
      relevanceScore: item.score ?? null,
      textKind,
      text: textKind === "source" ? capturedText : item.content,
      coverage,
    }];
  });
}

function stateRootFor(input: SearchRequest): string {
  return input.mode === "exact" ? input.scope.canonicalStateRoot : input.view.storeRoot ?? input.scope.canonicalStateRoot;
}

function optionsFor(input: SearchRequest): RetrievalWorkerOptions {
  const common = { root: input.scope.canonicalSourceRoot, stateRoot: stateRootFor(input), limit: input.limit };
  switch (input.mode) {
    case "exact":
      return { ...common, query: input.query, rg: true };
    case "lexical":
      return { ...common, query: input.query, routes: [{ mode: "fts", query: input.query }] };
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
      const indexedView = input.mode === "exact" ? null : input.view;
      const storeRoot = stateRootFor(input);
      const missingSources = input.mode !== "exact" && input.sources === undefined;
      if (missingSources || !storeRoot || (indexedView !== null && indexedView.state !== "clean")) {
        const code: EngineIssue["code"] = missingSources
          ? "invalid_input"
          : indexedView?.state === "needs_recovery"
            ? "needs_recovery"
            : "index_building";
        return {
          outcome: "unavailable",
          evidence: [],
          issues: [makeIssue(code, missingSources ? "indexed retrieval requires captured source snapshots" : indexedView?.state === "needs_recovery" ? "retrieval store needs recovery" : "retrieval store is not cleanly published", code !== "invalid_input")],
          coverage: { kind: "unknown", completeWithinScope: null, scopeDescription: "retrieval store is not queryable", returned: 0, omitted: null },
          consistency: "unknown",
        };
      }
      const payload: WorkerContextPayload = {
        root: resolve(input.scope.canonicalSourceRoot),
        stateRoot: resolve(storeRoot),
        options: optionsFor(input),
      };
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
      const evidence = evidenceFor(input, result, supervisor.upstreamCommit ?? ZVEC_UPSTREAM_COMMIT);
      const issues: EngineIssue[] = [];
      if (result.diagnostics.emptyReason === "no_searchable_files") {
        issues.push(makeIssue("unsupported_capability", "no_searchable_files: zvec-grep found no searchable files", false));
      }
      const omittedAnchors = result.items.length - evidence.length;
      const effectiveCoverage = omittedAnchors > 0
        ? { ...coverage, completeWithinScope: false, omitted: omittedAnchors }
        : coverage;
      if (omittedAnchors > 0) {
        issues.push(makeIssue("output_truncated", "retrieval omitted hits without matching captured source bytes", false));
      }
      return {
        outcome: omittedAnchors > 0 ? "partial" : result.items.length === 0 ? "empty" : result.coverage === "rg_truncated" ? "partial" : "ok",
        evidence,
        issues,
        coverage: effectiveCoverage,
        consistency: "captured-manifest",
      };
    },
    close(): Promise<void> {
      return supervisor.close();
    },
  };
}
