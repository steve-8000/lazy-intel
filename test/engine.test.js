import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const ENVIRONMENT = [
  "LAZY_INTEL_ROOT",
  "LAZY_INTEL_ALLOWED_ROOTS",
  "LAZY_INTEL_AUTO_INDEX",
  "LAZY_INTEL_MAINTENANCE_MS",
  "LAZY_INTEL_CODEGRAPH_BIN",
];
const savedEnvironment = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-engine-"));
process.env.LAZY_INTEL_ROOT = root;
process.env.LAZY_INTEL_ALLOWED_ROOTS = "";
process.env.LAZY_INTEL_AUTO_INDEX = "false";
process.env.LAZY_INTEL_MAINTENANCE_MS = "0";

const { run } = await import("../src/lib/process.js");
const { codeIntel } = await import("../src/engine.js");
const { closeIndexManager } = await import("../src/index-manager.js");
const { closeSerena } = await import("../src/backends/serena.js");
const { RequestCancelledError } = await import("../src/lib/deadline.js");

await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
await writeFile(path.join(root, "jsconfig.json"), JSON.stringify({
  compilerOptions: { allowJs: true, checkJs: false, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext" },
  include: ["*.mjs"],
}));
await writeFile(path.join(root, ".gitignore"), ".zvec-grep/\n.codegraph/\n.serena/\n");
await run("git", ["init", "--quiet", root]);
await writeFile(path.join(root, "discount.mjs"), "// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
await writeFile(path.join(root, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");

const restoreEnvironment = () => {
  for (const name of ENVIRONMENT) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
};

after(async () => {
  closeSerena();
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

const observed = [];
const inspect = (label, result) => {
  assert.equal(typeof result.metaText, "string", `${label}: metaText must be a string`);
  const parsed = JSON.parse(result.metaText);
  assert.equal(parsed.status, result.meta.status, `${label}: metaText status mismatch`);
  assert.equal(parsed.stopReason, result.meta.stopReason, `${label}: metaText stopReason mismatch`);
  observed.push({ label, status: result.meta.status, stopReason: result.meta.stopReason });
  return parsed;
};

test("codeIntel emits the v0.3 result contract over real backends", { timeout: 900_000 }, async () => {
  const budget = await request("search", {
    query: "percentage discount invoice cents",
    includeBody: true,
    limit: 20,
    maxChars: 4_000,
  });
  inspect("budgeted search", budget);
  assert.ok(budget.text.length + budget.metaText.length <= 4_000, "maxChars must cap the whole response");
  assert.equal(budget.isError, false);

  // zvec is hybrid: the vector leg always returns nearest neighbours, so a nonsense
  // phrase over a non-empty index cannot produce the `No matches.` sentinel and the
  // engine cannot report `empty` here. Verified against the pinned zg 0.2.1 CLI.
  // The reachable `empty` contract is pinned on the captured fixture in
  // test/backends.test.js; `empty` over a live index becomes possible in U03, where the
  // typed library exposes diagnostics.emptyReason instead of formatted prose.
  const nonsense = await request("search", {
    query: "qzvno-match-phrase-7e3f2a9b",
    maxChars: 4_000,
  });
  inspect("nonsense-phrase search", nonsense);
  assert.equal(nonsense.isError, false);
  assert.equal(nonsense.meta.status, "ok");
  assert.equal(nonsense.meta.stopReason, "plan_complete");
  // Retrieval prose stays opaque: no locator may be invented from formatted CLI text.
  assert.ok(nonsense.meta.evidence.length > 0, "the hybrid backend must still return evidence");
  assert.ok(
    nonsense.meta.evidence.every((descriptor) => descriptor.method === "opaque"),
    "zvec CLI prose must never be promoted to a typed locator",
  );

  const references = await request("references", {
    symbol: "applyDiscount",
    relativePath: "discount.mjs",
  });
  inspect("explicit references", references);
  assert.deepEqual(references.meta.routes, ["serena:references"]);
  // meta.routes is `backend:operation`; the legacy backend rows carry the backend only.
  assert.ok(references.meta.backends.every(({ backend }) =>
    references.meta.routes.some((route) => route.startsWith(`${backend}:`))));

  const context = await request("context", { query: "applyDiscount" });
  inspect("context", context);
  assert.deepEqual(context.meta.routes, ["codegraph:context", "zvec:search", "serena:symbol"]);
  assert.ok([
    "plan_complete",
    "no_matches",
    "ambiguous_subject",
    "subject_unresolved",
    "required_backend_failed",
    "budget_exhausted",
    "concurrent_change_observed",
  ].includes(context.meta.stopReason));

  const failingCodegraph = path.join(root, "codegraph-fails.mjs");
  await writeFile(failingCodegraph, "process.exitCode = 23;\n");
  await chmod(failingCodegraph, 0o755);
  const previousCodegraph = process.env.LAZY_INTEL_CODEGRAPH_BIN;
  process.env.LAZY_INTEL_CODEGRAPH_BIN = failingCodegraph;
  let failure;
  try {
    failure = await request("impact", { symbol: "symbolThatDoesNotExist" });
  } finally {
    if (previousCodegraph === undefined) delete process.env.LAZY_INTEL_CODEGRAPH_BIN;
    else process.env.LAZY_INTEL_CODEGRAPH_BIN = previousCodegraph;
  }
  inspect("required-backend failure", failure);
  assert.equal(failure.isError, true);
  assert.equal(failure.meta.fulfillment.requiredMet, false);
  assert.ok(failure.meta.fulfillment.unmet.length > 0);

  const controller = new AbortController();
  const pending = request("search", {
    query: "percentage discount invoice cents",
    includeBody: true,
    limit: 100,
    maxChars: 80_000,
  }, controller.signal);
  const cancellation = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, 10);
    pending.then(
      () => reject(new Error("request completed before cancellation")),
      () => { clearTimeout(timer); resolve(); },
    );
  });
  await cancellation;
  await assert.rejects(pending, error => error instanceof RequestCancelledError && error.code === "CANCELLED");

  console.log(JSON.stringify(observed));
});
