import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const environment = ["LAZY_INTEL_ROOT", "LAZY_INTEL_ALLOWED_ROOTS", "LAZY_INTEL_AUTO_INDEX", "LAZY_INTEL_MAINTENANCE_MS"];
const savedEnvironment = Object.fromEntries(environment.map((name) => [name, process.env[name]]));
const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-auto-symbol-"));
process.env.LAZY_INTEL_ROOT = root;
process.env.LAZY_INTEL_ALLOWED_ROOTS = root;
process.env.LAZY_INTEL_AUTO_INDEX = "false";
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";

const { codeIntel } = await import("../src/engine.js");
const { ensureIndexes, closeIndexManager } = await import("../src/index-manager.js");
const { closeUnified } = await import("../src/unified.js");

await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
await writeFile(path.join(root, "discount.js"), "export function applyDiscount(total, rate) { return total * (1 - rate); }\n");
await writeFile(path.join(root, "invoice.js"), "import { applyDiscount } from './discount.js';\nexport function invoice(total) { return applyDiscount(total, 0.1); }\n");
await writeFile(path.join(root, "duplicate-a.js"), "export function duplicate() { return 'a'; }\n");
await writeFile(path.join(root, "duplicate-b.js"), "export function duplicate() { return 'b'; }\n");

after(async () => {
  closeIndexManager();
  await closeUnified();
  await rm(root, { recursive: true, force: true });
  for (const name of environment) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
});

test("auto keeps same-named indexed definitions ambiguous", { timeout: 900_000, concurrency: false }, async () => {
  await ensureIndexes(root, ["codegraph"], { freshness: "strict", timeoutMs: 120_000 });
  const result = await codeIntel({
    operation: "auto",
    query: "where is duplicate",
    symbol: "duplicate",
    root,
    timeoutMs: 120_000,
    indexTimeoutMs: 120_000,
  });

  assert.equal(result.meta.stopReason, "ambiguous_subject");
});

test("auto resolves a pathless symbol from the embedded CodeGraph index", { timeout: 900_000, concurrency: false }, async () => {
  const [published] = await ensureIndexes(root, ["codegraph"], { freshness: "strict", timeoutMs: 120_000 });
  assert.equal(published.ok, true, JSON.stringify(published));

  const result = await codeIntel({
    operation: "auto",
    query: "where is applyDiscount",
    symbol: "applyDiscount",
    root,
    timeoutMs: 120_000,
    indexTimeoutMs: 120_000,
  });

  assert.notEqual(result.meta.stopReason, "subject_unresolved");
  assert.ok(
    result.meta.evidence.some((item) => item.locator?.relativePath === "discount.js"),
    JSON.stringify(result.meta.evidence),
  );
});
