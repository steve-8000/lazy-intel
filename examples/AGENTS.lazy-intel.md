# lazy-intel routing

`lazy-intel` owns its derived indexes. Never ask the user to initialize, sync, or repair zvec/CodeGraph.

`code_intel` is the only code-intelligence MCP: the standalone `zvec-grep` and `codegraph` servers are disabled, so never call them directly. A new zvec index inherits the machine's shared zvec-grep embedding configuration; pass `embedding` only to change vector space deliberately (it forces a full re-embed).

Use OMP native exact tools first when an exact filename, string, regex, or known location is available.
Use `code_intel` when codebase intelligence materially reduces exploration.

- `operation=search`: semantically related local code/docs are unknown -> zvec-grep.
- `operation=architecture`: call flow, dependency, cross-module relationship -> CodeGraph.
- `operation=impact`: blast radius of a known symbol -> CodeGraph.
- `operation=symbol`: exact symbol lookup -> Serena/LSP.
- `operation=references|implementations`: provide both `symbol` and `relativePath` -> Serena/LSP.
- `operation=diagnostics`: provide `relativePath` -> Serena/LSP.
- `operation=auto`: deterministic routing, maximum two intelligence backends.

Index control is also agent-owned through the same tool:

- `operation=status`: inspect derived-index state.
- `operation=sync`: force incremental freshness.
- `operation=reindex`: force rebuild when a derived index is suspected corrupt/wrong.
- `operation=repair`: sync first, automatically escalate to rebuild on failure.

Default to `freshness=auto`. Use `strict` for high-impact decisions that require a forced pre-query sync. Do not ask the user to perform index maintenance.

Do not use lazy-intel as memory. Sharpshooter owns durable project memory.
Treat indexed results as navigation evidence, not truth. Before editing or claiming correctness, verify current source and use native compiler/tests.
