import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILT = existsSync(path.join(ROOT, "packages/core/dist/index.js")) && existsSync(path.join(ROOT, "vendor/zvec-grep/dist/lazy-entry.js"));

const { __internals } = await import("../../src/unified.js");

test("a byte span renders as exactly the lines it covers", () => {
  const bytes = Buffer.from("alpha\nbeta\ngamma\ndelta\n", "utf8");
  const beta = bytes.indexOf("beta");
  const gamma = bytes.indexOf("gamma");

  // A span wholly inside one line is that one line, end-exclusive.
  assert.deepEqual(__internals.lineRangeForSpan(bytes, { coordinateSystem: "utf8-bytes", startByte: beta, endByte: beta + 4 }), { startLine: 1, endLineExclusive: 2 });
  // A span crossing a newline covers both lines.
  assert.deepEqual(__internals.lineRangeForSpan(bytes, { coordinateSystem: "utf8-bytes", startByte: beta, endByte: gamma + 5 }), { startLine: 1, endLineExclusive: 3 });
  // The first line is line zero, not line one.
  assert.deepEqual(__internals.lineRangeForSpan(bytes, { coordinateSystem: "utf8-bytes", startByte: 0, endByte: 5 }), { startLine: 0, endLineExclusive: 1 });
  // A span past the end of the file is clamped rather than producing a line count
  // larger than the file has lines.
  assert.deepEqual(__internals.lineRangeForSpan(bytes, { coordinateSystem: "utf8-bytes", startByte: 0, endByte: bytes.length + 500 }), { startLine: 0, endLineExclusive: 5 });
});

test("multi-byte characters do not shift the reported line", () => {
  // A naive byte-index-as-character-index conversion would land on the wrong line
  // here, because the first line is four characters but seven bytes.
  const bytes = Buffer.from("héllo\ntarget\n", "utf8");
  const target = bytes.indexOf("target");
  assert.equal(bytes.length, 14);
  assert.deepEqual(__internals.lineRangeForSpan(bytes, { coordinateSystem: "utf8-bytes", startByte: target, endByte: target + 6 }), { startLine: 1, endLineExclusive: 2 });
});

test("control-plane methods narrow onto the product enum without inventing a stronger claim", async () => {
  const { EVIDENCE_METHODS, EVIDENCE_KINDS } = await import("../../src/contracts.js");
  for (const [coreMethod, productMethod] of Object.entries(__internals.METHOD_TO_PRODUCT)) {
    assert.ok(EVIDENCE_METHODS.includes(productMethod), `${coreMethod} maps to ${productMethod}, which the product enum does not have`);
  }
  for (const [coreKind, productKind] of Object.entries(__internals.KIND_TO_PRODUCT)) {
    assert.ok(EVIDENCE_KINDS.includes(productKind), `${coreKind} maps to ${productKind}, which the product enum does not have`);
  }
  // A lexical hit must never be presented as an LSP fact, and a graph edge must
  // never be presented as a retrieval guess.
  assert.equal(__internals.METHOD_TO_PRODUCT.lexical, "hybrid_retrieval");
  assert.equal(__internals.METHOD_TO_PRODUCT.resolved_graph, "indexed_graph");
  assert.equal(__internals.METHOD_TO_PRODUCT.lsp, "lsp");
});

test("the unified engine serves a real search through the vendored library", { skip: BUILT ? false : "run npm run build first", timeout: 600_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-unified-"));
  try {
    await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(workspace, "discount.mjs"), "// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
    await writeFile(path.join(workspace, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");

    // A child process, because the unified path starts long-lived workers and the
    // engine module reads LAZY_INTEL_ENGINE once at import.
    const probe = `
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      const result = await codeIntel({ operation: "search", root: ${JSON.stringify(workspace)}, query: "percentage discount invoice cents", limit: 10, maxChars: 8000, timeoutMs: 120000, indexTimeoutMs: 300000 });
      await closeUnified();
      process.stdout.write("RESULT:" + JSON.stringify({ status: result.meta.status, backends: result.meta.backends, evidence: result.meta.evidence, isError: result.isError }) + "\\n");
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: ROOT,
      timeout: 540_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });

    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
    assert.ok(line, `unified probe produced no result:\n${stdout}`);
    const result = JSON.parse(line.slice("RESULT:".length));

    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.backends.map((row) => row.backend), ["zvec"]);
    assert.ok(["ok", "empty"].includes(result.backends[0].outcome), `unexpected outcome ${result.backends[0].outcome}`);
    // The whole point of the unified path: retrieval evidence is anchored, not one
    // opaque block of CLI prose the way the legacy adapter had to emit it.
    if (result.backends[0].outcome === "ok") {
      assert.ok(result.evidence.length > 0, "an ok retrieval read must carry evidence");
      assert.ok(
        result.evidence.some((descriptor) => descriptor.method !== "opaque" && descriptor.locator?.relativePath),
        `unified retrieval produced no anchored evidence: ${JSON.stringify(result.evidence)}`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


/** Never discovered, never installed: the operator names the executable or there is none. */
const PYRIGHT = process.env.LAZY_INTEL_TEST_PYRIGHT ?? "/opt/homebrew/bin/pyright-langserver";

test("an unconfigured language server is refused with the reason, not a silent unavailable", { skip: BUILT ? false : "run npm run build first", timeout: 300_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-nolsp-"));
  try {
    await writeFile(path.join(workspace, "discount.py"), "def apply_discount(cents, percent):\n    return cents\n");
    const probe = `
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      const result = await codeIntel({ operation: "symbol", root: ${JSON.stringify(workspace)}, symbol: "apply_discount", relativePath: "discount.py", timeoutMs: 60000, indexTimeoutMs: 120000 });
      await closeUnified();
      process.stdout.write("RESULT:" + JSON.stringify({ backends: result.meta.backends }) + "\\n");
    `;
    // LAZY_INTEL_LSP is deliberately absent here.
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: ROOT, timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_LSP: "", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });
    const result = JSON.parse(stdout.split("\n").find((entry) => entry.startsWith("RESULT:")).slice("RESULT:".length));
    const serena = result.backends.find((row) => row.backend === "serena");
    assert.ok(serena, JSON.stringify(result));
    assert.equal(serena.outcome, "unavailable");
    // A bare `unavailable` would leave an operator with nothing to act on.
    assert.match(serena.warning ?? "", /never downloads language servers/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a configured language server serves anchored semantic evidence", { skip: BUILT && existsSync(PYRIGHT) ? false : `needs a built tree and a language server at ${PYRIGHT}`, timeout: 300_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-lsp-"));
  try {
    await writeFile(path.join(workspace, "discount.py"), "def apply_discount(cents, percent):\n    return round(cents * (100 - percent) / 100)\n");
    await writeFile(path.join(workspace, "invoice.py"), "from discount import apply_discount\n\n\ndef invoice_total(cents, percent):\n    return apply_discount(cents, percent)\n");
    const probe = `
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      const out = {};
      for (const operation of ["symbol", "references"]) {
        const result = await codeIntel({ operation, root: ${JSON.stringify(workspace)}, symbol: "apply_discount", relativePath: "discount.py", timeoutMs: 120000, indexTimeoutMs: 240000 });
        out[operation] = { backends: result.meta.backends, evidence: result.meta.evidence };
      }
      await closeUnified();
      process.stdout.write("RESULT:" + JSON.stringify(out) + "\\n");
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: ROOT, timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_LSP: JSON.stringify({ python: PYRIGHT }), LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });
    const out = JSON.parse(stdout.split("\n").find((entry) => entry.startsWith("RESULT:")).slice("RESULT:".length));
    for (const operation of ["symbol", "references"]) {
      const row = out[operation].backends.find((entry) => entry.backend === "serena");
      assert.equal(row.outcome, "ok", `${operation}: ${JSON.stringify(out[operation].backends)}`);
      assert.ok(out[operation].evidence.length > 0, `${operation} returned no evidence`);
      // The legacy Serena adapter could only hand back tool prose. Every item here
      // must be a real locator inside the workspace.
      for (const descriptor of out[operation].evidence) {
        assert.equal(descriptor.method, "lsp", JSON.stringify(descriptor));
        assert.match(descriptor.locator.relativePath, /\.py$/);
        assert.ok(Number.isInteger(descriptor.locator.range.startLine));
      }
    }

    // A reference to a function defined in discount.py occurs in invoice.py. If the
    // adapter reported the referencing symbol's own file, or the file the caller
    // asked about, this would say discount.py — which is how the real cross-file
    // mislabelling bug presented.
    const referenceFiles = new Set(out.references.evidence.map((descriptor) => descriptor.locator.relativePath));
    assert.ok(referenceFiles.has("invoice.py"), `references pointed at ${[...referenceFiles].join(", ")} instead of the calling file`);

    // The reference text is the source window the locator spans, so the engine's
    // own source verifier must be able to confirm it byte for byte. A rendered
    // display string with line-number gutters would report a permanent mismatch
    // and drown out the mismatches that actually mean the file changed.
    assert.ok(
      out.references.evidence.every((descriptor) => descriptor.sourceCheck === "matched"),
      `reference evidence failed source verification: ${JSON.stringify(out.references.evidence.map((d) => [d.locator.relativePath, d.sourceCheck]))}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});