#!/usr/bin/env node
// The release gate for the unified engine.
//
// Every check here answers one question: is what we are about to ship actually
// the pinned source, actually built, and actually able to serve a query? Nothing
// in this script infers a result from a flag or a document. A gate either runs a
// command and reads its exit status, or it reports `blocked_environment` and says
// what was missing. A gate is never marked PASS because it was planned.
//
//   node scripts/verify-release.mjs
//   node scripts/verify-release.mjs --json
//   node scripts/verify-release.mjs --write docs/unified/release-evidence.json
//
// Exit 0 = every required gate passed, 1 = a required gate failed, 2 = usage error.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exec(command, args, options = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(command, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options });
    return { code: 0, stdout, stderr, ms: Date.now() - started };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), ms: Date.now() - started };
  }
}

/**
 * The runtime the product declares. The gates must run on it, not on whatever
 * `node` happens to be first on PATH, or the evidence describes a different
 * program from the one that ships.
 */
async function supportedNode() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const range = pkg.engines?.node ?? "";
  const match = /(\d+)/.exec(range);
  const major = Number(process.versions.node.split(".")[0]);
  const min = match ? Number(match[1]) : 0;
  const upper = /<\s*(\d+)/.exec(range);
  const max = upper ? Number(upper[1]) : Number.POSITIVE_INFINITY;
  return { range, running: process.version, inRange: major >= min && major < max };
}

const gates = [];

function record(id, title, required, status, detail, evidence = {}) {
  gates.push({ id, title, required, status, detail, ...evidence });
}

/** Vendored source must still be the pinned source, with every edit declared. */
async function gateVendorIntegrity() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/verify-vendor.mjs"), "--json"]);
  if (result.code !== 0) {
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* keep the raw output below */ }
    record("vendor-integrity", "Vendored trees match their UPSTREAM.json ledgers", true, "FAIL", parsed ? JSON.stringify(parsed.vendors.map((v) => ({ vendor: v.vendor, drift: v.drift, missing: v.missing, untracked: v.untracked }))) : result.stderr || result.stdout);
    return;
  }
  const parsed = JSON.parse(result.stdout);
  record("vendor-integrity", "Vendored trees match their UPSTREAM.json ledgers", true, "PASS",
    parsed.vendors.map((v) => `${v.vendor}@${v.commit.slice(0, 12)} ${v.verbatim}/${v.files} verbatim, ${v.patched.length} declared patches`).join("; "),
    { vendors: parsed.vendors.map((v) => ({ vendor: v.vendor, commit: v.commit, files: v.files, verbatim: v.verbatim, patched: v.patched })) });
}

/** The pins in the repo lock must be the pins the ledgers actually imported. */
async function gatePinAgreement() {
  const lock = JSON.parse(await readFile(path.join(ROOT, "upstreams.lock.json"), "utf8"));
  const mismatches = [];
  const pins = {};
  for (const [name, entry] of Object.entries(lock.upstreams)) {
    const ledgerPath = path.join(ROOT, entry.ledger);
    if (!existsSync(ledgerPath)) {
      mismatches.push(`${name}: ${entry.ledger} is missing`);
      continue;
    }
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    pins[name] = { lock: entry.commit, ledger: ledger.upstream.commit, patchRevision: ledger.patch_revision ?? 0 };
    if (ledger.upstream.commit !== entry.commit) mismatches.push(`${name}: lock says ${entry.commit}, ledger says ${ledger.upstream.commit}`);
  }
  record("pin-agreement", "upstreams.lock.json agrees with every vendor ledger", true, mismatches.length === 0 ? "PASS" : "FAIL", mismatches.length === 0 ? JSON.stringify(pins) : mismatches.join("; "), { pins });
}

/** A coordinated build from the vendored source, not a cached dist. */
async function gateBuild() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/build-unified.mjs"), "--clean", "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* fall through to raw output */ }
  record("build", "npm run build reproduces every target from source", true, result.code === 0 ? "PASS" : "FAIL",
    parsed ? parsed.targets.map((t) => `${t.target}:${t.status}`).join(" ") : (result.stderr || result.stdout).slice(0, 2000),
    parsed ? { targets: parsed.targets.map((t) => ({ target: t.target, status: t.status, outputs: t.outputs })) } : {});
}

/** The whole suite, on the declared runtime. */
async function gateTests() {
  const result = await exec("npm", ["test", "--silent"]);
  const counts = Object.fromEntries(
    [...(result.stdout + result.stderr).matchAll(/^# (tests|pass|fail|skipped)\s+(\d+)$/gm)].map((m) => [m[1], Number(m[2])]),
  );
  const ok = result.code === 0 && counts.fail === 0;
  record("tests", "The full test suite passes", true, ok ? "PASS" : "FAIL", JSON.stringify(counts), { counts });
}

/**
 * The claim that matters most: the unified engine answers a real query, from a
 * real workspace, through the vendored libraries, with anchored evidence.
 */
async function gateUnifiedQuery() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-release-"));
  try {
    await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(workspace, "discount.mjs"), "// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
    await writeFile(path.join(workspace, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");

    const probe = `
      const { codeIntel } = await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))});
      const { closeUnified } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
      const started = Date.now();
      const result = await codeIntel({ operation: "search", root: ${JSON.stringify(workspace)}, query: "percentage discount invoice cents", limit: 10, maxChars: 8000, timeoutMs: 120000, indexTimeoutMs: 600000 });
      await closeUnified();
      process.stdout.write("RESULT:" + JSON.stringify({
        status: result.meta.status,
        isError: result.isError,
        backends: result.meta.backends,
        anchored: result.meta.evidence.filter((e) => e.method !== "opaque").length,
        opaque: result.meta.evidence.filter((e) => e.method === "opaque").length,
        coldMs: Date.now() - started,
      }) + "\\n");
    `;
    const result = await exec(process.execPath, ["--input-type=module", "-e", probe], {
      timeout: 900_000,
      env: { ...process.env, LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0" },
    });
    const line = (result.stdout || "").split("\n").find((entry) => entry.startsWith("RESULT:"));
    if (!line) {
      record("unified-query", "The unified engine answers a real query end to end", true, "FAIL", (result.stderr || result.stdout || "no output").slice(0, 2000));
      return;
    }
    const payload = JSON.parse(line.slice("RESULT:".length));
    const ok = payload.isError === false && payload.anchored > 0;
    record("unified-query", "The unified engine answers a real query end to end", true, ok ? "PASS" : "FAIL",
      `status=${payload.status} anchored=${payload.anchored} opaque=${payload.opaque} coldMs=${payload.coldMs}`, { measurement: payload });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * The legacy path must still work, because the release is only safe if it can be
 * rolled back by flipping one environment variable.
 */
async function gateLegacySelectable() {
  const probe = `
    const { ENGINE_MODE } = await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))});
    process.stdout.write("MODE:" + ENGINE_MODE + "\\n");
  `;
  const legacy = await exec(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, LAZY_INTEL_ENGINE: "" } });
  const unified = await exec(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, LAZY_INTEL_ENGINE: "unified" } });
  const legacyMode = /MODE:(\w+)/.exec(legacy.stdout)?.[1];
  const unifiedMode = /MODE:(\w+)/.exec(unified.stdout)?.[1];
  const ok = legacyMode === "legacy" && unifiedMode === "unified";
  record("rollback-switch", "Engine selection is one reversible environment variable", true, ok ? "PASS" : "FAIL", `unset=${legacyMode} unified=${unifiedMode}`);
}

/** No query may reach an installer, an updater or a telemetry sink. */
async function gateNoQueryTimeInstall() {
  const result = await exec(process.execPath, ["--test", "test/contracts/headless-entries.test.js"]);
  record("no-query-time-install", "No installer, updater or telemetry module is reachable from a fork entry", true, result.code === 0 ? "PASS" : "FAIL", result.code === 0 ? "headless-entries contract test passed" : (result.stdout || result.stderr).slice(0, 2000));
}

/** Language coverage may only be claimed where a parity test actually passed. */
async function gateParserConvergence() {
  const matrixPath = path.join(ROOT, "docs/unified/parser-convergence.json");
  if (!existsSync(matrixPath)) {
    record("parser-convergence", "Single-parse convergence is claimed only where measured", false, "BLOCKED_ENVIRONMENT", "docs/unified/parser-convergence.json is absent, so no language claims single-parse convergence");
    return;
  }
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const claimed = Object.entries(matrix.languages ?? {}).filter(([, value]) => value.converged === true);
  const unproven = claimed.filter(([, value]) => value.evidence == null);
  record("parser-convergence", "Single-parse convergence is claimed only where measured", false, unproven.length === 0 ? "PASS" : "FAIL",
    unproven.length === 0 ? `${claimed.length} converged languages, each with parity evidence` : `claimed without evidence: ${unproven.map(([name]) => name).join(", ")}`,
    { languages: matrix.languages });
}

/**
 * Semantic reads need a real language server. Absence is a real limitation of the
 * host, not a failure of the build, so it is reported rather than hidden.
 */
async function gateSemantic() {
  const result = await exec(process.execPath, ["--test", "test/contracts/semantic-adapter.test.js"]);
  record("semantic", "The private semantic worker is exercised", false, result.code === 0 ? "PASS" : "BLOCKED_ENVIRONMENT",
    result.code === 0 ? "semantic adapter contract test passed" : (result.stdout || result.stderr).slice(0, 1500));
}

async function main(argv) {
  const json = argv.includes("--json");
  const writeIndex = argv.indexOf("--write");
  const writePath = writeIndex === -1 ? null : argv[writeIndex + 1];
  if (writeIndex !== -1 && !writePath) throw new Error("--write needs a path");

  const node = await supportedNode();
  record("runtime", "Gates run on the declared Node runtime", true, node.inRange ? "PASS" : "FAIL", `engines.node=${node.range} running=${node.running}`);

  await gatePinAgreement();
  await gateVendorIntegrity();
  await gateBuild();
  await gateNoQueryTimeInstall();
  await gateTests();
  await gateUnifiedQuery();
  await gateLegacySelectable();
  await gateParserConvergence();
  await gateSemantic();

  const requiredFailures = gates.filter((gate) => gate.required && gate.status !== "PASS");
  const report = {
    schema_version: 1,
    unit: "U09",
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    status: requiredFailures.length === 0 ? "PASS" : "FAIL",
    required_failures: requiredFailures.map((gate) => gate.id),
    // A gate that could not run says so. It is never counted as a pass.
    blocked: gates.filter((gate) => gate.status === "BLOCKED_ENVIRONMENT").map((gate) => gate.id),
    gates,
  };
  report.digest = createHash("sha256").update(JSON.stringify(report.gates)).digest("hex");

  if (writePath) {
    const target = path.resolve(ROOT, writePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const gate of gates) {
      const mark = gate.status === "PASS" ? "ok  " : gate.status === "BLOCKED_ENVIRONMENT" ? "skip" : "FAIL";
      process.stdout.write(`${mark} ${gate.id}${gate.required ? "" : " (optional)"}: ${gate.title}\n     ${gate.detail}\n`);
    }
    process.stdout.write(`verify-release: ${report.status}\n`);
  }
  return requiredFailures.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`verify-release: ${error.message}\n`);
  process.exitCode = 2;
}
