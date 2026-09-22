import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";


test("a symbol request without a source path is refused instead of assuming TypeScript", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-symbol-language-"));
  const previousRoot = process.env.LAZY_INTEL_ROOT;
  const previousAllowedRoots = process.env.LAZY_INTEL_ALLOWED_ROOTS;
  const previousLsp = process.env.LAZY_INTEL_LSP;
  try {
    await writeFile(path.join(workspace, "module.py"), "def target():\n    return 1\n");
    process.env.LAZY_INTEL_ROOT = workspace;
    process.env.LAZY_INTEL_ALLOWED_ROOTS = workspace;
    process.env.LAZY_INTEL_LSP = "";
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
    assert.equal(result.isError, true);
  } finally {
    if (previousRoot === undefined) delete process.env.LAZY_INTEL_ROOT;
    else process.env.LAZY_INTEL_ROOT = previousRoot;
    if (previousAllowedRoots === undefined) delete process.env.LAZY_INTEL_ALLOWED_ROOTS;
    else process.env.LAZY_INTEL_ALLOWED_ROOTS = previousAllowedRoots;
    if (previousLsp === undefined) delete process.env.LAZY_INTEL_LSP;
    else process.env.LAZY_INTEL_LSP = previousLsp;
    await rm(workspace, { recursive: true, force: true });
  }
});
