/**
 * The unified runtime owns both the publication coordinator and its workers. This
 * contract runs with only the Node directory on PATH, so no external backend CLI
 * can accidentally make a query pass.
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
const NODE_ONLY_PATH = path.dirname(process.execPath);

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-embedded-lifecycle-"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(directory, "main.js"), "export function applyDiscount(total, rate) {\n  return total * (1 - rate);\n}\n");
  await writeFile(path.join(directory, "invoice.js"), "import { applyDiscount } from './main.js';\n\nexport function invoice(total) {\n  return applyDiscount(total, 0.1);\n}\n");
  return directory;
}

async function drive(root) {
  const script = [
    `const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});`,
    `const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});`,
    `const root = ${JSON.stringify(root)};`,
    "let out;",
    "try {",
    "  const reindex = await codeIntel({ operation: 'reindex', backend: 'codegraph', root, indexTimeoutMs: 300000 });",
    "  const query = await codeIntel({ operation: 'impact', symbol: 'applyDiscount', query: 'applyDiscount', root, timeoutMs: 120000, indexTimeoutMs: 300000 });",
    "  out = { reindex: reindex.meta, query: query.meta };",
    "} catch (error) { out = { failed: error instanceof Error ? error.message : String(error) }; }",
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
      LAZY_INTEL_ENGINE: "unified",
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

test("the embedded runtime publishes and queries a graph with no external CLI reachable", { timeout: 900_000 }, async () => {
  const root = await workspace();
  try {
    const result = await drive(root);
    assert.ok(!result.failed, `unified failed with no CLI on PATH: ${result.failed}`);
    assert.equal(result.reindex.status, "ok", JSON.stringify(result.reindex));
    assert.deepEqual(result.reindex.backends.map((entry) => entry.backend), ["codegraph"]);
    assert.equal(result.reindex.backends[0].ok, true, JSON.stringify(result.reindex));

    assert.equal(result.query.status, "ok", JSON.stringify(result.query));
    assert.equal(result.query.backends[0].backend, "codegraph");
    assert.ok(result.query.evidence.length > 0, `query returned no evidence: ${JSON.stringify(result.query)}`);
    assert.ok(
      result.query.evidence.some((item) => item.method === "indexed_graph" && item.locator?.relativePath),
      `query returned no anchored graph evidence: ${JSON.stringify(result.query.evidence)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
