import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createGraphAdapter } = await import("../../packages/core/dist/index.js");

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("source evidence is read fresh for each graph request", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-stale-source-"));
  const relativePath = "source.txt";
  const sourcePath = path.join(workspace, relativePath);
  const context = {
    workspaceId: workspace,
    maxEvidence: 20,
    signal: undefined,
    deadlineMonotonicMs: performance.now() + 30_000,
    maxOutputChars: 8_000,
    maxWireBytes: 1_048_576,
  };
  const supervisor = {
    upstreamCommit: "test",
    async call() {
      const content = await readFile(sourcePath, "utf8");
      return {
        ok: true,
        outcome: "ok",
        payload: {
          result: "subgraph",
          subgraph: {
            nodes: [{ id: "node", kind: "function", name: content.trim(), filePath: relativePath, startLine: 1, endLine: 1 }],
            edges: [],
            roots: ["node"],
          },
        },
      };
    },
    async close() {},
  };
  const adapter = createGraphAdapter({ supervisor, sourceRoot: workspace });
  const request = {
    operation: "architecture",
    query: "node",
    subject: null,
    depth: 2,
    view: null,
  };

  try {
    const before = "before edit\n";
    const after = "after edit\n";
    await writeFile(sourcePath, before);
    const first = await adapter.read(request, context);
    await writeFile(sourcePath, after);
    const second = await adapter.read(request, context);

    assert.equal(first.evidence[0].text, before.trim());
    assert.equal(first.evidence[0].anchor.contentHash, digest(before));
    assert.equal(second.evidence[0].text, after.trim());
    assert.equal(second.evidence[0].anchor.contentHash, digest(after));
    assert.notEqual(second.evidence[0].text, first.evidence[0].text);
    assert.notEqual(second.evidence[0].anchor.contentHash, first.evidence[0].anchor.contentHash);
  } finally {
    await adapter.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a symbol request without a source path is refused instead of assuming TypeScript", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-symbol-language-"));
  const previousRoot = process.env.LAZY_INTEL_ROOT;
  const previousAllowedRoots = process.env.LAZY_INTEL_ALLOWED_ROOTS;
  const previousLsp = process.env.LAZY_INTEL_LSP;
  const previousEngine = process.env.LAZY_INTEL_ENGINE;
  try {
    await writeFile(path.join(workspace, "module.py"), "def target():\n    return 1\n");
    process.env.LAZY_INTEL_ROOT = workspace;
    process.env.LAZY_INTEL_ALLOWED_ROOTS = workspace;
    process.env.LAZY_INTEL_LSP = "";
    process.env.LAZY_INTEL_ENGINE = "unified";
    const { codeIntel } = await import("../../src/engine.js");
    const result = await codeIntel({
      operation: "symbol",
      backend: "serena",
      root: workspace,
      symbol: "target",
      timeoutMs: 5_000,
      indexTimeoutMs: 5_000,
    });
    const serena = result.meta.backends.find((entry) => entry.backend === "serena");
    assert.ok(serena, JSON.stringify(result));
    assert.equal(serena.outcome, "unavailable");
    assert.match(serena.warning ?? "", /language.*relativePath|relativePath.*language/i);
    assert.equal(result.isError, true);
  } finally {
    if (previousRoot === undefined) delete process.env.LAZY_INTEL_ROOT;
    else process.env.LAZY_INTEL_ROOT = previousRoot;
    if (previousAllowedRoots === undefined) delete process.env.LAZY_INTEL_ALLOWED_ROOTS;
    else process.env.LAZY_INTEL_ALLOWED_ROOTS = previousAllowedRoots;
    if (previousLsp === undefined) delete process.env.LAZY_INTEL_LSP;
    else process.env.LAZY_INTEL_LSP = previousLsp;
    if (previousEngine === undefined) delete process.env.LAZY_INTEL_ENGINE;
    else process.env.LAZY_INTEL_ENGINE = previousEngine;
    await rm(workspace, { recursive: true, force: true });
  }
});
