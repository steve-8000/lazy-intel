/**
 * lazy-intel internal contracts.
 *
 * These are lazy-intel's own types. None of them is an upstream export: zvec-grep,
 * CodeGraph and Serena each have their own vocabulary, and the adapters in
 * packages/core/src/adapters translate into these types at the fork boundary.
 *
 * Three distinctions in here are load-bearing and must not be collapsed:
 *
 *  - `CapturedManifest` is a revision set, not an atomic filesystem snapshot.
 *    `observedSeq` says what we looked at; `ProjectionView.appliedManifestId`
 *    says what a projection has actually applied. A read must never substitute
 *    the former for the latter.
 *  - `CanonicalAnchor` is a content-addressed occurrence. `NativeAlias` keeps a
 *    backend's own identifier beside it. Two symbols with the same name are not
 *    the same symbol; SourceKit even strips argument suffixes from function
 *    names (vendor/serena/src/solidlsp/language_servers/sourcekit_lsp.py:64-74).
 *  - `SemanticObservation` records what a language server told us about a
 *    document version we ourselves sent. It is an observation, not ground truth
 *    about the current file on disk.
 *
 * Source: seeded from the design package's proposed contract
 * (lazy-intel-unified-source-design/contracts/core-contracts.ts) and owned here
 * from U02 onward.
 */
export type WorkspaceId = string;
export type FileId = string;
export type ContentHash = string;
export type ManifestId = string;
export type ViewId = string;
export type DecimalRevision = string;
export type Projection = "retrieval" | "graph";
export type Outcome = "ok" | "empty" | "partial" | "unavailable" | "error";

export interface RequestContext {
  readonly requestId: string;
  readonly workspaceId: WorkspaceId;
  readonly signal: AbortSignal;
  /** Process-local monotonic deadline. Send remaining duration across workers. */
  readonly deadlineMonotonicMs: number;
  readonly maxEvidence: number;
  readonly maxOutputChars: number;
  readonly maxWireBytes: number;
}

export interface WorkspaceScope {
  readonly workspaceId: WorkspaceId;
  readonly canonicalSourceRoot: string;
  readonly canonicalStateRoot: string;
  readonly scopeDigest: string;
  readonly buildContextDigest: string | null;
  readonly trustedForLanguageTools: boolean;
}

export interface SourceSpan {
  readonly coordinateSystem: "utf8-bytes";
  readonly startByte: number;
  /** Half-open end, not a line count. */
  readonly endByte: number;
}

export interface SourceSnapshot {
  readonly fileId: FileId;
  readonly relativePath: string;
  readonly contentHash: ContentHash;
  readonly byteLength: number;
  readonly encoding: "utf-8";
  readonly content: string;
  readonly observedSeq: DecimalRevision;
}

export type SourceChange =
  | { readonly kind: "upsert"; readonly source: SourceSnapshot }
  | { readonly kind: "delete"; readonly fileId: FileId; readonly relativePath: string; readonly previousHash: ContentHash | null };

export interface CapturedManifest {
  readonly id: ManifestId;
  readonly workspaceId: WorkspaceId;
  readonly observedSeq: DecimalRevision;
  readonly scopeDigest: string;
  readonly parserProfileDigest: string;
  readonly resolverProfileDigest: string;
  readonly files: readonly { readonly fileId: FileId; readonly relativePath: string; readonly hash: ContentHash }[];
  /** A captured revision set; not an atomic filesystem snapshot guarantee. */
  readonly captureKind: "revision-set";
}

export interface ProjectionView {
  readonly projection: Projection;
  readonly viewId: ViewId;
  readonly appliedManifestId: ManifestId;
  readonly profileDigest: string;
  readonly state: "clean" | "applying" | "needs_recovery";
  /** Owned store generation; never the source root or a backend-global cache. */
  readonly storeRoot?: string;
}

export interface CanonicalAnchor {
  readonly workspaceId: WorkspaceId;
  readonly fileId: FileId;
  /** Display path bound to this occurrence's captured source bytes. */
  readonly relativePath: string;
  readonly contentHash: ContentHash;
  readonly span: SourceSpan;
  readonly kind: string;
  readonly occurrenceId: string;
  /** Optional cross-revision identity only when independently established. */
  readonly stableEntityId?: string;
}

export interface NativeAlias {
  readonly engine: "zvec" | "codegraph" | "serena";
  readonly engineRevision: string;
  readonly nativeId: string;
}

export interface SemanticObservation {
  readonly sessionEpoch: string;
  readonly serverProfileDigest: string;
  readonly fileHash: ContentHash | null;
  readonly bufferHash: ContentHash | null;
  readonly documentVersion: number | null;
  readonly buildContextDigest: string | null;
  readonly positionEncoding: "utf-8" | "utf-16" | "utf-32";
  readonly scope: "own-buffer" | "disk-observed" | "unknown";
  readonly relativePath?: string;
  readonly diagnosticsStatus?: "not_reported" | "complete" | "unsupported";
}

export interface Coverage {
  readonly kind: "ranked_sample" | "rg_exhaustive" | "rg_truncated" | "bounded_graph" | "semantic_scope" | "unknown";
  readonly completeWithinScope: boolean | null;
  readonly scopeDescription: string;
  readonly returned: number;
  readonly omitted: number | null;
}

export interface Evidence {
  readonly id: string;
  readonly kind: "definition" | "reference" | "implementation" | "diagnostic" | "call" | "dependency" | "impact" | "retrieval";
  readonly anchor: CanonicalAnchor | null;
  readonly aliases: readonly NativeAlias[];
  readonly method: "lexical" | "hybrid" | "vector" | "syntax" | "resolved_graph" | "lsp";
  readonly sourceCheck: "matched" | "mismatch" | "unchecked";
  readonly projectionView: ProjectionView | null;
  readonly semanticObservation: SemanticObservation | null;
  readonly relevanceScore: number | null;
  readonly text: string | null;
  /** Only source text claims verbatim correspondence with the anchored bytes. */
  readonly textKind?: "source" | "description";
  readonly coverage: Coverage;
  readonly relatedAnchors?: readonly { readonly role: "containing-symbol" | "reference" | "target"; readonly anchor: CanonicalAnchor }[];
}

export interface EngineIssue {
  readonly code: "invalid_input" | "ambiguous_subject" | "unsupported_capability" | "index_building" |
    "source_changed" | "freshness_unavailable" | "deadline" | "cancelled" | "protocol_error" |
    "worker_failed" | "needs_recovery" | "output_truncated";
  readonly component: "query" | "retrieval" | "graph" | "semantic" | "workspace";
  readonly message: string;
  readonly retryable: boolean;
}

export interface ReadResult {
  readonly outcome: Outcome;
  readonly evidence: readonly Evidence[];
  readonly issues: readonly EngineIssue[];
  readonly coverage: Coverage;
  readonly consistency: "captured-manifest" | "mixed-views" | "live-observation" | "unknown";
  /** Observations also survive successful empty reports, which have no evidence. */
  readonly semanticObservations?: readonly SemanticObservation[];
  readonly views?: readonly ProjectionView[];
}

interface SearchInput {
  readonly query: string;
  readonly scope: WorkspaceScope;
  readonly sources?: readonly SourceSnapshot[];
  readonly limit: number;
}
export type SearchRequest = SearchInput & (
  | { readonly mode: "exact"; readonly view: null }
  | { readonly mode: "hybrid" | "lexical" | "semantic"; readonly view: ProjectionView }
);

export interface SymbolSubject {
  /** User-facing name_path retained for compatibility. Not a canonical identity. */
  readonly namePath: string;
  readonly relativePath: string | null;
  readonly anchor: CanonicalAnchor | null;
  readonly nativeAlias: NativeAlias | null;
}

export interface GraphRequest {
  readonly operation: "architecture" | "impact" | "context";
  readonly query: string;
  readonly subject: SymbolSubject | null;
  readonly depth: number;
  readonly view: ProjectionView;
  readonly sources?: readonly SourceSnapshot[];
}

export interface SemanticRequest {
  readonly operation: "symbol" | "references" | "implementations" | "diagnostics";
  readonly subject: SymbolSubject | null;
  readonly relativePath: string | null;
  readonly includeBody: boolean;
  readonly depth?: number;
  readonly substringMatching?: boolean;
  readonly maxMatches?: number;
  readonly includeKinds?: readonly number[];
  readonly excludeKinds?: readonly number[];
}

export interface ApplyAck {
  readonly batchId: string;
  readonly projection: Projection;
  readonly state: "applied" | "needs_recovery";
  readonly manifestId: ManifestId;
  readonly durableBoundary: string;
  readonly storeRoot?: string;
}

/** These are NEW internal ports. No upstream module currently exports them. */
export interface RetrievalPort {
  read(input: SearchRequest, context: RequestContext): Promise<ReadResult>;
  close(): Promise<void>;
}
export interface GraphPort {
  read(input: GraphRequest, context: RequestContext): Promise<ReadResult>;
  close(): Promise<void>;
}
export interface SemanticPort {
  read(input: SemanticRequest, context: RequestContext): Promise<ReadResult>;
  close(): Promise<void>;
}

export interface WorkerEnvelope<T> {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly workspaceId: WorkspaceId;
  /** Parent remains authoritative; never reset the overall request budget. */
  readonly remainingBudgetMs: number;
  readonly payload: T;
}

export interface ContextPack {
  readonly schemaVersion: 1;
  readonly outcome: Outcome;
  readonly text: string;
  readonly evidence: readonly Evidence[];
  readonly issues: readonly EngineIssue[];
  readonly coverage: Coverage;
  readonly views: readonly ProjectionView[];
  readonly semanticObservations: readonly SemanticObservation[];
  readonly isError: boolean;
}
