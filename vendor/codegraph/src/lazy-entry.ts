/**
 * lazy-intel headless entry for the vendored CodeGraph fork.
 *
 * ADDED BY lazy-intel. This file is not part of upstream CodeGraph v1.6.0
 * (dfccdf62547fcd76d343344d823a0e1998d3a89f) and is recorded in
 * vendor/codegraph/UPSTREAM.json under `added_files`.
 *
 * Why it exists
 * -------------
 * The published package is a thin installer around a per-platform bundle that
 * carries its own Node runtime and a GitHub Releases download fallback
 * (npm-shim.js). None of that may sit on a query path. This entry is the single
 * surface the graph worker imports: the library facade and the storage building
 * blocks, and nothing from `src/bin/**`, `src/ui/**`, `src/installer/**`,
 * `src/upgrade/**` or `src/telemetry/**`.
 *
 * Honest limitation
 * -----------------
 * `CodeGraph`, `InitOptions` and `OpenOptions` are declared inside
 * `src/index.ts`, and that module re-exports `MCPServer` from `./mcp`
 * (src/index.ts:96). Requiring this entry therefore loads `./mcp` as a module.
 * It does NOT start a server: `MCPServer` is a class that is never constructed
 * here, and a plain import of the built entry starts no server, watcher or
 * timer (asserted in test/contracts/headless-entries.test.js, which fails if the
 * event loop stays alive after import). Making `./mcp` unreachable requires
 * editing upstream `src/index.ts`, which belongs to a later unit with its own
 * local_patches ledger entry, not to the import unit.
 *
 * Concurrency warning carried from the source review
 * --------------------------------------------------
 * `OpenOptions.readOnly` is declared (src/index.ts:112-118) but never forwarded
 * to `DatabaseConnection.open` (src/index.ts:351-355), and `open` runs
 * migrations plus bulk-load and index healing (src/db/index.ts:103-132). Opening
 * the same database from two processes is therefore a real write race, not a
 * benign shared read. The graph worker must own exactly one handle per
 * workspace; `readOnly` must not be mistaken for a safety property.
 */

export { CodeGraph } from './index';
export type { InitOptions, OpenOptions, IndexOptions } from './index';

export type { LazyCallPath, LazyTaskContextData } from './context';

export type {
  Node,
  NodeKind,
  Edge,
  EdgeKind,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  SegmentMatch,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  CodeBlock,
  BuildContextOptions,
  FindRelevantContextOptions,
} from './types';

export { getDatabasePath, DatabaseConnection } from './db';
export { QueryBuilder } from './db/queries';
export { getCodeGraphDir, isInitialized, findNearestCodeGraphRoot, CODEGRAPH_DIR } from './directory';
export { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadGrammarsForLanguages } from './extraction';
export type { IndexProgress, IndexResult, SyncResult } from './extraction';
export type { ResolutionResult } from './resolution';
export { CodeGraphError, DatabaseError, ParseError, SearchError, setLogger, silentLogger } from './errors';

/**
 * The upstream commit this fork entry was written against. The graph worker
 * stamps it into every evidence provenance record.
 */
export const LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT =
  'dfccdf62547fcd76d343344d823a0e1998d3a89f' as const;

/** Subtrees the graph worker must never reach. Asserted, not documented-only. */
export const LAZY_INTEL_FORBIDDEN_SUBTREES = ['bin', 'ui', 'installer', 'upgrade', 'telemetry'] as const;
