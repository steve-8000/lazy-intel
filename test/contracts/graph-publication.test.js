import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import codegraph from "../../vendor/codegraph/dist/index.js";

const { CodeGraph, NODE_KINDS } = codegraph;
const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILT = existsSync(path.join(ROOT, "packages/core/dist/index.js")) && existsSync(path.join(ROOT, "vendor/codegraph/dist/lazy-entry.js"));

function graphState(graph) {
  const nodes = NODE_KINDS.flatMap((kind) => graph.getNodesByKind(kind))
    .map(({ id, kind, name, qualifiedName, filePath, language, startLine, endLine, startColumn, endColumn }) => ({ id, kind, name, qualifiedName, filePath, language, startLine, endLine, startColumn, endColumn }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const edges = nodes
    .flatMap(({ id }) => graph.getOutgoingEdges(id))
    .filter(({ source, target }) => nodeIds.has(source) && nodeIds.has(target))
    .map(({ source, target, kind, metadata, line, column, provenance }) => ({ source, target, kind, metadata, line, column, provenance }))
    .sort((left, right) => `${left.source}\0${left.target}\0${left.kind}`.localeCompare(`${right.source}\0${right.target}\0${right.kind}`));
  return { nodes, edges };
}

async function writeCorpus(root, corpus) {
  for (const [relativePath, content] of Object.entries(corpus)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content, "utf8");
  }
}

function snapshotEntries(corpus) {
  return Object.entries(corpus).map(([relativePath, content]) => ({ relativePath, content }));
}

const metadataCorpus = {
  "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "go.mod": "module example.com/captured\n\ngo 1.22\n",
  "src/thing.ts": "export function thing() { return 1; }\n",
  "src/app.ts": "import { thing } from '@/thing';\nexport function app() { return thing(); }\n",
  "lib/lib.go": "package lib\n\nfunc Run() int { return 1 }\n",
  "cmd/main.go": "package main\n\nimport \"example.com/captured/lib\"\n\nfunc main() { lib.Run() }\n",
  "packages/dep/package.json": JSON.stringify({ name: "@captured/dep", main: "index.js" }),
  "packages/dep/index.js": "export function dep() { return 1; }\n",
  "packages/app/index.js": "import { dep } from '@captured/dep';\nexport function packageApp() { return dep(); }\n",
};

test("authoritative captured metadata is stable when live source files are changed or deleted", { timeout: 300_000 }, async () => {
  const incrementalRoot = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-captured-"));
  const freshRoot = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-captured-fresh-"));
  const captured = { ...metadataCorpus, "src/app.ts": metadataCorpus["src/app.ts"] + "export function changed() { return 7; }\n" };
  const graph = await CodeGraph.init(incrementalRoot, { index: false });
  try {
    await writeCorpus(incrementalRoot, metadataCorpus);
    await graph.syncSnapshots(snapshotEntries(metadataCorpus), [], new Map(Object.entries(metadataCorpus)));
    const before = graphState(graph);
    assert.ok(before.nodes.some(({ qualifiedName }) => qualifiedName === "app"), "captured TypeScript source was not indexed");
    assert.ok(before.nodes.some(({ qualifiedName }) => qualifiedName === "Run"), "captured Go source was not indexed");
    assert.ok(before.nodes.some(({ qualifiedName }) => qualifiedName === "packageApp"), "captured workspace source was not indexed");

    await writeFile(path.join(incrementalRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["missing/*"] } } }), "utf8");
    await unlink(path.join(incrementalRoot, "lib/lib.go"));
    await writeFile(path.join(incrementalRoot, "go.mod"), "module example.com/live-mutated\n", "utf8");
    await writeFile(path.join(incrementalRoot, "packages/dep/package.json"), JSON.stringify({ name: "@live/mutated", main: "missing.js" }), "utf8");
    await unlink(path.join(incrementalRoot, "packages/dep/index.js"));
    await graph.syncSnapshots([{ relativePath: "src/thing.ts", content: metadataCorpus["src/thing.ts"] }], [], new Map(Object.entries(metadataCorpus)));
    assert.deepEqual(graphState(graph), before, "live metadata mutations changed the graph despite an unchanged captured map");

    await graph.syncSnapshots([{ relativePath: "src/app.ts", content: captured["src/app.ts"] }], [], new Map(Object.entries(captured)));
    await writeCorpus(freshRoot, captured);
    const fresh = await CodeGraph.init(freshRoot, { index: true });
    try {
      assert.deepEqual(graphState(graph), graphState(fresh), "captured metadata graph diverged from a fresh build using the same captured map");
      assert.ok(graphState(graph).nodes.some(({ qualifiedName }) => qualifiedName === "changed"), "the changed captured source was applied");
    } finally {
      fresh.close();
    }
  } finally {
    graph.close();
    await rm(incrementalRoot, { recursive: true, force: true });
    await rm(freshRoot, { recursive: true, force: true });
  }

  // The SDK path without a captured map remains filesystem-backed: a newly created
  // source is visible to a normal indexed initialization.
  const stockRoot = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-stock-sdk-"));
  try {
    await writeFile(path.join(stockRoot, "stock.js"), "export function stockSdk() { return 1; }\n", "utf8");
    const stock = await CodeGraph.init(stockRoot, { index: true });
    try {
      assert.ok(stock.getNodesByKind("function").some(({ qualifiedName }) => qualifiedName === "stockSdk"));
    } finally {
      stock.close();
    }
  } finally {
    await rm(stockRoot, { recursive: true, force: true });
  }
});
test("captured directory imports do not resolve through uncaptured disk files", { timeout: 300_000 }, async () => {
  const incrementalRoot = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-captured-directory-"));
  const freshRoot = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-captured-directory-fresh-"));
  const captured = {
    "src/entry.js": "import run from './mod';\nexport function call() { return run(); }\n",
    "src/mod/index.js": "export default function impl() { return 1; }\n",
  };
  const liveOnly = "export default function liveOnly() { return 2; }\n";
  const graph = await CodeGraph.init(incrementalRoot, { index: false });
  try {
    await writeCorpus(incrementalRoot, { ...captured, "src/mod.js": liveOnly });
    await graph.syncSnapshots(snapshotEntries(captured), [], new Map(Object.entries(captured)));
    await writeCorpus(freshRoot, captured);
    const fresh = await CodeGraph.init(freshRoot, { index: true });
    try {
      const capturedState = graphState(graph);
      const freshState = graphState(fresh);
      const callNode = capturedState.nodes.find(({ qualifiedName }) => qualifiedName === "call");
      const runNode = capturedState.nodes.find(({ qualifiedName, filePath }) => qualifiedName === "impl" && filePath === "src/mod/index.js");
      assert.ok(callNode, "captured caller was not indexed");
      assert.ok(runNode, "captured directory module was not indexed");
      assert.ok(capturedState.edges.some(({ source, target, kind }) => source === callNode.id && target === runNode.id && kind === "calls"), "captured import/call edge resolved to the live-only sibling or was dropped");
      assert.deepEqual(capturedState, freshState, "captured directory import graph diverged from a fresh build using the same captured sources");
    } finally {
      fresh.close();
    }
  } finally {
    graph.close();
    await rm(incrementalRoot, { recursive: true, force: true });
    await rm(freshRoot, { recursive: true, force: true });
  }
});


test("public graph sync handles a late framework manifest across multipart publication", { skip: BUILT ? false : "run npm run build first", timeout: 600_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-multipart-"));
  const fresh = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-multipart-fresh-"));
  try {
    const filler = "export function filler() { return 1; }\n" + "// " + "x".repeat(5200) + "\n";
    for (let index = 0; index < 160; index += 1) {
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, `src/filler-${String(index).padStart(3, "0")}.js`), filler, "utf8");
    }
    const fixtureBytes = Buffer.byteLength(filler, "utf8") * 160;
    assert.ok(fixtureBytes > 700_000, `multipart fixture is only ${fixtureBytes} bytes`);
    await mkdir(path.join(workspace, "src/pages"), { recursive: true });
    await writeFile(path.join(workspace, "src/pages/index.astro"), "---\nconst message = 'late-manifest';\n---\n<html><body>{message}</body></html>\n", "utf8");
    // Create the framework marker after the large source set so it is late in the
    // captured publication rather than being the first multipart part.

    const probe = `
      const { writeFile } = await import("node:fs/promises");
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      try {
        const warm = await codeIntel({ operation: "sync", backend: "codegraph", root: ${JSON.stringify(workspace)}, timeoutMs: 120000, indexTimeoutMs: 120000 });
        await writeFile(${JSON.stringify(path.join(workspace, "package.json"))}, JSON.stringify({ dependencies: { astro: "^5" } }));
        const synced = await codeIntel({ operation: "sync", backend: "codegraph", root: ${JSON.stringify(workspace)}, timeoutMs: 120000, indexTimeoutMs: 120000 });
        const queried = await codeIntel({ operation: "architecture", backend: "codegraph", root: ${JSON.stringify(workspace)}, query: "route", freshness: "strict", maxChars: 32000, timeoutMs: 120000, indexTimeoutMs: 120000 });
        process.stdout.write("RESULT:" + JSON.stringify({ synced: synced.meta, queried: queried.meta }) + "\\n");
      } finally {
        await closeUnified();
      }
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: ROOT,
      timeout: 540_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
    assert.ok(line, `graph multipart probe produced no result:\n${stdout}`);
    const result = JSON.parse(line.slice("RESULT:".length));
    assert.equal(result.synced.status, "ok", JSON.stringify(result));
    assert.equal(result.synced.backends[0].backend, "codegraph", JSON.stringify(result));
    assert.equal(result.queried.status, "ok", JSON.stringify(result));
    assert.ok(result.queried.evidence.some((item) => item.anchor?.relativePath === "src/pages/index.astro"), JSON.stringify(result.queried));

    await writeCorpus(fresh, {
      "package.json": JSON.stringify({ dependencies: { astro: "^5" } }),
      "src/pages/index.astro": "---\nconst message = 'late-manifest';\n---\n<html><body>{message}</body></html>\n",
    });
    const freshGraph = await CodeGraph.init(fresh, { index: true });
    try {
      assert.equal(freshGraph.getNodesByKind("route").some(({ filePath, name }) => filePath === "src/pages/index.astro" && name === "/"), true);
    } finally {
      freshGraph.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
  }
});


test("public graph sync yields a valid empty graph after deleting the last source", { skip: BUILT ? false : "run npm run build first", timeout: 600_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-graph-empty-"));
  try {
    const sourcePath = path.join(workspace, "only.js");
    await writeFile(sourcePath, "export function onlyGraph() { return 1; }\n", "utf8");
    const probe = `
      import { rm } from "node:fs/promises";
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      try {
        const first = await codeIntel({ operation: "sync", backend: "codegraph", root: ${JSON.stringify(workspace)}, timeoutMs: 120000, indexTimeoutMs: 120000 });
        await rm(${JSON.stringify(sourcePath)});
        const deleted = await codeIntel({ operation: "sync", backend: "codegraph", root: ${JSON.stringify(workspace)}, timeoutMs: 120000, indexTimeoutMs: 120000 });
        const queried = await codeIntel({ operation: "architecture", backend: "codegraph", root: ${JSON.stringify(workspace)}, query: "onlyGraph", freshness: "strict", maxChars: 32000, timeoutMs: 120000, indexTimeoutMs: 120000 });
        process.stdout.write("RESULT:" + JSON.stringify({ first: first.meta, deleted: deleted.meta, queried: queried.meta, isError: queried.isError }) + "\\n");
      } finally {
        await closeUnified();
      }
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: ROOT,
      timeout: 540_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
    assert.ok(line, `graph empty probe produced no result:\n${stdout}`);
    const result = JSON.parse(line.slice("RESULT:".length));
    assert.equal(result.first.status, "ok", JSON.stringify(result));
    assert.equal(result.deleted.status, "ok", JSON.stringify(result));
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.queried.status, "empty", JSON.stringify(result));
    assert.deepEqual(result.queried.evidence, [], JSON.stringify(result));
    assert.deepEqual(result.queried.issues, [], JSON.stringify(result));
    assert.equal(result.queried.backends[0].outcome, "empty", JSON.stringify(result));
    assert.ok(result.queried.views.every((view) => view.state === "clean"), JSON.stringify(result));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
