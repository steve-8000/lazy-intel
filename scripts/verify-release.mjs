#!/usr/bin/env node
// Unified release evidence gate. Every PASS below is produced by an executed
// command or a direct filesystem/runtime observation; planned work is never a PASS.
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
const gates = [];
async function exec(command, args, options = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(command, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options });
    return { code: 0, stdout, stderr, ms: Date.now() - started };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), ms: Date.now() - started };
  }
}
function record(id, title, required, status, detail, evidence = {}) { gates.push({ id, title, required, status, detail, ...evidence }); }
async function supportedNode() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const range = pkg.engines?.node ?? "";
  const [major, minor] = process.versions.node.split(".").map(Number);
  const minimum = />=\s*(\d+)(?:\.(\d+))?/.exec(range);
  const min = Number(minimum?.[1] ?? 0);
  const minMinor = Number(minimum?.[2] ?? 0);
  const max = Number(/<\s*(\d+)/.exec(range)?.[1] ?? Number.POSITIVE_INFINITY);
  return { range, running: process.version, executable: process.execPath, inRange: (major > min || major === min && minor >= minMinor) && major < max };
}
async function gateVendorIntegrity() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/verify-vendor.mjs"), "--json"]);
  let parsed; try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (result.code !== 0 || !parsed) { record("vendor-integrity", "Vendored trees match their UPSTREAM.json ledgers", true, "FAIL", result.stderr || result.stdout); return; }
  record("vendor-integrity", "Vendored trees match their UPSTREAM.json ledgers", true, "PASS", parsed.vendors.map((v) => `${v.vendor}@${v.commit.slice(0, 12)} ${v.verbatim}/${v.files} verbatim, ${v.patched.length} declared patches`).join("; "), { vendors: parsed.vendors });
}
async function gatePinAgreement() {
  const lock = JSON.parse(await readFile(path.join(ROOT, "upstreams.lock.json"), "utf8"));
  const mismatches = [];
  const pins = {};
  for (const [name, entry] of Object.entries(lock.upstreams)) {
    const ledgerPath = path.join(ROOT, entry.ledger);
    if (!existsSync(ledgerPath)) { mismatches.push(`${name}: ${entry.ledger} is missing`); continue; }
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    pins[name] = { lock: entry.commit, ledger: ledger.upstream.commit, patchRevision: ledger.patch_revision ?? 0 };
    if (ledger.upstream.commit !== entry.commit) mismatches.push(`${name}: lock says ${entry.commit}, ledger says ${ledger.upstream.commit}`);
  }
  record("pin-agreement", "upstreams.lock.json agrees with every vendor ledger", true, mismatches.length ? "FAIL" : "PASS", mismatches.length ? mismatches.join("; ") : JSON.stringify(pins), { pins });
}
async function gateBuild() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/build-unified.mjs"), "--clean", "--json"]);
  let parsed; try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  record("build", "Build reproduces every target from source", true, result.code === 0 ? "PASS" : "FAIL", parsed ? parsed.targets.map((t) => `${t.target}:${t.status}`).join(" ") : (result.stderr || result.stdout).slice(0, 2000), parsed ? { targets: parsed.targets } : {});
}
async function gateTests() {
  const result = await exec("npm", ["test", "--silent"], { timeout: 600_000 });
  const counts = Object.fromEntries([...(result.stdout + result.stderr).matchAll(/^# (tests|pass|fail|skipped)\s+(\d+)$/gm)].map(m => [m[1], Number(m[2])]));
  const scenarios = [...result.stdout.matchAll(/^(ok|not ok) (\d+) - (.*)$/gm)].map(m => ({ name: m[3], status: m[1] === "ok" ? (m[3].includes("# SKIP") ? "skipped" : "pass") : "fail" }));
  const passed = result.code === 0 && counts.tests > 0 && counts.fail === 0 && counts.pass + counts.skipped === counts.tests;
  await writeFile(path.join(ROOT, "docs/unified/test-evidence.json"), JSON.stringify({ generated_at: new Date().toISOString(), command: "npm test --silent", node: process.version, exit_code: result.code, status: passed ? "PASS" : "FAIL", counts, scenarios, output_sha256: createHash("sha256").update(result.stdout + result.stderr).digest("hex") }, null, 2) + "\n");
  record("tests", "The full applicable test suite passes", true, passed ? "PASS" : "FAIL", JSON.stringify(counts), { counts, artifact: "docs/unified/test-evidence.json" });
}
async function gateUnifiedQuery() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-release-"));
  try {
    await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(workspace, "discount.mjs"), "export function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
    await writeFile(path.join(workspace, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
    const probe = `const {codeIntel}=await import(${JSON.stringify(path.join(ROOT, "src/engine.js"))}); const {closeIndexManager}=await import(${JSON.stringify(path.join(ROOT, "src/index-manager.js"))}); const {closeUnified}=await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))}); const started=Date.now(); try { const result=await codeIntel({operation:"search",root:${JSON.stringify(workspace)},query:"percentage discount invoice cents",limit:10,maxChars:8000,timeoutMs:120000,indexTimeoutMs:600000}); process.stdout.write("RESULT:"+JSON.stringify({status:result.meta.status,isError:result.isError,backends:result.meta.backends,anchored:result.meta.evidence.filter((e)=>e.anchor?.span?.coordinateSystem === "utf8-bytes" && e.sourceCheck === "matched").length,queryMs:Date.now()-started})+"\\n"); } finally { closeIndexManager(); await closeUnified(); }`;
    const result = await exec(process.execPath, ["--input-type=module", "-e", probe], { timeout: 900_000, env: { ...process.env, LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0", HF_HUB_OFFLINE: "1", CODEGRAPH_NO_DOWNLOAD: "1" } });
    const line = result.stdout.split("\n").find(entry => entry.startsWith("RESULT:"));
    if (!line) { record("unified-query", "Unified engine answers a real query end to end", true, "FAIL", (result.stderr || result.stdout || "no output").slice(0, 2000)); return; }
    const payload = JSON.parse(line.slice(7));
    record("unified-query", "Unified engine answers a real query end to end", true, result.code === 0 && payload.isError === false && payload.anchored > 0 ? "PASS" : "FAIL", JSON.stringify(payload), { measurement: payload });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
async function gateUnifiedDefault() {
  const probe = `const {ENGINE_MODE}=await import(${JSON.stringify(path.join(ROOT, "src/unified.js"))}); process.stdout.write("MODE:"+ENGINE_MODE+"\\n");`;
  const unset = await exec(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, LAZY_INTEL_ENGINE: "" } });
  const explicit = await exec(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, LAZY_INTEL_ENGINE: "unified" } });
  const unsetMode = /MODE:(\w+)/.exec(unset.stdout)?.[1]; const explicitMode = /MODE:(\w+)/.exec(explicit.stdout)?.[1];
  record("unified-default", "Unified engine is the only/default engine mode", true, unsetMode === "unified" && explicitMode === "unified" ? "PASS" : "FAIL", `unset=${unsetMode} explicit=${explicitMode}`);
}
async function gateNoQueryTimeInstall() {
  const result = await exec(process.execPath, ["--test", "test/contracts/headless-entries.test.js"]);
  record("no-query-time-install", "Fork entries cannot reach installer/updater modules", true, result.code === 0 ? "PASS" : "FAIL", result.code === 0 ? "headless-entries contract passed" : (result.stdout || result.stderr).slice(0, 2000));
}
async function gateParserConvergence() {
  const matrix = JSON.parse(await readFile(path.join(ROOT, "docs/unified/parser-convergence.json"), "utf8"));
  const claimed = Object.entries(matrix.languages ?? {}).filter(([, value]) => value.converged === true);
  record("parser-convergence", "Shared captured bytes are not mislabeled as single parsing", true, claimed.length === 0 ? "PASS" : "FAIL", "Separate worker parsers retained; JS/TS/Python snapshot parity does not establish single-parse convergence.", { artifact: "docs/unified/parser-convergence.json", singleParseClaims: claimed.map(([name]) => name) });
}
async function gateSemantic() {
  const result = await exec(process.execPath, ["scripts/verify-semantic.mjs", "--write"], { timeout: 300_000 });
  const report = JSON.parse(await readFile(path.join(ROOT, "docs/unified/semantic-evidence.json"), "utf8"));
  record("semantic", "Actual trusted language servers preserve semantic observations and public evidence", true, result.code === 0 && report.status === "PASS" ? "PASS" : "FAIL", report.status, { artifact: "docs/unified/semantic-evidence.json" });
}
async function gateBackendParity() {
  const result = await exec(process.execPath, ["scripts/verify-backend-parity.mjs"], { timeout: 300_000 });
  const report = JSON.parse(await readFile(path.join(ROOT, "docs/unified/backend-parity.json"), "utf8"));
  record("backend-parity", "Stock and public MCP arms retain source-backed anchors with identical configured input", true, result.code === 0 && report.criteria?.["REL-02"]?.status === "PASS" ? "PASS" : "FAIL", report.status, { artifact: "docs/unified/backend-parity.json" });
}
async function gateDependencyClosure() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/verify-dependencies.mjs"), "--write", "docs/unified/dependency-audit.json"]);
  let report; try { report = JSON.parse(result.stdout); } catch {}
  const required = ["DEP-NODE-RUNTIME", "DEP-PYTHON", "DEP-ASSET-NOTICES", "DEP-MODEL"];
  const passed = result.code === 0 && report?.schema_version === 3 && required.every(id => report.findings?.some(finding => finding.id === id && finding.status === "PASS")) && report.python_installed_closure?.missing_license_files?.length === 0;
  record("dependency-closure", "Actual runtime Node/Python/native/grammar/model notices are retained", true, passed ? "PASS" : "FAIL", report ? `runtimeNode=${report.node_closure?.runtime?.package_count} python=${report.python_installed_closure?.packages?.length}` : (result.stderr || result.stdout).slice(0, 1500), { findings: report?.findings, artifact: "docs/unified/dependency-audit.json" });
}
async function gateNetworkIsolation() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/verify-offline.mjs"), "--write", "docs/unified/offline-evidence.json"], { timeout: 900_000 });
  let report; try { report = JSON.parse(result.stdout); } catch {}
  const status = result.code === 0 && report?.status === "PASS" ? "PASS" : report?.status === "BLOCKED_ENVIRONMENT" ? "BLOCKED_ENVIRONMENT" : "FAIL";
  record("build06-network", "Native Node/Python/LSP offline execution has working positive controls", true, status, report ? `positive=${report.positiveControl?.status} runtime=${report.runtime?.status}` : (result.stderr || result.stdout).slice(0, 2000), { artifact: "docs/unified/offline-evidence.json" });
}
async function gateInstallUpgrade() {
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/verify-install.mjs"), "--write=docs/unified/install-evidence.json"], { timeout: 300_000 });
  let report; try { report = JSON.parse(result.stdout); } catch {}
  record("rel03-install-upgrade", "Actual MCP install, upgrade, abort, multi-root and old binary/state rollback", true, result.code === 0 && report?.status === "PASS" ? "PASS" : "FAIL", report?.status ?? (result.stderr || result.stdout).slice(0, 2000), { artifact: "docs/unified/install-evidence.json" });
}
async function gatePerformanceHarness() {
  const preregBytes = await readFile(path.join(ROOT, "docs/unified/performance-preregistration.json"));
  const prereg = JSON.parse(preregBytes);
  const report = JSON.parse(await readFile(path.join(ROOT, "docs/unified/performance-measurement.json"), "utf8"));
  const rows = report.samples ?? [];
  const matrix = prereg.matrix.every(({ mode, samples }) => rows.filter(row => row.mode === mode).length === samples);
  const measured = matrix && rows.length === 20 && report.corpus?.sha256 === prereg.corpus.sha256 && rows.every(row => Number.isFinite(row.elapsedMs) && row.peakProcessTreeRssBytes > 0 && row.processTree?.length && row.rssSamples?.length);
  const thresholdIdentity = JSON.stringify(report.preregistered_thresholds) === JSON.stringify(prereg.preregistered_thresholds);
  const quality = measured && rows.every(row => row.querySuccess && row.anchored && row.quality?.allExact) && rows.filter(row => row.mode === "dirty").every(row => row.dirtyHashChanged) && Object.entries(report.checks ?? {}).filter(([name]) => name.startsWith("quality_") || name === "dirty_new_hash_evidence").every(([, check]) => check.pass === true);
  record("rel04-measurements", "Cold/restart/warm/dirty each retain five latency and owned process-tree RSS observations", true, measured && thresholdIdentity ? "PASS" : "FAIL", `${rows.length} rows; immutable corpus and thresholds=${thresholdIdentity}`, { artifact: "docs/unified/performance-measurement.json", summary: report.summary });
  record("rel05-quality", "Preregistered critical source SHA/spans and dirty revisions survive real requests", true, quality && thresholdIdentity ? "PASS" : "FAIL", `exact anchored rows=${rows.filter(row => row.anchored).length}/${rows.length}`, { checks: Object.fromEntries(Object.entries(report.checks ?? {}).filter(([name]) => name.startsWith("quality_") || name === "dirty_new_hash_evidence")) });
  const performance = Object.entries(report.checks ?? {}).filter(([name]) => name.endsWith("_p95_ms") || name === "process_tree_rss_p95_bytes");
  record("performance-guardrails", "Preregistered latency and RSS guardrails remain unchanged", true, measured && thresholdIdentity && performance.length === 5 && performance.every(([, check]) => check.pass) ? "PASS" : "FAIL", "Measurement completion and quality do not turn an exceeded RSS guardrail into PASS.", { checks: Object.fromEntries(performance), preregistrationSha256: createHash("sha256").update(preregBytes).digest("hex") });
}
async function gateSourceInventory() {
  const report = JSON.parse(await readFile(path.join(ROOT, "docs/unified/source-review-evidence.json"), "utf8"));
  const valid = report.status === "PASS" && report.edited_inventory.every(entry => entry.read_line_count === entry.source_line_count && Date.parse(entry.read_at) < Date.parse(entry.first_successful_edit_at));
  record("src04-inventory", "Edited inventory source has chronological full-read evidence", true, valid ? "PASS" : "FAIL", `${report.inventory_count} inventory-grade paths; ${report.edited_inventory.length} edited after full read`, { artifact: "docs/unified/source-review-evidence.json" });
}
async function gateAcceptanceLinkage() {
  const baselineBytes = await readFile(path.join(ROOT, "docs/unified/acceptance.json"));
  const baseline = JSON.parse(baselineBytes);
  const current = JSON.parse(await readFile(path.join(ROOT, "docs/unified/acceptance-evidence.json"), "utf8"));
  const rows = current.items ?? [];
  const invalid = baseline.items.filter(item => {
    const row = rows.find(candidate => candidate.id === item.id);
    return !row || row.expected !== item.expected || row.name !== item.name || row.owner_unit !== item.owner_unit || !row.evidence?.length || row.evidence.some(e => !existsSync(path.join(ROOT, e.path)));
  }).map(item => item.id);
  const identity = baseline.items.length === 68 && rows.length === 68 && new Set(rows.map(row => row.id)).size === 68 && current.baseline_sha256 === createHash("sha256").update(baselineBytes).digest("hex");
  record("acceptance-linkage", "Original 68 IDs and expected contracts remain individually linked", true, identity && !invalid.length ? "PASS" : "FAIL", `68 original criteria; invalid links=${invalid.join(",") || "none"}`, { acceptanceItems: rows.length, invalid, artifact: "docs/unified/acceptance-evidence.json" });
  const unmet = rows.filter(row => row.status !== "met").map(row => ({ id: row.id, status: row.status, result: row.result }));
  record("original-acceptance", "Every original criterion retains its own explicit verdict", true, identity && !invalid.length && !unmet.length ? "PASS" : "FAIL", unmet.length ? `${unmet.length} criteria are not met` : "68/68 individual criteria met; separate release guardrails still apply", { unmet });
}
async function main(argv) {
  const json = argv.includes("--json");
  const writeIndex = argv.indexOf("--write");
  const writePath = writeIndex < 0 ? null : argv[writeIndex + 1];
  if (writeIndex >= 0 && !writePath) throw new Error("--write needs a path");
  const node = await supportedNode();
  record("runtime", "Gates run on the declared Node runtime", true, node.inRange ? "PASS" : "FAIL", `engines.node=${node.range} running=${node.running} executable=${node.executable}`);
  await gatePinAgreement(); await gateVendorIntegrity(); await gateDependencyClosure(); await gateBuild(); await gateNoQueryTimeInstall(); await gateTests(); await gateUnifiedQuery(); await gateUnifiedDefault(); await gateParserConvergence(); await gateSemantic(); await gateBackendParity(); await gateNetworkIsolation(); await gateInstallUpgrade(); await gatePerformanceHarness(); await gateSourceInventory(); await gateAcceptanceLinkage();
  const requiredFailures = gates.filter((gate) => gate.required && gate.status !== "PASS");
  const report = { schema_version: 2, unit: "U09", generated_at: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, node: process.version, executable: process.execPath }, status: requiredFailures.length ? "FAIL" : "PASS", required_failures: requiredFailures.map((gate) => gate.id), blocked: gates.filter((gate) => gate.status === "BLOCKED_ENVIRONMENT").map((gate) => gate.id), gates };
  report.evidence_producers = { acceptance_items: gates.find((gate) => gate.id === "acceptance-linkage")?.acceptanceItems ?? 0, linkage_gate: "acceptance-linkage", score_aggregation: "prohibited" };
  report.digest = createHash("sha256").update(JSON.stringify(report.gates)).digest("hex");
  if (writePath) { const target = path.resolve(ROOT, writePath); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + "\n"); }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n"); else { for (const gate of gates) process.stdout.write(`${gate.status === "PASS" ? "ok  " : gate.status === "BLOCKED_ENVIRONMENT" ? "skip" : gate.status === "PREPARED" || gate.status === "PARTIAL" ? "info" : "FAIL"} ${gate.id}${gate.required ? "" : " (optional)"}: ${gate.title}\n     ${gate.detail}\n`); process.stdout.write(`verify-release: ${report.status}\n`); }
  return requiredFailures.length ? 1 : 0;
}
try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`verify-release: ${error.stack ?? error.message}\n`); process.exitCode = 2; }
