# lazy-intel

`lazy-intel` is an autonomous local code-intelligence MCP for OMP.

OMP sees exactly **one MCP tool**: `code_intel`.

Internally, lazy-intel owns zvec-grep and CodeGraph derived-index lifecycle and uses Serena as live LSP semantics. OMP Sharpshooter remains the durable memory owner.

```text
OMP / Sharpshooter(memory)
          |
          | one stdio MCP
          v
     lazy-intel
   autonomous control plane
      /      |       \
   zvec   CodeGraph  Serena
 retrieval   graph     LSP
      \      |       /
        fused evidence
```

## Design contract

| Concern | Owner |
|---|---|
| durable project memory | OMP Sharpshooter |
| semantic/hybrid workspace retrieval | zvec-grep |
| architecture, call path, blast radius | CodeGraph |
| exact symbol/reference/implementation semantics | Serena / LSP |
| derived index create/sync/rebuild/repair | **lazy-intel autonomous control plane** |
| source edits, build, tests, final correctness | OMP native tools |

There is no manual index lifecycle in the normal path.

## Autonomous indexing

With the default configuration:

1. MCP startup registers the project (`LAZY_INTEL_ROOT` or process cwd) and starts a background bootstrap.
2. Readiness comes from the backends themselves — `zg status --check-ready` and `codegraph status`, never from a directory guess — so a half-built or aborted index is detected instead of trusted.
3. A missing index is created on first use; an index that is currently building is reported as `building` rather than rebuilt underneath itself.
4. A recursive filesystem watcher bumps a generation counter on real source changes. Every path segment is filtered, so nested `node_modules`, `dist`, `.build`, `.venv`, `__pycache__`, and the derived index directories cannot create feedback loops.
5. Freshness is **change-driven**: each backend reconciles once when the process has no baseline for it (changes made while lazy-intel was down are unknowable), then syncs only when its applied generation falls behind the watcher generation. A quiet workspace costs zero subprocesses; there is no wall-clock re-index timer. `status` reports `dirty: null` with `baseline: "unverified"` instead of guessing.
6. Authoritative zvec freshness comes from lazy-intel's own dirty sync (`zg index`); queries additionally carry `--refresh` (`background` for `auto`, `wait` for `strict`, `off` for `fast`) so the shared zvec-grep daemon can also refresh anything the watcher missed.
7. Index work is serialized per backend in FIFO order. An explicit `reindex`/`repair` queued behind an in-flight sync still executes; it never inherits the other job's result.
8. Repeated index failures escalate to a rebuild when `LAZY_INTEL_AUTO_REPAIR=true`.
9. The agent can call `status`, `sync`, `reindex`, or `repair` through the same `code_intel` tool. No separate admin MCP is exposed.

### Freshness modes

| mode | behavior |
|---|---|
| `auto` | **default**; create when missing, sync when the watcher saw changes, daemon refresh in background |
| `strict` | force a pre-query sync and a blocking daemon refresh |
| `fast` | create when missing, otherwise use the built index as-is |

`auto` is the normal production mode. `fast` exists only for explicitly latency-biased calls.

### Embedding integration

lazy-intel defines **no** embedding default. A new zvec index inherits the shared zvec-grep configuration (global default model, device, and model cache), so a machine that already runs zvec-grep keeps exactly one vector space and one model download. `--embedding` is passed only when `LAZY_INTEL_EMBEDDING` is set or the agent explicitly provides `embedding` with `operation=reindex`; existing indexes keep their stored schema during automatic repair.

## Agent control plane

Still only one tool:

```text
code_intel(...)
```

Intelligence operations:

- `auto`
- `search`
- `architecture`
- `impact`
- `symbol`
- `references`
- `implementations`
- `diagnostics`

Control operations available to the agent:

- `status`
- `sync`
- `reindex` (optionally set `embedding` to intentionally change zvec vector space)
- `repair`

`backend=all|zvec|codegraph|serena` scopes control operations. Serena has no derived index: `repair` restarts/warm-checks its live LSP process.

Examples:

```json
{
  "operation": "architecture",
  "query": "trace the call flow from index commit to search result refresh",
  "root": "/src/folio"
}
```

```json
{
  "operation": "reindex",
  "backend": "codegraph",
  "root": "/src/folio"
}
```

```json
{
  "operation": "status",
  "root": "/src/folio"
}
```

## Install into an OMP project

```bash
# Node >=22.5 <25 must be the active runtime for install and for the MCP entry.
PATH="$(brew --prefix node@22)/bin:$PATH" ./scripts/install.sh --global
```

This installs the pinned backends project-locally (`node_modules/.bin/zg`, `node_modules/.bin/codegraph`), installs the pinned `serena-agent` with `uv`, runs `doctor`, and merges `lazy-intel` into `~/.omp/agent/mcp.json` (`--global`) or `<project>/.omp/mcp.json`.

The install also adds `zvec-grep` and `codegraph` to OMP's `disabledServers`: **exactly one code-intelligence MCP stays connected**, so there is one embedding runtime, one model cache, and one derived-index owner.

**It does not run a manual `lazy-intel init`.** Index creation starts automatically when OMP starts lazy-intel and is guaranteed on first use. After that, index maintenance requires no user action.

## Default OMP runtime settings

```text
LAZY_INTEL_AUTO_INDEX=true
LAZY_INTEL_AUTO_REPAIR=true
LAZY_INTEL_MAINTENANCE_MS=5000     # dirty-only maintenance tick; 0 disables it
LAZY_INTEL_INDEX_TIMEOUT_MS=600000
LAZY_INTEL_TIMEOUT_MS=30000
LAZY_INTEL_ZVEC_MODE=auto          # zvec transport: direct | server | auto
LAZY_INTEL_SERENA_CONTEXT=agent    # Serena 1.7 context name
SERENA_USAGE_REPORTING=false
DO_NOT_TRACK=1
```

Optional: `LAZY_INTEL_ROOT` pins the bootstrap root, `LAZY_INTEL_EMBEDDING` overrides the inherited zvec model for *new* indexes, `LAZY_INTEL_PROBE_TIMEOUT_MS` bounds readiness probes, and `LAZY_INTEL_ZG_BIN` / `LAZY_INTEL_CODEGRAPH_BIN` / `LAZY_INTEL_SERENA_BIN` override binary resolution.

## Pinned upstreams (2026-09-08)

- `@zvec/zvec-grep` **0.2.1**
- `@colbymchenry/codegraph` **1.6.0**
- `serena-agent` **1.7.0**

See `upstreams.lock.json` and `THIRD_PARTY_NOTICES.md`.

## Requirements

- macOS/Linux
- Node >=22.5 and <25 (a newer default `node` on the machine must be overridden for install *and* for the MCP `command`; `install-omp` writes the runtime it was executed with)
- npm
- Python 3.13 + `uv` for Serena

### Operational traps

- **zvec daemon lease.** When a zvec-grep daemon is running it owns index writes for a root; `--mode direct` then fails with `ZVEC_GREP.ENGINE.DAEMON_LEASE_ACTIVE`. Keep `LAZY_INTEL_ZVEC_MODE=auto`. If indexing hangs with no output, the daemon itself is stuck — `zg server off && zg server on` restores it (verified: a stuck daemon hung `zg index` past 300s; after restart the same index finished in ~4s). That daemon is machine-wide: `zg install` may have wired it into other agents too, so restart it only when no other client is mid-operation.
- **Freshness without a watcher.** If the recursive watcher cannot attach (container mounts, exotic filesystems), `status.freshnessSource` reports `periodic fallback` and `LAZY_INTEL_MAX_STALE_MS` (default 60000) drives periodic syncs. With a live watcher, time plays no role.
- **Serena contexts.** Serena 1.7 has no `ide-assistant` context. Valid names include `agent` (default here), `ide`, and `codex`.
- **Cross-file JS/TS semantics.** Serena's language server needs a declared project scope; this repo ships `jsconfig.json` so `references`/`implementations` resolve across files instead of returning an empty result.

## Truth hierarchy

```text
current source + compiler/tests
              >
live language semantics (Serena/LSP)
              >
indexed structure (CodeGraph)
              >
retrieval relevance (zvec-grep)
```

The indexes are fully autonomous, but they remain derived acceleration state, not correctness truth.

## Failure behavior

A backend failure does not take down the MCP. Intelligence queries return whatever selected backend evidence is healthy, and a call where every selected backend failed is reported as an MCP tool error instead of an empty success.

Retries are bounded: a failing backend backs off 30s, 1m, 2m, … up to 15m, the maintenance tick skips a backend that is already busy or not yet due, and the automatic rebuild escalation fires once per failure streak. A failed semantic call restarts Serena once.

The agent can force recovery with:

```json
{ "operation": "repair", "backend": "all" }
```

No user-operated `doctor -> init -> reindex` loop is required.

## CLI

The install does **not** create a global `lazy-intel` bin (no `npm link`); OMP launches `src/cli.js` by absolute path and humans run it the same way:

```bash
node src/cli.js serve
node src/cli.js doctor [root]                   # pinned-version + backend + index diagnostics
node src/cli.js init [root] [--rebuild]         # optional/manual compatibility path
node src/cli.js install-omp [root] [--global]   # --global writes ~/.omp/agent/mcp.json
```

Run these with a supported runtime (`PATH="$(brew --prefix node@22)/bin:$PATH"`); `install-omp` refuses to write an out-of-range Node into OMP configuration. `doctor` fails when a resolved backend does not match `upstreams.lock.json`, so version drift is visible instead of silent. Add `npm link` yourself if a global `lazy-intel` command is wanted.

The CLI control commands are diagnostics/compatibility only. Normal lifecycle ownership lives inside the MCP runtime.

## Tests

```bash
npm test
npm run check
```
