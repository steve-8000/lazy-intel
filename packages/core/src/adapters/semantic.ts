import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative as relativeFsPath, resolve } from "node:path";

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
  readonly trustedForLanguageTools?: boolean;
  readonly workerPath?: string;
  readonly workerEnv?: Readonly<Record<string, string>>;
  readonly fileIds?: Readonly<Record<string, string>>;
  readonly contentHashes?: Readonly<Record<string, string>>;
  readonly upstreamCommit?: string;
  readonly supervisor?: Omit<SupervisorOptions, "kind" | "modulePath" | "workspaceId">;
}

interface SourceSnapshot {
  readonly bytes: Buffer;
  readonly hash: string;
}

interface SemanticItem {
  readonly name_path?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly relative_path?: string;
  readonly file_hash?: string | null;
  readonly containing_file_hash?: string | null;
  readonly reference_relative_path?: string;
  readonly location?: { readonly line?: number; readonly column?: number; readonly end_line?: number; readonly end_column?: number; readonly range?: { readonly start?: { readonly line?: number; readonly character?: number }; readonly end?: { readonly line?: number; readonly character?: number } } };
  readonly range?: { readonly start?: { readonly line?: number; readonly character?: number }; readonly end?: { readonly line?: number; readonly character?: number } };
  readonly body_location?: { readonly start_line?: number; readonly end_line?: number };
  readonly context?: string | null;
  /** The same window with Serena's gutters, for a human reader. */
  readonly context_display?: string | null;
  readonly context_start_line?: number | null;
  readonly context_end_line?: number | null;
  readonly reference_line?: number;
  readonly reference_character?: number;
  /** Present when the caller asked for the body; it is the text the locator spans. */
  readonly body?: string | null;
  readonly message?: string;
  readonly severity?: number;
  readonly diagnostic?: boolean;
}

interface SemanticPayload { readonly items?: readonly SemanticItem[]; readonly truncated?: boolean; readonly omitted?: number; readonly observation?: Partial<SemanticObservation> & { readonly sessionEpoch?: string; readonly positionEncoding?: string; readonly scope?: string; readonly documentVersion?: number | null; readonly fileHash?: string | null; readonly bufferHash?: string | null }; readonly message?: string; }

/**
 * Serena's typed read API backs symbols, references, implementations, and file diagnostics.
 */
const SEMANTIC_OPERATIONS: Partial<Record<SemanticRequest["operation"], string>> = {
  symbol: "symbol",
  references: "references",
  implementations: "implementations",
  diagnostics: "diagnostics",
};

function issue(code: EngineIssue["code"], message: string, retryable: boolean): EngineIssue {
  return { code, component: "semantic", message, retryable };
}

function coverage(returned: number, scopeDescription: string, completeWithinScope = true, omitted: number | null = 0): Coverage { return { kind: "semantic_scope", completeWithinScope, scopeDescription, returned, omitted }; }

function canonicalExecutable(path: string): string | null {
  try {
    const canonical = realpathSync(path);
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}
export function createSemanticAdapter(options: SemanticAdapterOptions): SemanticPort {
  const canonicalRoot = (() => { try { return realpathSync(options.sourceRoot); } catch { return resolve(options.sourceRoot); } })();
  function safeRelativePath(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || /(?:^[A-Za-z][A-Za-z0-9+.-]*:|^[A-Za-z]:[\\/]|^[/\\])/.test(raw)) return null;
    if (raw.split(/[\\/]/).includes("..")) return null;
    const candidate = resolve(canonicalRoot, raw);
    const relative = relativeFsPath(canonicalRoot, candidate);
    if (isAbsolute(relative) || relative === ".." || relative.startsWith(".." + "/") || relative.startsWith(".." + "\\")) return null;
    try {
      const canonical = realpathSync(candidate);
      const canonicalRelative = relativeFsPath(canonicalRoot, canonical);
      if (isAbsolute(canonicalRelative) || canonicalRelative === ".." || canonicalRelative.startsWith(".." + "/") || canonicalRelative.startsWith(".." + "\\")) return null;
    } catch { return null; }
    return raw;
  }
  const workerPath = options.workerPath ?? resolve(options.sourceRoot, "workers/semantic/main.mjs");
  const serverProfileDigest = options.serverProfileDigest ?? createHash("sha256").update(JSON.stringify({ engine: "serena", language: options.language, languageServerPath: options.languageServerPath ? canonicalExecutable(options.languageServerPath) ?? options.languageServerPath : null, upstreamCommit: options.upstreamCommit ?? null, protocol: "lazy-read-api-v1" })).digest("hex");
  const baseSupervisorOptions = { ...options.supervisor, kind: "semantic" as const, modulePath: workerPath, workspaceId: options.workspaceId };
  const supervisorOptions: SupervisorOptions = options.workerEnv === undefined ? baseSupervisorOptions : { ...baseSupervisorOptions, env: options.workerEnv };
  const supervisor = new WorkerSupervisor(supervisorOptions);
  function relativePath(input: SemanticItem, request: SemanticRequest): string | null {
    // not the file that happens to define the referencing symbol and not the file
    // the caller asked about. Falling back to either mislabels a cross-file hit.
    return input.reference_relative_path ?? input.relative_path ?? request.relativePath ?? request.subject?.relativePath ?? null;
  }

  function validInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
  function locationOf(item: SemanticItem, reference = true): { startLine: number; startCharacter: number; endLine: number; endCharacter: number } | null {
    if (reference && item.reference_line !== undefined) {
      const start = item.context_start_line ?? item.reference_line; const end = item.context_end_line ?? item.reference_line;
      if (!validInteger(start) || !validInteger(end) || end < start) return null;
      if (item.context?.endsWith("\n")) return { startLine: start, startCharacter: 0, endLine: end + 1, endCharacter: 0 };
      return { startLine: start, startCharacter: 0, endLine: end, endCharacter: Number.MAX_SAFE_INTEGER };
    }
    if (!reference && item.body_location?.start_line !== undefined) {
      const start = item.body_location.start_line; const end = item.body_location.end_line ?? start;
      if (!validInteger(start) || !validInteger(end) || end < start) return null;
      return { startLine: start, startCharacter: 0, endLine: end, endCharacter: Number.MAX_SAFE_INTEGER };
    }
    const range = item.location?.range;
    if (range?.start && range.end && validInteger(range.start.line) && validInteger(range.start.character) && validInteger(range.end.line) && validInteger(range.end.character)) return { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
    const location = item.location;
    if (location?.line !== undefined && validInteger(location.line) && validInteger(location.column) && (location.end_line === undefined || (validInteger(location.end_line) && validInteger(location.end_column)))) return { startLine: location.line, startCharacter: location.column, endLine: location.end_line ?? location.line, endCharacter: location.end_column ?? location.column + 1 };
    return null;
  }
  function snapshot(path: string, cache: Map<string, SourceSnapshot>): SourceSnapshot | null {
    const existing = cache.get(path); if (existing) return existing;
    try { const ownedPath = safeRelativePath(path); if (ownedPath === null) return null; const bytes = readFileSync(resolve(canonicalRoot, ownedPath)); const next = { bytes, hash: createHash("sha256").update(bytes).digest("hex") }; cache.set(path, next); return next; } catch { return null; }
  }

  function byteOffset(source: SourceSnapshot, line: number, character: number, positionEncoding: "utf-8" | "utf-16" | "utf-32"): number | null {
    const text = source.bytes.toString("utf8"); const lines = text.split(/\n/); if (!validInteger(line) || line >= lines.length || !validInteger(character)) return null;
    let offset = 0; for (let i = 0; i < line; i += 1) offset += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
    const rawLine = lines[line] ?? ""; const sourceLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine; let prefix: string;
    if (character === Number.MAX_SAFE_INTEGER) prefix = sourceLine;
    else if (positionEncoding === "utf-8") { const bytes = Buffer.from(sourceLine, "utf8"); if (character > bytes.length) return null; const candidate = bytes.subarray(0, character); prefix = candidate.toString("utf8"); if (!Buffer.from(prefix, "utf8").equals(candidate)) return null; }
    else if (positionEncoding === "utf-32") { const chars = Array.from(sourceLine); if (character > chars.length) return null; prefix = chars.slice(0, character).join(""); }
    else { if (character > sourceLine.length || (character > 0 && character < sourceLine.length && sourceLine.charCodeAt(character - 1) >= 0xd800 && sourceLine.charCodeAt(character - 1) <= 0xdbff && sourceLine.charCodeAt(character) >= 0xdc00 && sourceLine.charCodeAt(character) <= 0xdfff)) return null; prefix = sourceLine.slice(0, character); }
    return offset + Buffer.byteLength(prefix, "utf8");
  }

  function observation(raw: SemanticPayload["observation"]): SemanticObservation {
    const positionEncoding = raw?.positionEncoding; const scope = raw?.scope;
    return {
      sessionEpoch: raw?.sessionEpoch ?? supervisor.epoch ?? "unknown", serverProfileDigest,
      fileHash: raw?.fileHash ?? null, bufferHash: raw?.bufferHash ?? null, documentVersion: raw?.documentVersion ?? null,
      buildContextDigest: options.buildContextDigest ?? null,
      positionEncoding: positionEncoding === "utf-8" || positionEncoding === "utf-32" ? positionEncoding : "utf-16",
      scope: scope === "own-buffer" || scope === "disk-observed" || scope === "unknown" ? scope : "unknown",
      ...(raw?.relativePath ? { relativePath: raw.relativePath } : {}), diagnosticsStatus: raw?.diagnosticsStatus ?? "not_reported",
    };
  }
  function anchorFor(path: string | null, loc: ReturnType<typeof locationOf>, obs: SemanticObservation, kind: string, nativeId: string, cache: Map<string, SourceSnapshot>, expectedHash: string | null, sourceChanged: Set<string>, unanchored: Set<string>, incomplete: Set<string>): CanonicalAnchor | null {
    if (path === null) { incomplete.add("missing semantic path"); return null; }
    if (safeRelativePath(path) === null) { incomplete.add("semantic path is outside the workspace"); return null; }
    if (loc === null) { incomplete.add("missing or invalid semantic location"); return null; }
    if (obs.scope === "unknown") { incomplete.add("semantic scope is unknown"); return null; }
    const source = snapshot(path, cache); if (source === null) { unanchored.add(path); return null; }
    if (expectedHash !== null && expectedHash !== source.hash) { sourceChanged.add(path); return null; }
    const startByte = byteOffset(source, loc.startLine, loc.startCharacter, obs.positionEncoding);
    const endByte = byteOffset(source, loc.endLine, loc.endCharacter, obs.positionEncoding);
    if (startByte === null || endByte === null || endByte < startByte) { incomplete.add("semantic location is outside the source snapshot"); return null; }
    return { workspaceId: options.workspaceId, fileId: options.fileIds?.[path] ?? path, relativePath: path, contentHash: source.hash, span: { coordinateSystem: "utf8-bytes", startByte, endByte }, kind, occurrenceId: path + ":" + loc.startLine + ":" + loc.startCharacter + ":" + nativeId };
  }


  function evidence(item: SemanticItem, request: SemanticRequest, obs: SemanticObservation, index: number, cache: Map<string, SourceSnapshot>, sourceChanged: Set<string>, unanchored: Set<string>, incomplete: Set<string>): Evidence {
    const path = relativePath(item, request); const normalizedItem: SemanticItem = item.location || !item.range ? item : { ...item, location: { range: item.range } };
    const loc = locationOf(normalizedItem, request.operation === "references"); const nativeId = item.name_path ?? item.name ?? (path ?? "unknown") + ":" + index;
    const kind: Evidence["kind"] = item.diagnostic || request.operation === "diagnostics" ? "diagnostic" : request.operation === "references" ? "reference" : request.operation === "implementations" ? "implementation" : "definition";
    const aliases: readonly NativeAlias[] = [{ engine: "serena", engineRevision: options.upstreamCommit ?? supervisor.upstreamCommit ?? "unknown", nativeId }];
    const expectedHash = item.file_hash ?? (obs.relativePath === path ? obs.fileHash : null);
    const anchor = anchorFor(path, loc, obs, item.kind ?? kind, nativeId, cache, expectedHash, sourceChanged, unanchored, incomplete);
    const containingPath = item.relative_path ?? item.reference_relative_path ?? null; const containingExpectedHash = item.containing_file_hash ?? (obs.relativePath === containingPath ? obs.fileHash : null);
    const containingLocation = locationOf(item, false) ?? locationOf(item, true);
    const containingAnchor = request.operation === "references" && containingPath !== null ? anchorFor(containingPath, containingLocation, { ...obs, fileHash: containingExpectedHash }, item.kind ?? "symbol", nativeId, cache, containingExpectedHash, sourceChanged, unanchored, incomplete) : null;
    const textKind = anchor && !(item.diagnostic || request.operation === "diagnostics") && (item.body !== undefined || (request.operation === "references" && item.context !== undefined)) ? "source" : "description";
    const text = anchor && request.operation === "references" ? item.context ?? item.name ?? null : anchor ? item.body ?? item.context ?? item.message ?? item.name ?? null : item.diagnostic || request.operation === "diagnostics" ? item.message ?? item.name ?? null : item.name ?? null;
    return { id: "serena-" + index + "-" + nativeId, kind, anchor, aliases, method: "lsp", sourceCheck: "unchecked", projectionView: null, semanticObservation: obs, relevanceScore: null, ...(containingAnchor ? { relatedAnchors: [{ role: "containing-symbol" as const, anchor: containingAnchor }] } : {}), textKind, text, coverage: coverage(1, path ? "Serena semantic result in " + path : "Serena semantic result", anchor !== null, anchor === null ? 1 : 0) } as Evidence;
  }

  return {
    async read(request: SemanticRequest, context: RequestContext): Promise<ReadResult> {
      const operation = SEMANTIC_OPERATIONS[request.operation];
      if (operation === undefined) {
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", `the semantic worker does not implement ${request.operation}`, false)], coverage: coverage(0, "none", false), consistency: "unknown" };
      }
      if (!options.languageServerPath || !isAbsolute(options.languageServerPath)) {
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", "no language_server_path supplied; lazy semantic mode never downloads language servers", false)], coverage: coverage(0, "none", false), consistency: "unknown" };
      }
      const canonicalLanguageServerPath = canonicalExecutable(options.languageServerPath);
      if (canonicalLanguageServerPath === null) {
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", `configured language server is not an executable path: ${options.languageServerPath}`, false)], coverage: coverage(0, "none", false), consistency: "unknown" };
      }
      if (options.trustedForLanguageTools !== true) {
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", "semantic language tools are not trusted for this workspace", false)], coverage: coverage(0, "none", false), consistency: "unknown" };
      }
      if (request.subject === null && request.operation !== "diagnostics") {
        return { outcome: "error", evidence: [], issues: [issue("invalid_input", "semantic symbol operation requires a subject", false)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      if (request.operation === "diagnostics" && !request.relativePath) {
        return { outcome: "error", evidence: [], issues: [issue("invalid_input", "diagnostics requires relativePath", false)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      const payload = {
        root: options.sourceRoot,
        language: options.language,
        languageServerPath: canonicalLanguageServerPath,
        namePath: request.subject?.namePath ?? "",
        relativePath: request.relativePath ?? request.subject?.relativePath ?? "",
        includeBody: request.includeBody,
        depth: request.depth ?? 0,
        substringMatching: request.substringMatching ?? false,
        maxMatches: request.maxMatches ?? -1,
        includeKinds: request.includeKinds ?? [],
        excludeKinds: request.excludeKinds ?? [],
      };
      const result = await supervisor.call<typeof payload, SemanticPayload>(operation, payload, { requestId: context.requestId, signal: context.signal, deadlineMonotonicMs: context.deadlineMonotonicMs });
      if (!result.ok) {
        const unsupported = /(?:-32601|unhandled method|not supported|unsupported)/iu.test(result.message);
        const unavailable = (result.code === "worker_failed" && result.message.includes("unavailable")) || unsupported;
        const outcome = unavailable ? "unavailable" : result.code === "cancelled" ? "partial" : result.code === "deadline" ? "partial" : "error";
        const code: EngineIssue["code"] = unavailable ? "unsupported_capability" : result.code === "cancelled" ? "cancelled" : result.code === "deadline" ? "deadline" : "worker_failed";
        return { outcome, evidence: [], issues: [issue(code, result.message, result.retryable)], coverage: coverage(0, "none"), consistency: "unknown" };
      }
      const payloadResult = result.payload ?? {};
      const obs = observation(payloadResult.observation);
      if (obs.diagnosticsStatus === "unsupported") {
        const message = typeof payloadResult.message === "string" && payloadResult.message.length > 0
          ? payloadResult.message
          : "the configured language server did not report diagnostics capability";
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", message, false)], coverage: coverage(0, "none", false), consistency: "live-observation", semanticObservations: [obs] };
      }
      if (request.operation === "diagnostics" && obs.diagnosticsStatus !== "complete") {
        const message = typeof payloadResult.message === "string" && payloadResult.message.length > 0
          ? payloadResult.message
          : "the configured language server did not complete diagnostics";
        return { outcome: "unavailable", evidence: [], issues: [issue("unsupported_capability", message, false)], coverage: coverage(0, "none", false), consistency: "unknown", semanticObservations: [obs] };
      }
      const items = payloadResult.items ?? [];
      const truncated = payloadResult.truncated === true;
      const omitted = truncated ? Math.max(0, payloadResult.omitted ?? 0) : 0;
      const snapshots = new Map<string, SourceSnapshot>();
      const sourceChanged = new Set<string>(); const unanchored = new Set<string>(); const incomplete = new Set<string>();
      const evidenceItems = items.map((item, index) => evidence(item, request, obs, index, snapshots, sourceChanged, unanchored, incomplete));
      if (sourceChanged.size > 0) return { outcome: "partial", evidence: evidenceItems, issues: [issue("source_changed", "semantic source changed while anchors were being captured: " + [...sourceChanged].join(", "), true)], coverage: coverage(evidenceItems.length, "Serena semantic scope", false, omitted), consistency: "unknown", semanticObservations: [obs] };
      if (unanchored.size > 0) return { outcome: "partial", evidence: evidenceItems, issues: [issue("worker_failed", "semantic result could not be anchored to a current source snapshot: " + [...unanchored].join(", "), true)], coverage: coverage(evidenceItems.length, "Serena semantic scope", false, omitted), consistency: "unknown", semanticObservations: [obs] };
      if (incomplete.size > 0 || (obs.scope === "unknown" && items.length === 0)) {
        const reason = incomplete.size > 0 ? [...incomplete].join(", ") : "semantic scope is unknown and returned no items";
        return { outcome: "partial", evidence: evidenceItems, issues: [issue("worker_failed", "semantic coverage is incomplete: " + reason, true)], coverage: coverage(evidenceItems.length, "Serena semantic scope", false, Math.max(1, incomplete.size)), consistency: "unknown", semanticObservations: [obs] };
      }
      const outcome = items.length === 0 ? "empty" : truncated ? "partial" : result.outcome;
      const issues = truncated ? [issue("output_truncated", "semantic result limited by maxMatches; " + omitted + " result(s) omitted", false)] : [];
      return { outcome, evidence: evidenceItems, issues, coverage: coverage(evidenceItems.length, "Serena semantic scope", !truncated, omitted), consistency: "live-observation", semanticObservations: [obs] };
    },
    async close(): Promise<void> { await supervisor.close(); },
  };
}
