import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const ENVIRONMENT = [
  "LAZY_INTEL_ROOT",
  "LAZY_INTEL_ALLOWED_ROOTS",
  "LAZY_INTEL_AUTO_INDEX",
  "LAZY_INTEL_MAINTENANCE_MS",
  "LAZY_INTEL_LSP",
  "LAZY_INTEL_EMBEDDING",
];
const savedEnvironment = Object.fromEntries(ENVIRONMENT.map((name) => [name, process.env[name]]));
const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-engine-"));
process.env.LAZY_INTEL_ROOT = root;
process.env.LAZY_INTEL_ALLOWED_ROOTS = root;
process.env.LAZY_INTEL_AUTO_INDEX = "false";
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";
process.env.LAZY_INTEL_LSP = "";

const { codeIntel } = await import("../src/engine.js");
const { closeIndexManager } = await import("../src/index-manager.js");
const { closeUnified } = await import("../src/unified.js");

await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
await writeFile(path.join(root, "discount.mjs"), "// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
await writeFile(path.join(root, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
await writeFile(path.join(root, "duplicate-a.mjs"), "export function duplicate() { return 'a'; }\n");
await writeFile(path.join(root, "duplicate-b.mjs"), "export function duplicate() { return 'b'; }\n");

const restoreEnvironment = () => {
  for (const name of ENVIRONMENT) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
};

after(async () => {
  await closeUnified();
  closeIndexManager();
  restoreEnvironment();
  await rm(root, { recursive: true, force: true });
});

const request = (operation, args = {}, signal) => codeIntel({
  operation,
  root,
  indexTimeoutMs: 600_000,
  timeoutMs: 120_000,
  ...args,
}, signal);

// A read no longer builds a view that was never published: a cold workspace
// answers "building" at once rather than blocking past its request budget.
// Publish once with strict freshness so these tests exercise serving.
await request("search", { query: "warm the published view", freshness: "strict", limit: 1 });
await request("architecture", { query: "warm the published graph view", freshness: "strict" });

const inspect = (label, result) => {
  assert.equal(typeof result.metaText, "string", `${label}: metaText must be a string`);
  const parsed = JSON.parse(result.metaText);
  assert.equal(parsed.status, result.meta.status, `${label}: metaText status mismatch`);
  assert.equal(parsed.stopReason, result.meta.stopReason, `${label}: metaText stopReason mismatch`);
  return parsed;
};

test("codeIntel serves unified retrieval and graph evidence with bounded output", { timeout: 900_000, concurrency: false }, async () => {
  const search = await request("search", {
    query: "percentage discount invoice cents",
    includeBody: true,
    limit: 20,
    maxChars: 8_000,
  });
  inspect("unified search", search);
  assert.ok(search.text.length + search.metaText.length <= 8_000, "maxChars must cap the whole response");
  assert.equal(search.meta.fulfillment.requiredMet, true);
  assert.ok(["ok", "empty"].includes(search.meta.status));
  assert.ok(search.meta.backends.some((row) => row.backend === "zvec"));
  if (search.meta.status === "ok") {
    assert.ok(search.meta.evidence.length > 0, "an ok retrieval read must carry evidence");
    assert.ok(search.meta.evidence.some((descriptor) => descriptor.method === "hybrid_retrieval" && descriptor.locator?.relativePath));
  }

  const architecture = await request("architecture", { query: "invoice call flow", maxChars: 8_000 });
  inspect("unified architecture", architecture);
  assert.equal(architecture.meta.routes[0], "codegraph:architecture");
  assert.ok(architecture.meta.backends.some((row) => row.backend === "codegraph"));
  if (architecture.meta.status === "ok") {
    assert.ok(architecture.meta.evidence.some((descriptor) => descriptor.method === "indexed_graph"));
  }
});

test("unified engine preserves valid empty, required-obligation failure, and ambiguity gating", { timeout: 900_000, concurrency: false }, async () => {
  const empty = await request("architecture", { query: "symbolThatDoesNotExist", maxChars: 8_000 });
  inspect("valid empty architecture", empty);
  assert.equal(empty.isError, false);
  assert.equal(empty.meta.status, "empty");
  assert.equal(empty.meta.stopReason, "no_matches");
  assert.equal(empty.meta.fulfillment.requiredMet, true);
  assert.deepEqual(empty.meta.evidence, []);

  const requiredFailure = await request("references", {
    symbol: "applyDiscount",
    relativePath: "discount.mjs",
    maxChars: 8_000,
  });
  inspect("required semantic failure", requiredFailure);
  assert.equal(requiredFailure.isError, true);
  assert.equal(requiredFailure.meta.fulfillment.requiredMet, false);
  assert.ok(requiredFailure.meta.fulfillment.unmet.includes("references_of_subject"));
  const semantic = requiredFailure.meta.backends.find((row) => row.backend === "serena");
  assert.equal(semantic?.outcome, "unavailable");
  assert.match(semantic?.warning ?? "", /language server|configured|never downloads/i);

  const ambiguous = await request("context", { query: "duplicate", maxChars: 8_000 });
  inspect("ambiguous context", ambiguous);
  assert.equal(ambiguous.meta.stopReason, "ambiguous_subject");
  assert.equal(ambiguous.meta.routes.join(","), "codegraph:context,zvec:search,serena:symbol");
  assert.equal(ambiguous.meta.backends.some((row) => row.backend === "serena"), false, "ambiguity must gate semantic follow-up");
});

test("aborting a unified request reports the owned worker cancellation cause", { timeout: 900_000, concurrency: false }, async () => {
  const controller = new AbortController();
  const pending = request("search", {
    query: "percentage discount invoice cents",
    includeBody: true,
    limit: 100,
    maxChars: 80_000,
  }, controller.signal);
  setTimeout(() => controller.abort(), 10).unref();
  await assert.rejects(pending, (error) => error?.code === "cancelled" && /aborted while the read was in flight|aborted during worker startup/.test(error.message));
});
