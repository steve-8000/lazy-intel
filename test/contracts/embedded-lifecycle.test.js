/**
 * Unified mode claims no external install is needed on the query path
 * (README.md, "Two engines, one tool"). The claim is only worth making if it is
 * measured, so both tests here run with `PATH` reduced to the directory holding
 * this Node binary: `zg` and `codegraph` are unreachable.
 *
 * The legacy test is the control. Without it, a passing unified run could just
 * mean the restricted environment never actually hid the executables.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Only the running interpreter. Anything the product needs beyond Node has to be
// something it owns, which is exactly the property under test.
const NODE_ONLY_PATH = path.dirname(process.execPath);

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-embedded-lifecycle-"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(directory, "discount.mjs"), "export function applyDiscount(total, rate) {\n  return total * (1 - rate);\n}\n");
  await writeFile(path.join(directory, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\n\nexport function invoice(total) {\n  return applyDiscount(total, 0.1);\n}\n");
  return directory;
}

async function drive(root, engine, body) {
  const script = [
    `const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});`,
    `const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});`,
    `const root = ${JSON.stringify(root)};`,
    "let out;",
    "try { out = await (async () => { " + body + " })(); }",
    "catch (error) { out = { failed: error instanceof Error ? error.message : String(error) }; }",
    "await closeUnified();",
    "process.stdout.write('RESULT:' + JSON.stringify(out) + '\\n');",
  ].join("\n");
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    timeout: 540_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: NODE_ONLY_PATH,
      LAZY_INTEL_ENGINE: engine,
      LAZY_INTEL_ROOT: root,
      LAZY_INTEL_ALLOWED_ROOTS: root,
      LAZY_INTEL_AUTO_INDEX: "false",
      LAZY_INTEL_MAINTENANCE_MS: "0",
    },
  });
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, `no RESULT line in: ${stdout}`);
  return JSON.parse(line.slice("RESULT:".length));
}

test("unified builds both indexes and answers a query with no backend executable reachable", { timeout: 900_000 }, async () => {
  const root = await workspace();
  try {
    const result = await drive(root, "unified", [
      "const reindex = await codeIntel({ operation: 'reindex', backend: 'all', root, indexTimeoutMs: 300000 });",
      "const search = await codeIntel({ operation: 'search', query: 'applying a percentage discount to a total', root, timeoutMs: 120000, indexTimeoutMs: 300000 });",
      "return { reindex: reindex.meta, search: search.meta };",
    ].join("\n"));

    assert.ok(!result.failed, `unified failed with no CLI on PATH: ${result.failed}`);
    assert.equal(result.reindex.status, "ok", JSON.stringify(result.reindex));
    assert.deepEqual(result.reindex.backends.map((entry) => entry.backend), ["zvec", "codegraph"]);
    assert.ok(result.reindex.backends.every((entry) => entry.ok === true), JSON.stringify(result.reindex));

    // Lifecycle alone is not the claim; the query path must also stay inside the
    // product, and it must produce anchored evidence rather than an empty answer
    // that would pass this test for the wrong reason.
    assert.equal(result.search.status, "ok", JSON.stringify(result.search));
    const anchored = result.search.evidence.filter((item) => item.locator?.relativePath);
    assert.ok(anchored.length > 0, `search returned no anchored evidence: ${JSON.stringify(result.search.evidence)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy in the same environment cannot proceed, proving the executables really were hidden", { timeout: 300_000 }, async () => {
  const root = await workspace();
  try {
    const result = await drive(root, "legacy", [
      "const reindex = await codeIntel({ operation: 'reindex', backend: 'all', root, indexTimeoutMs: 120000 });",
      "return { reindex: reindex.meta };",
    ].join("\n"));

    const backends = result.reindex?.backends ?? [];
    assert.ok(
      result.failed || backends.some((entry) => entry.ok === false),
      `legacy unexpectedly succeeded without zg or codegraph on PATH: ${JSON.stringify(result)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
