# lazy-intel

Local code intelligence for OMP, exposed as exactly one MCP tool: `code_intel`.

The default and only implementation uses pinned local forks of zvec-grep, CodeGraph and Serena. There is no internal LLM. Embeddings remain part of retrieval; existing model/device configuration is preserved. OMP Sharpshooter remains the durable memory owner.

## Runtime architecture

```text
OMP / Sharpshooter
        |
   code_intel
        |
workspace + publication coordinator
        |
 immutable captured source bytes
       / \
 retrieval  graph       semantic / owned LSP session
  worker    worker       Python bridge + language server
       \      |          /
    typed, bounded evidence
```

- `src/unified.js` is the product entry into the owned workers. The old `src/backends/*` CLI/MCP wrappers and engine selector are gone.
- `src/index-manager.js` owns scheduling, watcher generations, caller isolation and repair policy. Readiness comes from the publication catalog, not directory existence, CLI prose or a worker's row count.
- `packages/core/src/workspace` owns canonical scope, cross-process ownership, source capture, durable intent/ack/publication state and read/write leases.
- Retrieval and graph workers receive the same captured bytes. They cannot independently discover a different source revision or publish readiness.
- Large source batches use hashed files beneath the owned generation's `.prepared` directory; bounded IPC carries references, not unbounded source bodies. Graph parts are staged until the complete publication is available; only the final part acknowledges durable application.
- The workers retain their native parsers/extractors and dependency locks. Shared source bytes are **not** a claim of single parsing, one process, a universal parser, or removal of Python. `docs/unified/parser-convergence.json` distinguishes snapshot parity from parser convergence.

## State and consistency

The source root is never replaced by the state root. The product stores its control plane and derived generations under `<source>/.lazy-intel/`; the core API also supports an explicitly supplied separate state directory. `LAZY_INTEL_STATE_ROOT` is not a product configuration setting.

A write records its intent before mutating either backend. Each projection acknowledges its real durable boundary before the coordinator publishes a clean view. A failed or interrupted write remains `needs_recovery`; an unresolved transaction blocks a newer publication. Recovery replays captured inputs rather than recapturing unrelated disk bytes.

Readers lease published views. Partly replaced vectors, uncommitted graph writes and incompatible graph/retrieval manifests cannot be presented as a coherent old clean result. Rebuilds use a fresh generation and retain the old physical store rather than migrating it in place.

| Freshness | Behavior |
|---|---|
| `auto` | Create when absent; reconcile startup/dirty/policy state, then read a clean published view |
| `strict` | Capture and synchronize before reading; recapture after the read and report `source_changed` if the source changed |
| `fast` | Use an available clean captured view; this does not promise current disk contents |

A recursive watcher tracks source changes, including newly created directories and deletions. Nested ignore policy and relevant build configuration affect capture identity. Derived state, dependency/build directories and private agent roots are excluded. A lost/unavailable watcher falls back to bounded reconciliation rather than silently declaring freshness.

A caller's cancellation does not cancel shared index work or another waiter. Native work that lacks cooperative cancellation remains physically owned until it completes or its worker is reaped. Worker epochs fence late responses from previous processes. The MCP permits four active requests and thirty-two queued requests; input and output wire caps are enforced.

## Evidence contract

Indexed evidence carries its `CanonicalAnchor` and `ProjectionView`: canonical file identity, captured content hash, UTF-8 byte span, manifest, generation and publication state. Semantic evidence carries a separate `SemanticObservation`: owned session epoch, observed hash, document version, position encoding and diagnostic completion state. A live LSP observation is not relabeled as an indexed manifest.

`textKind` distinguishes verbatim `source` from a semantic `description` such as a diagnostic message or graph label. Current-file verification checks the captured hash and canonical span; a `source` item additionally requires an exact byte excerpt match. A matched description means its **source anchor** was verified, not that its wording appears in the file or that its semantic claim was independently proven.

Coverage remains explicit: ranked retrieval is not exhaustive search, bounded graph evidence is not a complete program graph, and unsupported semantics are not successful empty results. Fresh empty diagnostic publications and valid empty pull replies clear prior errors; silence remains `not_reported`, not completed empty. Empty diagnostics retain the completion observation even when there are no evidence items. Output budgeting includes headers, warnings, evidence descriptors, views and observations.

No source block is ever split. An item whose body does not fit `maxChars` is returned as its location with `bodyOmitted: true`, and the text says how many characters it needed. An answer that carries at least one whole item stays `ok`; one whose evidence is only locations, or that could fit nothing at all, is `partial` — never `ok` with an empty evidence list, which an agent would read as "nothing relevant exists".

Truth order remains current source/compiler/tests, live language semantics, indexed structure, then retrieval relevance. Derived indexes accelerate discovery; they do not replace source verification.

## Operations

Intelligence: `auto`, `context`, `search`, `architecture`, `impact`, `symbol`, `references`, `implementations`, `diagnostics`.

Control: `status`, `sync`, `reindex`, `repair`. `backend=all|zvec|codegraph|serena` scopes control operations. Serena has no derived index; semantic repair closes its owned session for a fresh launch on the next read.

Explicit operations are not silently replaced. `auto` has a bounded dependent stage, not an agent loop. `context` uses a fixed composite plan. Auxiliary evidence cannot disguise failure of a required operation.

```json
{"operation":"architecture","query":"invoiceTotal calls applyDiscount","root":"/src/project"}
```

```json
{"operation":"references","symbol":"applyDiscount","relativePath":"src/discount.ts","root":"/src/project"}
```

```json
{"operation":"reindex","backend":"zvec","root":"/src/project","embedding":"local/qwen3-embedding-0.6b"}
```

### Index scope

Scope is everything the workspace's version control tracks, minus derived directories (`node_modules`, `dist`, `target`, `DerivedData`, `.next`, caches and the like). One policy decides both what is indexed and what the watcher treats as a change, so a file cannot be indexed once and then go stale unobserved.

A `.lazy-intel-ignore` file at the workspace root narrows that further, using gitignore syntax. It is the right place for vendored third-party trees a repository tracks but does not own:

```text
vendor/
```

The file's contents are hashed into the scope digest, so editing it re-indexes on the next request. A single file larger than 1 MiB is excluded and reported as a `too-large` manifest exclusion: generated data artifacts otherwise dominate the whole corpus, since retrieval chunks and embeds every byte.

### Readiness

A read never waits for publication work. Indexing a real repository takes minutes — far past any request budget — so a caller that waited would only ever learn that it timed out. The readiness check runs outside the publication queue: a workspace with no published view answers `INDEX_BUILDING` at once and schedules one background build, and a published view that is dirty is served as it stands while a background sync catches up. `LAZY_INTEL_BOOTSTRAP_TIMEOUT_MS` bounds that build (default `1800000`, clamped `5000..3600000`) and nothing waits on it.

`freshness: "strict"` is the exception and still blocks: it is how you publish deliberately rather than by side effect.

`status` leads with one verdict per index — `ready`, `building`, `absent`, `needs_recovery` or `failing` — and the next step, and reports `partial` rather than `ok` while any index is not ready.

### Interrupted publications

A publication interrupted mid-apply stays journaled. The next sync compares it with what the current capture would produce: a batch captured under a different scope, parser, resolver or embedding profile can never be produced again, so it is abandoned — its previous views are restored, the decision is journaled, and its orphaned store is removed — instead of being replayed. A batch that still matches is rolled forward; if the replay fails it is abandoned too. After any abandonment the publication rebuilds into a fresh store rather than building on a store the abandoned batch may have half-written. Before this, one batch captured under an older ignore policy (2,344 files including a 36 MB generated parser) blocked every later publication in that workspace indefinitely.

### On-disk state

Derived state under `.lazy-intel/` is bounded by the current corpus rather than by history:

- **Journal.** `runtime/publication.journal` keeps only records for publications still pending; once the catalog holds none, it is rewritten atomically to empty. It previously grew by a full batch, source text included, on every publication (3 MB to 50 MB in one day on a 143-file workspace).
- **Stores.** After every publication, a store directory that no view, active batch or pending batch references is closed in its worker and deleted. A store replaced by a rebuild is stamped at replacement and kept for `LAZY_INTEL_STORE_GRACE_MS` (default `600000`) so a reader in another process can finish; a store that never backed a clean view (an abandoned batch) goes immediately.
- **Embedding cache.** A successful full build rewrites `embedding-cache.jsonl` to exactly the vectors that build used, across all of its parts; incremental, failed or cancelled builds leave it alone. On this repository a cache seeded with 83 MB of stale entries compacted to 4.5 MB on one full build, and a following full rebuild took 11.6 s with the cache unchanged, against roughly 240 s for embedding the corpus from scratch.

### Workers

Retrieval and graph reads run in worker processes shared by every workspace the server has open, because each retrieval worker holds its own embedding model. `LAZY_INTEL_WORKER_POOL` sets how many exist per projection (default `2`, clamped to `1..8`). A request prefers the worker already holding its store, and moves to an idle one when that worker is busy, so a long index apply in one workspace does not block a query in another. A worker that fails an apply is replaced on its own; the other workers keep their processes.

An idle worker gives its memory back. After `LAZY_INTEL_WORKER_IDLE_MS` without a call (default `120000`, clamped `10000..3600000`, `0` disables) the worker process exits and the next request starts a fresh one. This matters because every editor session runs its own server: seven live servers were measured holding 7.51 GB of resident memory between them, with the machine 5.65 GB into swap, purely because each retrieval worker kept an embedding model loaded long after its session stopped asking questions.

### Concurrent sessions

Owning a workspace and reading one are different rights. Publishing — capture, apply, recovery — takes the exclusive workspace lock, and a second writer is refused with `WORKSPACE_OWNED` and the holder's pid; its reads answer `INDEX_BUILDING` naming that pid and retry publication every five seconds rather than backing off. Reading takes no lock: a reader opens the published catalog, re-reads it whenever the file's identity, size or mtime changes so it can never serve a view the owner has already replaced, and is refused any mutating call.

The lock is not held for a process lifetime. A writer with no sync in flight for `LAZY_INTEL_WRITER_IDLE_MS` (default `30000`) releases it, and its next sync takes it again, so ownership moves to whichever session needs to publish. Before this, the first session to publish owned the workspace until it exited, and when that owner stalled every other session was left permanently unable to read.

### Embeddings

A new index inherits the existing zvec-grep configuration, including model and device. An existing index keeps its stored embedding schema during automatic synchronization/repair. An explicit model change requires rebuilding that projection. This repository does not change the user's model configuration or download a different model during a normal query.

### Language servers

Semantic reads require an explicitly trusted, installed language server. Set `LAZY_INTEL_LSP` to a JSON mapping of language names to absolute executable paths, for example:

```text
LAZY_INTEL_LSP={"python":"/absolute/path/to/pyright-langserver","typescript":"/absolute/path/to/typescript-language-server"}
```

Executables are canonicalized and checked before launch. The requesting repository's `PATH` or `node_modules/.bin` cannot select them. Missing toolchain/build context and missing LSP capabilities produce honest unavailable/partial results, not a file-overview substitute. Explicit `symbol`, `references` and `implementations` requests require both `symbol` and `relativePath`; `auto` can resolve a pathless symbol from the derived CodeGraph index before optionally asking the semantic API. `diagnostics` requires `relativePath`; actual semantic availability depends on the configured server. For example, a server rejecting `textDocument/implementation` is reported as unsupported.

UTF-16/UTF-8 positions, CRLF and multibyte text are converted against the observed source revision. Native retrieval offsets are explicitly UTF-16 code units; public anchors are UTF-8 bytes. Invalid coordinates, unknown semantic scope and source paths outside the canonical workspace cannot become complete anchored evidence. The product does not claim access to another editor's unsaved buffer.

## Setup and OMP registration

Requirements: Node `>=22.5 <25`, npm, `uv` and the owned semantic worker's declared Python runtime. Native dependencies/grammars and local model caches must be provisioned before offline use. Language-server installation is explicit setup, not a side effect of a query.

```bash
PATH="$(brew --prefix node@22)/bin:$PATH" ./scripts/install.sh --global
```

Setup builds the local forks/core and provisions the project-owned semantic environment. OMP registration remains a separate CLI operation that can also be invoked directly:

```bash
node src/cli.js install-omp /src/project
node src/cli.js install-omp /src/project --global
```

Project registration records its cwd; global registration follows the OMP session cwd. Installation preserves unrelated MCP configuration and explicit settings, removes superseded standalone code-intelligence registrations, and writes atomically with mode `0600`. No manual index initialization is required for normal use.

```text
LAZY_INTEL_AUTO_INDEX=true
LAZY_INTEL_AUTO_REPAIR=true
LAZY_INTEL_MAINTENANCE_MS=5000
LAZY_INTEL_INDEX_TIMEOUT_MS=600000
LAZY_INTEL_TIMEOUT_MS=30000
SERENA_USAGE_REPORTING=false
DO_NOT_TRACK=1
```

`LAZY_INTEL_ROOT` fixes the bootstrap root. `LAZY_INTEL_ALLOWED_ROOTS` and `LAZY_INTEL_DENY_ROOTS` use the platform path delimiter. `LAZY_INTEL_MAX_ROOTS` bounds managed workspaces. `LAZY_INTEL_EMBEDDING` supplies an explicit embedding selection; otherwise the shared configuration is inherited. There is no daemon transport selector or external Serena MCP executable setting in the new query path.

### Trust boundaries

- Request roots and source locators are canonicalized and contained. The home directory itself, the OMP home tree and zvec-grep's private home tree are not indexable roots.
- Canonical aliases share one workspace owner. A second writer cannot independently open the same root. Recreated source identities and mismatched persisted scope are rejected.
- Default state/runtime directories, generation roots and prepared transport files cannot use symlinks to escape their owned directory.
- Semantic operations do not expose source edits, arbitrary commands or an additional MCP tool. Trusted language servers still execute code: routing/trust checks are not an OS sandbox for a compromised tool or concurrently hostile filesystem.
- The product does not restart a machine-wide zvec daemon or borrow its writable index. Its generations are separate from old `.zvec-grep/` and `.codegraph/` state.

## Build, verification and rollback

```bash
npm run build
npm run verify:vendor
npm run check:integration
npm test
npm run test:compatibility
npm run verify:release
```

Each vendored tree retains its pinned commit, patch ledger, dependency lock and runtime assets. No forced cross-backend grammar/runtime hoisting is required. See `upstreams.lock.json`, `THIRD_PARTY_NOTICES.md` and `docs/unified/dependency-audit.json`.

The original **68** acceptance items remain in `docs/unified/acceptance.json` as the baseline assessment. Current per-item evidence belongs in `docs/unified/acceptance-evidence.json`; a passing build or a smaller aggregate gate list does not replace those criteria. `docs/unified/units/` retains superseded historical checkpoints, not current acceptance verdicts. Read-before-edit provenance comes from chronological tool records, not a retrospective current-hash assertion.

Release producers:

- `scripts/verify-install.mjs`: isolated HOME/project install, upgrade, real MCP reads, cancellation, multiple roots and an old-binary/actual-state restore.
- `scripts/verify-performance.mjs`: immutable preregistration, separately measured cold/restart/warm/dirty lifecycles, process-tree RSS and source-anchor checks.
- `scripts/verify-semantic.mjs`: actual trusted language servers, own-buffer hash/version, CRLF/UTF-16 coordinates, diagnostics and public source-span verification.
- `scripts/verify-backend-parity.mjs`: stock disk-index/query versus public MCP using identical copied source and configured embeddings; anchor coverage and exact-span equality are reported separately.
- `scripts/verify-offline.mjs`: scoped runtime network instrumentation and its explicit platform/coverage limitations.
- `scripts/verify-release.mjs`: executed build, contracts and release evidence, without turning unverified/blocked criteria into passes.

The measured small corpus is not a broad benchmark. Current evidence retains the preregistered 2 GB process-tree RSS guardrail as a separate release failure; successful source-anchor checks and the 68 original contracts do not waive it. Embedding model and device configuration were not changed to meet that limit.

Rollback is **not** an environment-variable switch. Stop the candidate, restore the archived old executable and its matching old state, then exercise that binary against the restored state. Never point the old binary at a new generation or downgrade a migrated store in place. `docs/unified/install-evidence.json` records the exercised disposable rollback and physical database digests; it does not claim a live deployment was changed.

CLI diagnostics remain available:

```bash
node src/cli.js serve
node src/cli.js doctor /src/project
node src/cli.js init /src/project --rebuild
```

`doctor` reports the supported runtime, vendored pins/build and index state. Normal ownership and recovery remain inside the MCP runtime.
