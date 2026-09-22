/**
 * lazy-intel headless entry for the vendored zvec-grep fork.
 *
 * ADDED BY lazy-intel. This file is not part of upstream zvec-grep v0.2.1
 * (309a66995809243d3274fa8b5bea63ab11dda1a0) and is recorded in
 * vendor/zvec-grep/UPSTREAM.json under `added_files`.
 *
 * Why it exists
 * -------------
 * `src/index.ts` is the package's public entry and is fine to import, but the
 * package also ships `src/cli/**`, `src/mcp/**` and `src/daemon/**`. A private
 * worker must be able to prove, by construction, that it never reaches those.
 * This module is the only surface the retrieval worker is allowed to import, so
 * the forbidden subtrees are unreachable from the worker's module graph rather
 * than merely unused.
 *
 * Invariants (asserted by test/contracts/headless-entries.test.js)
 * ---------------------------------------------------------------
 * - No CLI, MCP server or daemon module is reachable from here.
 * - Importing this module starts no watcher, daemon, server or timer. Upstream
 *   `createZvecGrep` only resolves the root and prepares the model store; the
 *   daemon lease is taken on an explicit write, never on construction.
 * - Nothing here widens the upstream API. `WorkspaceIndexStorage` stays internal;
 *   prepared-snapshot ingestion is a separate fork extension added in U07, not a
 *   pretend upstream export.
 *
 * Cancellation, stated honestly
 * -----------------------------
 * `ZvecGrepIndexOptions.signal` exists (src/engine/service/types.ts:53).
 * `ZvecGrepContextOptions` has no `signal` (src/engine/service/types.ts:82-113):
 * a read cannot be cooperatively cancelled. The supervisor must therefore bound
 * a read by discarding its result and by worker lifetime, never by pretending
 * the call aborts.
 */

export { createZvecGrep } from "./engine/service/index.js";

export type {
  CreateZvecGrepOptions,
  ZvecGrep,
  ZvecGrepContent,
  ZvecGrepContextContainer,
  ZvecGrepContextCoverage,
  ZvecGrepContextDiagnostics,
  ZvecGrepContextFile,
  ZvecGrepContextGroupResult,
  ZvecGrepContextItem,
  ZvecGrepContextItemKind,
  ZvecGrepContextOptions,
  ZvecGrepContextResult,
  ZvecGrepContextRoute,
  ZvecGrepContextSource,
  ZvecGrepContextWorkspaceIndex,
  ZvecGrepIndexDiagnostics,
  ZvecGrepIndexOptions,
  ZvecGrepInfoOptions,
  ZvecGrepInfoResult,
  ZvecGrepRgDiagnostics,
  ZvecGrepSearchOptions,
  ZvecGrepStructureEnrichmentDiagnostics,
} from "./engine/service/index.js";

export type {
  PreparedSnapshot,
  PreparedSnapshotBatch,
  PreparedSnapshotFile,
  PreparedSnapshotResult,
} from "./engine/pipeline/indexing/prepared.js";

export { createEmbeddingModel, EmbeddingPurpose } from "./engine/models/index.js";
export type {
  CreateEmbeddingModelOptions,
  EmbeddingModel,
  EmbeddingModelInfo,
  EmbeddingModelProgress,
  EmbeddingOptions,
  EmbeddingResult,
} from "./engine/models/index.js";

export type {
  CodeEntityMetadata,
  CodeSymbolType,
  Content,
  EntityMetadata,
  IndexOptions,
  IndexProgress,
  IndexResult,
  Range,
  RootPath,
  SearchMatchedBy,
  TimingEntry,
  WorkspaceIndexInfo,
  WorkspaceIndexPolicy,
  WorkspaceIndexStatus,
} from "./engine/types.js";

/**
 * The upstream commit this fork entry was written against. The retrieval worker
 * stamps it into every evidence provenance record, so a stale build is visible
 * in the response instead of being silently attributed to the pinned source.
 */
export const LAZY_INTEL_ZVEC_UPSTREAM_COMMIT =
  "309a66995809243d3274fa8b5bea63ab11dda1a0" as const;

/** Modules the retrieval worker must never reach. Asserted, not documented-only. */
export const LAZY_INTEL_FORBIDDEN_SUBTREES = ["cli", "mcp", "daemon"] as const;
