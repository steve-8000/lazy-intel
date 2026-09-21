/**
 * The unified read path: the product's query path served by the vendored forks
 * running as typed libraries in private workers, instead of by `zg`/`codegraph`
 * subprocesses and an external Serena MCP server.
 *
 * This module is the only place where the control-plane vocabulary
 * (`packages/core/src/contracts.ts`) meets the product vocabulary
 * (`src/contracts.js`, `src/evidence.js`). Keeping the translation in one file is
 * what lets the legacy adapters stay selectable: `src/engine.js` picks a reader,
 * and nothing else in the product knows which one answered.
 *
 * Selection is `LAZY_INTEL_ENGINE`. It stays `legacy` by default until the U09
 * release gate, because the two paths have different failure modes and the
 * switch must be a deliberate, reversible act rather than a side effect of an
 * upgrade.
 *
 * Two translations here are lossy in one direction and must not be faked in the
 * other:
 *
 *  - The control plane anchors evidence to half-open UTF-8 byte spans; the
 *    product's locators are line ranges. Bytes are authoritative, so lines are
 *    derived by counting newlines in the file the anchor names. When the file
 *    cannot be read, the evidence keeps its text and loses its locator rather
 *    than carrying a guessed line number.
 *  - The control plane distinguishes `lexical`, `vector`, `hybrid`, `syntax`,
 *    `resolved_graph` and `lsp`; the product's public enum has three values.
 *    The narrowing is recorded in the evidence text's provenance, never
 *    silently widened into a stronger claim.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTER_VERSION, envelope, failureEnvelope } from "./contracts.js";
import { ensureIndexes } from "./index-manager.js";
import * as Evidence from "./evidence.js";
import { log } from "./lib/log.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** `legacy` until the release gate flips it; `unified` opts a deployment in. */
export const ENGINE_MODE = process.env.LAZY_INTEL_ENGINE === "unified" ? "unified" : "legacy";

/**
 * Control-plane method to the product's three-value public enum. Retrieval
 * methods all collapse to `hybrid_retrieval`, which is what the product has
 * always meant by "the retrieval backend found this"; graph resolution becomes
 * `indexed_graph`; LSP stays itself.
 */
const METHOD_TO_PRODUCT = {
  lexical: "hybrid_retrieval",
  vector: "hybrid_retrieval",
  hybrid: "hybrid_retrieval",
  syntax: "indexed_graph",
  resolved_graph: "indexed_graph",
  lsp: "lsp",
};

/** Control-plane evidence kinds the product's enum does not have a slot for. */
const KIND_TO_PRODUCT = {
  definition: "definition",
  reference: "reference",
  implementation: "implementation",
  diagnostic: "diagnostic",
  call: "relation",
  dependency: "relation",
  impact: "impact",
  retrieval: "retrieval",
};

const BACKEND_BY_COMPONENT = { retrieval: "zvec", graph: "codegraph", semantic: "serena" };

let corePromise;

/**
 * The compiled control plane. It is loaded on first unified read rather than at
 * import time so that a legacy deployment never pays for it and never fails to
 * start because the build output is missing.
 */
async function core() {
  corePromise ??= import(path.join(ROOT_DIR, "packages/core/dist/index.js")).catch((error) => {
    corePromise = undefined;
    throw new Error(`the unified engine needs a build: ${error.message}. Run npm run build.`);
  });
  return corePromise;
}

const runtimes = new Map();

/**
 * One runtime per canonical root: three supervisors, three adapters, one set of
 * long-lived worker processes. Creating this is expensive (a worker start plus a
 * library load per backend), so it is cached and torn down only by `closeUnified`.
 */
async function runtimeFor(root) {
  let runtime = runtimes.get(root);
  if (runtime) return runtime;

  runtime = (async () => {
    const { createRetrievalAdapter, createGraphAdapter, createSemanticAdapter, WorkerSupervisor } = await core();
    const workspaceId = root;
    const onLog = (line, stream) => log("debug", "worker output", { root, stream, line });

    const retrieval = createRetrievalAdapter({ workspaceId, workerPath: path.join(ROOT_DIR, "workers/retrieval/main.mjs"), supervisor: { onLog } });
    const graphSupervisor = new WorkerSupervisor({
      kind: "graph",
      modulePath: path.join(ROOT_DIR, "workers/graph/main.mjs"),
      workspaceId,
      onLog,
    });
    const graph = createGraphAdapter({ supervisor: graphSupervisor, sourceRoot: root });

    return { root, retrieval, graph, graphSupervisor, semantic: new Map(), semanticFailed: new Map() };
  })();

  runtimes.set(root, runtime);
  return runtime;
}

/**
 * Language servers are never discovered and never installed. The operator names
 * the executables in `LAZY_INTEL_LSP` as a JSON object of language to absolute
 * path, e.g. {"python":"/opt/homebrew/bin/pyright-langserver"}. An unnamed
 * language is reported as unavailable with that reason, which is the whole point
 * of the no-install policy: a query must never trigger a download.
 */
function trustedLanguageServers() {
  const raw = process.env.LAZY_INTEL_LSP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    log("warn", "LAZY_INTEL_LSP is not valid JSON; no language server is trusted", { error: error.message });
    return {};
  }
}

/**
 * Extension to the language-server id Serena actually accepts
 * (`solidlsp.ls_config.LanguageServerId`). Note there is no `javascript` id: the
 * TypeScript server handles both, so a `.js` file resolves to `typescript`.
 * Guessing an id that is not in that enum produces a refusal, not a fallback.
 */
const LANGUAGE_BY_EXTENSION = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python", ".pyi": "python",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".java": "java",
  ".swift": "swift", ".kt": "kotlin", ".cs": "csharp", ".c": "cpp", ".h": "cpp",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".dart": "dart", ".lua": "lua",
  ".ex": "elixir", ".exs": "elixir", ".scala": "scala", ".zig": "zig", ".svelte": "svelte", ".vue": "vue",
};

/**
 * The semantic worker owns a Python interpreter and one language server per
 * language, so a port is created per language and only when a semantic read is
 * actually asked for. A failure is remembered: re-probing a missing interpreter
 * on every query would turn one configuration problem into a per-request stall.
 */
async function semanticPort(runtime, language) {
  const existing = runtime.semantic.get(language);
  if (existing) return existing;
  const failure = runtime.semanticFailed.get(language);
  if (failure) throw new Error(failure);
  const { createSemanticAdapter } = await core();
  const languageServerPath = trustedLanguageServers()[language];
  try {
    const port = createSemanticAdapter({
      workspaceId: runtime.root,
      sourceRoot: runtime.root,
      scopeDigest: runtime.root,
      language,
      ...(languageServerPath ? { languageServerPath } : {}),
      workerPath: path.join(ROOT_DIR, "workers/semantic/main.mjs"),
    });
    runtime.semantic.set(language, port);
    return port;
  } catch (error) {
    runtime.semanticFailed.set(language, error.message);
    throw error;
  }
}

/** File bytes for byte-to-line conversion, cached only for one read request. */
async function fileBytes(cache, root, relativePath) {
  const key = `${root}\u0000${relativePath}`;
  let bytes = cache.get(key);
  if (bytes === undefined) {
    bytes = readFile(path.join(root, relativePath)).catch(() => null);
    cache.set(key, bytes);
  }
  return bytes;
}

/**
 * Zero-based line range for a half-open byte span.
 *
 * Counting newlines is the only honest conversion: the anchor was produced from
 * byte offsets and the product renders lines, so anything cheaper would be a
 * guess. `endLineExclusive` is the line after the last line the span touches.
 */
function lineRangeForSpan(bytes, span) {
  const start = Math.max(0, Math.min(span.startByte, bytes.length));
  const end = Math.max(start, Math.min(span.endByte, bytes.length));
  let startLine = 0;
  for (let index = 0; index < start; index += 1) if (bytes[index] === 0x0a) startLine += 1;
  let endLine = startLine;
  for (let index = start; index < end; index += 1) if (bytes[index] === 0x0a) endLine += 1;
  return { startLine, endLineExclusive: endLine + 1 };
}

function provenanceFor(component, operation, upstreamCommit, method) {
  return {
    backend: BACKEND_BY_COMPONENT[component],
    operation,
    // The exact fork the answer came from, so a stale build is visible in the
    // response instead of being attributed to the pinned source.
    backendVersion: upstreamCommit ?? "unknown",
    adapterVersion: ADAPTER_VERSION,
    executionId: `${component}-${method}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

async function toProductEvidence(item, { component, operation, root, upstreamCommit, index, fileCache }) {
  const provenance = provenanceFor(component, operation, upstreamCommit, item.method);
  const text = item.text ?? "";
  if (text.length === 0) return null;

  if (item.anchor === null) {
    // No canonical anchor means the backend gave prose. It stays prose: inventing
    // a locator from formatted text is exactly the failure this engine removes.
    return {
      typed: false,
      value: Evidence.makeOpaque({
        id: `${provenance.executionId}-${index}`,
        method: "opaque",
        text,
        reason: "unsupported_shape",
        provenance,
      }),
    };
  }

  const bytes = await fileBytes(fileCache, root, item.anchor.relativePath);
  if (bytes === null) {
    return {
      typed: false,
      value: Evidence.makeOpaque({
        id: `${provenance.executionId}-${index}`,
        method: "opaque",
        text,
        reason: "unsupported_shape",
        provenance,
      }),
    };
  }

  const range = lineRangeForSpan(bytes, item.anchor.span);
  const alias = item.aliases[0];
  return {
    typed: true,
    value: Evidence.makeEvidence({
      id: `${provenance.executionId}-${index}`,
      kind: KIND_TO_PRODUCT[item.kind] ?? "retrieval",
      method: METHOD_TO_PRODUCT[item.method] ?? "hybrid_retrieval",
      locator: { rootKey: root, relativePath: item.anchor.relativePath, range },
      ...(alias ? { subject: { qualifiedName: alias.nativeId, backendNamespace: alias.engine } } : {}),
      text,
      sourceCheck: item.sourceCheck === "matched"
        ? { status: "matched", sha256: item.anchor.contentHash }
        : { status: "unchecked", reason: "not_requested" },
      observation: { before: null, after: null, consistency: "unverified" },
      provenance: [provenance],
    }),
  };
}

/** Coverage in the control plane is richer than the product's three values. */
function productCoverage(coverage) {
  if (!coverage) return "unknown";
  if (coverage.completeWithinScope === true) return "backend_complete";
  if (coverage.completeWithinScope === false) return "bounded";
  return "unknown";
}

const ISSUE_TO_ERROR_CODE = {
  invalid_input: "MALFORMED_RESPONSE",
  ambiguous_subject: "UNRECOGNIZED_RESPONSE",
  unsupported_capability: "UNSUPPORTED_CAPABILITY",
  index_building: "INDEX_BUILDING",
  source_changed: "UNRECOGNIZED_RESPONSE",
  freshness_unavailable: "INDEX_UNAVAILABLE",
  deadline: "TIMEOUT",
  cancelled: "TIMEOUT",
  protocol_error: "MALFORMED_RESPONSE",
  worker_failed: "TRANSPORT_CLOSED",
  needs_recovery: "INDEX_UNAVAILABLE",
  output_truncated: "OUTPUT_LIMIT",
};

async function toEnvelope(result, { component, operation, root, upstreamCommit, timing, fileCache }) {
  const backend = BACKEND_BY_COMPONENT[component];
  const blocking = result.issues.find((issue) => issue.code !== "output_truncated");
  if (result.outcome === "error" || result.outcome === "unavailable") {
    const code = blocking ? ISSUE_TO_ERROR_CODE[blocking.code] ?? "TOOL_ERROR" : "TOOL_ERROR";
    return failureEnvelope(backend, operation, code, blocking?.message ?? `${backend} read failed`, {
      outcome: result.outcome,
      timing,
    });
  }

  const items = [];
  const opaque = [];
  let index = 0;
  for (const item of result.evidence) {
    const converted = await toProductEvidence(item, { component, operation, root, upstreamCommit, index: index += 1, fileCache });
    if (!converted) continue;
    if (converted.typed) items.push(converted.value);
    else opaque.push(converted.value);
  }

  return envelope({
    backend,
    operation,
    outcome: result.outcome,
    items,
    opaque,
    coverage: productCoverage(result.coverage),
    returned: items.length + opaque.length,
    total: result.coverage?.omitted === null ? null : items.length + opaque.length + (result.coverage?.omitted ?? 0),
    truncated: result.issues.some((issue) => issue.code === "output_truncated"),
    timing,
  });
}

const SEARCH_MODES = { search: "hybrid", auto: "hybrid", context: "hybrid" };

/**
 * One unified read. Mirrors `executeRead`'s contract exactly: it resolves to an
 * envelope for every outcome, including failure, so one degraded backend never
 * discards a sibling's answer.
 */
export async function unifiedRead(read, input, deadline) {
  const started = performance.now();
  const fileCache = new Map();
  const timing = () => {
    const totalMs = Math.max(0, Math.round(performance.now() - started));
    return { prepareMs: 0, queueMs: 0, executeMs: totalMs, totalMs };
  };
  const backend = read.backend;
  const component = backend === "zvec" ? "retrieval" : backend === "codegraph" ? "graph" : "semantic";

  // The index-manager stays the single lifecycle owner in both engine modes. The
  // unified path is a different *reader*, not a second indexer: two owners would
  // race on the same derived state. Serena has no derived index, so it is skipped.
  if (component !== "semantic") {
    try {
      deadline.signal?.throwIfAborted();
      const [ready] = await ensureIndexes(input.root, [backend], { freshness: input.freshness, timeoutMs: input.indexTimeoutMs, signal: deadline.signal });
      if (ready?.building || ready?.ready !== true) {
        // Serving a query off a projection that is still being built would return
        // a confident answer about a partial index.
        return failureEnvelope(backend, read.operation, ready?.building ? "INDEX_BUILDING" : "INDEX_UNAVAILABLE", ready?.detail ?? ready?.error ?? `${backend} index unavailable`, { timing: timing() });
      }
    } catch (error) {
      return failureEnvelope(backend, read.operation, "INDEX_UNAVAILABLE", error?.message ?? String(error), { timing: timing() });
    }
  }

  let runtime;
  try {
    runtime = await runtimeFor(input.root);
  } catch (error) {
    return failureEnvelope(backend, read.operation, "INDEX_UNAVAILABLE", error.message, { timing: timing() });
  }

  const { newRequestId } = await core();
  const context = {
    requestId: newRequestId(component),
    signal: deadline.signal,
    deadlineMonotonicMs: performance.now() + deadline.budget(input.timeoutMs),
    workspaceId: input.root,
    maxEvidence: input.limit,
    maxOutputChars: input.maxChars,
    maxWireBytes: 1_048_576,
  };

  try {
    if (component === "retrieval") {
      const result = await runtime.retrieval.read({
        query: input.query ?? input.symbol ?? "",
        mode: SEARCH_MODES[read.operation] ?? "hybrid",
        scope: { workspaceId: input.root, canonicalSourceRoot: input.root, canonicalStateRoot: input.root, scopeDigest: input.root, buildContextDigest: null, trustedForLanguageTools: false },
        view: null,
        limit: input.limit,
      }, context);
      return await toEnvelope(result, { component, operation: read.operation, root: input.root, upstreamCommit: runtime.retrieval.supervisor.upstreamCommit, timing: timing(), fileCache });
    }

    if (component === "graph") {
      const result = await runtime.graph.read({
        operation: read.operation === "impact" ? "impact" : read.operation === "architecture" ? "architecture" : "context",
        query: input.query ?? input.symbol ?? "",
        subject: input.symbol ? { namePath: input.symbol, relativePath: input.relativePath ?? null, anchor: null, nativeAlias: null } : null,
        depth: input.depth,
        view: { projection: "graph", viewId: input.root, appliedManifestId: input.root, profileDigest: "live", state: "clean" },
      }, context);
      return await toEnvelope(result, { component, operation: read.operation, root: input.root, upstreamCommit: runtime.graphSupervisor.upstreamCommit, timing: timing(), fileCache });
    }

    // The language decides which server answers, so it comes from the file under
    // question rather than from a global default that would silently ask the
    // wrong server about the wrong file.
    const extension = path.extname(input.relativePath ?? "").toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (!language) {
      return failureEnvelope(
        backend,
        read.operation,
        "UNSUPPORTED_CAPABILITY",
        "Cannot determine the language for this semantic request; supply relativePath with a recognized source-file extension.",
        { timing: timing() },
      );
    }
    const port = await semanticPort(runtime, language);
    const result = await port.read({
      operation: read.operation === "references" ? "references" : read.operation === "implementations" ? "implementations" : read.operation === "diagnostics" ? "diagnostics" : "symbol",
      subject: input.symbol ? { namePath: input.symbol, relativePath: input.relativePath ?? null, anchor: null, nativeAlias: null } : null,
      relativePath: input.relativePath ?? null,
      includeBody: input.includeBody,
    }, context);
    return await toEnvelope(result, { component, operation: read.operation, root: input.root, upstreamCommit: null, timing: timing(), fileCache });
  } catch (error) {
    // A throw here is a bug in the bridge or a dead worker, never a backend
    // answer. It degrades this one read; the engine keeps the others.
    return failureEnvelope(backend, read.operation, "TRANSPORT_CLOSED", error?.message ?? String(error), { timing: timing() });
  }
}

export async function embeddedLifecycle(root, backend, operation, options = {}, details = {}) {
  const runtime = await runtimeFor(root);
  const { newRequestId } = await core();
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  const context = {
    requestId: newRequestId(backend === "zvec" ? "retrieval" : "graph"),
    signal,
    deadlineMonotonicMs: performance.now() + timeoutMs,
    workspaceId: root,
  };
  const supervisor = backend === "zvec" ? runtime.retrieval.supervisor : runtime.graphSupervisor;
  const callOperation = backend === "zvec" ? (operation === "probe" ? "info" : "index") : operation;
  const payload = backend === "zvec"
    ? { root, options: { ...((options.embedding ?? details.embedding) ? { embedding: await (options.embedding ?? details.embedding) } : {}), ...(operation === "rebuild" ? { rebuild: true } : {}) } }
    : { root };
  const result = await supervisor.call(callOperation, payload, context);
  if (!result.ok) {
    if (operation === "probe") return { present: false, ready: false, building: false, detail: result.message };
    throw new Error(result.message);
  }
  if (operation === "probe") {
    if (backend === "zvec") {
      const info = result.payload;
      const status = info.status;
      const building = Boolean(status && status.filesPending > 0);
      return {
        present: Boolean(info.indexed),
        ready: Boolean(info.indexed) && !building,
        building,
        detail: status ? JSON.stringify({ filesPending: status.filesPending, filesFailed: status.filesFailed }) : info.suggestion ?? null,
      };
    }
    const stats = result.payload?.stats ?? result.payload;
    return { present: true, ready: true, building: false, detail: JSON.stringify(stats) };
  }
  return result.payload;
}

/** Release every worker process. Safe to call when nothing was ever started. */
export async function closeUnified() {
  const pending = [...runtimes.values()];
  runtimes.clear();

  for (const entry of pending) {
    try {
      const runtime = await entry;
      await runtime.retrieval.close();
      await runtime.graphSupervisor.close();
      for (const port of runtime.semantic.values()) await port.close();
    } catch (error) {
      log("warn", "unified runtime shutdown failed", { error: error?.message ?? String(error) });
    }
  }
}

/** Exposed for the contract test: byte spans must render as the lines they cover. */
export const __internals = { lineRangeForSpan, METHOD_TO_PRODUCT, KIND_TO_PRODUCT };
