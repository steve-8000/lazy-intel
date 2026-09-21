import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  CanonicalAnchor,
  Coverage,
  EngineIssue,
  Evidence,
  NativeAlias,
  ReadResult,
  RequestContext,
  SemanticObservation,
  SemanticPort,
  SemanticRequest,
  WorkspaceId,
} from "../contracts.js";
import { WorkerSupervisor, type SupervisorOptions } from "../runtime/supervisor.js";

export interface SemanticAdapterOptions {
  readonly workspaceId: WorkspaceId;
  readonly sourceRoot: string;
  readonly scopeDigest: string;
  readonly buildContextDigest?: string | null;
  readonly serverProfileDigest?: string;
  readonly language: string;
  readonly languageServerPath?: string;
  readonly workerPath?: string;
  readonly workerEnv?: Readonly<Record<string, string>>;
  readonly fileIds?: Readonly<Record<string, string>>;
  readonly contentHashes?: Readonly<Record<string, string>>;
  readonly upstreamCommit?: string;
  readonly supervisor?: Omit<SupervisorOptions, "kind" | "modulePath" | "workspaceId">;
}

interface SemanticItem {
  readonly name_path?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly relative_path?: string;
  /** The file a reference occurs in, which may differ from the symbol's own file. */
  readonly reference_relative_path?: string;
  readonly location?: { readonly line?: number; readonly column?: number; readonly end_line?: number; readonly end_column?: number; readonly range?: { readonly start?: { readonly line?: number; readonly character?: number }; readonly end?: { readonly line?: number; readonly character?: number } } };
  readonly body_location?: { readonly start_line?: number; readonly end_line?: number };
  /** Literal source lines around a reference; comparable byte for byte with the file. */
  readonly context?: string | null;
  /** The same window with Serena's gutters, for a human reader. */
  readonly context_display?: string | null;
  readonly context_start_line?: number | null;
  readonly context_end_line?: number | null;
  readonly reference_line?: number;
  readonly reference_character?: number;
  /** Present when the caller asked for the body; it is the text the locator spans. */
  readonly body?: string | null;
}

interface SemanticPayload {
  readonly items?: readonly SemanticItem[];
  readonly observation?: Partial<SemanticObservation> & { readonly sessionEpoch?: string; readonly positionEncoding?: string; readonly scope?: string; readonly documentVersion?: number | null; readonly fileHash?: string | null };
  /** Present when the worker refused the read; carries why. */
  readonly message?: string;
}

/**
 * Semantic reads the vendored Serena fork actually backs, mapped to the worker
 * operation name. `implementations` and `diagnostics` are deliberately absent:
 * they are separate Serena tools that `lazy_read_api.py` does not expose, and
 * answering them from the file overview would be a confident wrong answer.
 */
const SEMANTIC_OPERATIONS: Partial<Record<SemanticRequest["operation"], string>> = {
  symbol: "symbol",
  references: "references",
};

function issue(code: EngineIssue["code"], message: string, retryable: boolean): EngineIssue {
  return { code, component: "semantic", message, retryable };
}

function coverage(returned: number, scopeDescription: string): Coverage {
  return { kind: "semantic_scope", completeWithinScope: true, scopeDescription, returned, omitted: 0 };
}

export function createSemanticAdapter(options: SemanticAdapterOptions): SemanticPort {
  const workerPath = options.workerPath ?? resolve(options.sourceRoot, "workers/semantic/main.mjs");
  const baseSupervisorOptions = { ...options.supervisor, kind: "semantic" as const, modulePath: workerPath, workspaceId: options.workspaceId };
  const supervisorOptions: SupervisorOptions = options.workerEnv === undefined ? baseSupervisorOptions : { ...baseSupervisorOptions, env: options.workerEnv };
  const supervisor = new WorkerSupervisor(supervisorOptions);
  function relativePath(input: SemanticItem, request: SemanticRequest): string | null {
    // For a reference, the file that matters is the one the reference occurs in,
    // not the file that happens to define the referencing symbol and not the file
    // the caller asked about. Falling back to either mislabels a cross-file hit.
    return input.reference_relative_path ?? input.relative_path ?? request.relativePath ?? request.subject?.relativePath ?? null;
  }

  function locationOf(item: SemanticItem): { startLine: number; startCharacter: number; endLine: number; endCharacter: number } | null {
    if (item.reference_line !== undefined) {
      // The evidence text for a reference is Serena's context window, so the span
      // must cover that whole window. Pointing it at the reference character alone
      // would make every source check compare three lines against one column and
      // report a mismatch that is structurally guaranteed, drowning out the real
      // mismatches that mean the file moved under us.
      const start = item.context_start_line ?? item.reference_line;
      const end = item.context_end_line ?? item.reference_line;
      return { startLine: start, startCharacter: 0, endLine: end, endCharacter: Number.MAX_SAFE_INTEGER };
    }
    const range = item.location?.range;
    if (range?.start) return { startLine: range.start.line ?? 0, startCharacter: range.start.character ?? 0, endLine: range.end?.line ?? range.start.line ?? 0, endCharacter: range.end?.character ?? (range.start.character ?? 0) + 1 };
    if (item.location?.line !== undefined) return { startLine: item.location.line, startCharacter: item.location.column ?? 0, endLine: item.location.end_line ?? item.location.line, endCharacter: item.location.end_column ?? (item.location.column ?? 0) + 1 };
    return null;
  }

  function byteOffset(path: string, line: number, character: number): number {
    try {
      const text = readFileSync(resolve(options.sourceRoot, path), "utf8");
      const lines = text.split(/\n/);
      let offset = 0;
      for (let i = 0; i < line && i < lines.length; i += 1) offset += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
      return offset + Buffer.byteLength((lines[line] ?? "").slice(0, character), "utf8");
    } catch {
      return 0;
    }
  }

  function observation(raw: SemanticPayload["observation"]): SemanticObservation {
    const positionEncoding = raw?.positionEncoding;
    const scope = raw?.scope;
    return {
      sessionEpoch: raw?.sessionEpoch ?? supervisor.epoch ?? "unknown",
      serverProfileDigest: options.serverProfileDigest ?? "serena",
      fileHash: raw?.fileHash ?? null,
      documentVersion: raw?.documentVersion ?? null,
      buildContextDigest: options.buildContextDigest ?? null,
      positionEncoding: positionEncoding === "utf-16" || positionEncoding === "utf-32" ? positionEncoding : "utf-8",
      scope: scope === "own-buffer" || scope === "unknown" ? scope : "disk-observed",
    };
  }

  function evidence(item: SemanticItem, request: SemanticRequest, obs: SemanticObservation, index: number): Evidence {
    const path = relativePath(item, request);
    const loc = locationOf(item);
    const nativeId = item.name_path ?? item.name ?? `${path ?? "unknown"}:${index}`;
    const aliases: readonly NativeAlias[] = [{ engine: "serena", engineRevision: options.upstreamCommit ?? supervisor.upstreamCommit ?? "unknown", nativeId }];
    let anchor: CanonicalAnchor | null = null;
    if (path !== null && loc !== null) {
      const startByte = byteOffset(path, loc.startLine, loc.startCharacter);
      const endByte = byteOffset(path, loc.endLine, loc.endCharacter);
      anchor = {
        workspaceId: options.workspaceId,
        fileId: options.fileIds?.[path] ?? path,
        relativePath: path,
        contentHash: options.contentHashes?.[path] ?? obs.fileHash ?? "unknown",
        span: { coordinateSystem: "utf8-bytes", startByte, endByte: Math.max(startByte, endByte) },
        kind: item.kind ?? "symbol",
        occurrenceId: `${path}:${loc.startLine}:${loc.startCharacter}:${nativeId}`,
      };
    }
    return {
      id: `serena-${index}-${nativeId}`,
      kind: request.operation === "references" ? "reference" : "definition",
      anchor,
      aliases,
      method: "lsp",
      sourceCheck: "unchecked",
      projectionView: null,
      semanticObservation: obs,
      relevanceScore: null,
      // The body is the text the locator actually spans, so it is what a source
      // check can verify. The reference context window and the bare name are
      // weaker fallbacks, used only when no body was requested or returned.
      text: item.body ?? item.context ?? item.name ?? null,
      coverage: coverage(1, path ? `Serena semantic result in ${path}` : "Serena semantic result"),
    };
  }

  return {
    async read(request: SemanticRequest, context: RequestContext): Promise<ReadResult> {
      // Only the two named-symbol reads are backed by the typed Serena surface.
      // `implementations` and `diagnostics` are separate Serena tools that the fork's
      // read API does not expose, and a file overview is not a diagnostics report.
      // Silently substituting one for the other would return confident wrong data.
      const operation = SEMANTIC_OPERATIONS[request.operation];
      if (operation === undefined) {
        return {
          outcome: "unavailable",
          evidence: [],
          issues: [issue("unsupported_capability", `the semantic worker does not implement ${request.operation}`, false)],
          coverage: coverage(0, "none"),
          consistency: "unknown",
        };
      }
      if (request.subject === null) {
        return { outcome: "error", evidence: [], issues: [issue("invalid_input", "semantic symbol operation requires a subject", false)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      const payload = {
        root: options.sourceRoot,
        language: options.language,
        languageServerPath: options.languageServerPath,
        namePath: request.subject?.namePath ?? "",
        relativePath: request.relativePath ?? request.subject?.relativePath ?? "",
        includeBody: request.includeBody,
      };
      const result = await supervisor.call<typeof payload, SemanticPayload>(operation, payload, { requestId: context.requestId, signal: context.signal, deadlineMonotonicMs: context.deadlineMonotonicMs });
      if (!result.ok) {
        const unavailable = result.code === "worker_failed" && result.message.includes("unavailable");
        const outcome = unavailable ? "unavailable" : result.code === "cancelled" ? "partial" : result.code === "deadline" ? "partial" : "error";
        const code: EngineIssue["code"] = result.code === "cancelled" ? "cancelled" : result.code === "deadline" ? "deadline" : "worker_failed";
        return { outcome, evidence: [], issues: [issue(code, result.message, result.retryable)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      const payloadResult = result.payload ?? {};
      if (result.outcome === "unavailable") {
        // The Python side refuses to provision a language server, which is the
        // point of the no-install policy. Losing its message would leave the
        // operator with a bare `unavailable` and nothing to act on.
        const refusal = payloadResult;
        const message = typeof refusal.message === "string" && refusal.message.length > 0
          ? refusal.message
          : "the semantic worker reported the capability as unavailable without a reason";
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", message, false)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      const obs = observation(payloadResult.observation);
      const items = payloadResult.items ?? [];
      const evidenceItems = items.map((item, index) => evidence(item, request, obs, index));
      return { outcome: result.outcome, evidence: evidenceItems, issues: [], coverage: coverage(evidenceItems.length, "Serena semantic scope"), consistency: "live-observation" };
    },
    async close(): Promise<void> { await supervisor.close(); },
  };
}
