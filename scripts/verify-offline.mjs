#!/usr/bin/env node
/*
 * Build06 offline proof. The only network policy used here is scoped to the
 * verifier-owned child process tree: a temporary DYLD interposer plus the
 * Darwin sandbox's deny-network profile. No resolver, firewall, or model
 * configuration is changed. A PASS requires native boot and attempt evidence;
 * process-tree RSS or a JavaScript monkeypatch is never accepted as coverage.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERPOSER_SOURCE = path.join(ROOT, "scripts/native/offline_interposer.c");
const DEFAULT_REPORT = path.join(ROOT, "docs/unified/offline-evidence.json");
const PYRIGHT = process.env.LAZY_INTEL_TEST_PYRIGHT || "/opt/homebrew/bin/pyright-langserver";

async function run(command, args, options = {}) {
  try {
    const result = await runFile(command, args, {
      cwd: ROOT,
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env: options.env,
    });
    return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, signal: error.signal ?? null, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.stack || error) };
  }
}

function child(command, args, options) {
  return new Promise((resolve) => {
    const processChild = spawn(command, args, { cwd: ROOT, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    processChild.stdout.on("data", (chunk) => { stdout += chunk; });
    processChild.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => processChild.kill("SIGTERM"), options.timeout ?? 600_000);
    processChild.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ pid: processChild.pid, code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function parseLines(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function querySummary(result) {
  if (!result || typeof result !== "object") return { present: false };
  return {
    present: true,
    isError: result.isError,
    status: result.meta?.status,
    stopReason: result.meta?.stopReason,
    routes: result.meta?.routes,
    backends: result.meta?.backends,
    evidence: result.meta?.evidence,
    issues: result.meta?.issues,
  };
}

function backendOk(result, backend) {
  const row = result?.meta?.backends?.find((entry) => entry.backend === backend);
  return Boolean(row && (row.outcome === "ok" || row.outcome === "empty"));
}

async function compileInterposer(scratch) {
  const library = path.join(scratch, "offline-interposer.dylib");
  const result = await run("clang", ["-dynamiclib", "-fPIC", "-O2", "-Wall", "-Wextra", "-o", library, INTERPOSER_SOURCE], { timeout: 60_000 });
  return { library, result, compiled: result.code === 0 && existsSync(library), command: ["clang", "-dynamiclib", "-fPIC", "-O2", "-Wall", "-Wextra", "-o", library, INTERPOSER_SOURCE] };
}

function guardedEnv(library, events) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return {
    ...env,
    DYLD_INSERT_LIBRARIES: library,
    DYLD_FORCE_FLAT_NAMESPACE: "1",
    LAZY_INTEL_OFFLINE_EVENTS: events,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    CODEGRAPH_NO_DOWNLOAD: "1",
    LAZY_INTEL_OFFLINE: "1",
  };
}

async function positiveControl(library, scratch) {
  const events = path.join(scratch, "positive-events.jsonl");
  const probe = [
    "import net from 'node:net';",
    "const socket = net.createConnection({ host: '127.0.0.1', port: 9, lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) });",
    "let blocked = false;",
    "await new Promise((resolve) => { socket.once('error', () => { blocked = true; resolve(); }); socket.once('connect', resolve); setTimeout(() => { blocked ||= socket.destroyed; resolve(); }, 1500); });",
    "socket.destroy();",
    "process.stdout.write('POSITIVE_RESULT:' + JSON.stringify({ pid: process.pid, blocked }) + '\\n');",
  ].join("\n");
  const result = await child(process.execPath, ["--input-type=module", "-e", probe], { env: guardedEnv(library, events), timeout: 10_000 });
  const eventsRaw = existsSync(events) ? await readFile(events, "utf8") : "";
  const attempts = parseLines(eventsRaw).filter((entry) => entry.kind === "attempt");
  const positiveLine = result.stdout.split('\n').find((entry) => entry.startsWith('POSITIVE_RESULT:'));
  let positiveResult = null; try { positiveResult = positiveLine ? JSON.parse(positiveLine.slice('POSITIVE_RESULT:'.length)) : null; } catch {}
  const blocked = attempts.length > 0 && attempts.every((entry) => entry.blocked === true);
  const nativeAttempt = attempts.some((entry) => entry.operation === "connect" || entry.operation.includes("connect") || entry.operation === "sendto" || entry.operation === "getaddrinfo");
  const sandboxBlocked = positiveResult?.blocked === true;
  return { status: blocked && nativeAttempt && result.code === 0 ? "PASS" : result.code === 0 ? "BLOCKED_ENVIRONMENT" : "FAIL", child: { pid: result.pid, code: result.code, signal: result.signal }, sandboxBlocked, attempts, rawEvents: eventsRaw.trim().split("\n").filter(Boolean), stdout: result.stdout, stderr: result.stderr };
}

async function nativeControl(library, scratch) {
  const source = path.join(scratch, "native-control.c");
  const binary = path.join(scratch, "native-control");
  const events = path.join(scratch, "native-control-events.jsonl");
  await writeFile(source, '#include <arpa/inet.h>\n#include <netdb.h>\n#include <sys/socket.h>\nint main(void){ int s=socket(AF_INET,SOCK_STREAM,0); struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9)}; inet_pton(AF_INET,"127.0.0.1",&a.sin_addr); (void)connect(s,(struct sockaddr*)&a,sizeof(a)); const char byte=0; (void)sendto(s,&byte,1,0,(struct sockaddr*)&a,sizeof(a)); struct addrinfo *out=0; (void)getaddrinfo("localhost","9",0,&out); return 0; }\n');
  const compile = await run("clang", ["-O2", "-o", binary, source], { timeout: 30_000 });
  if (compile.code !== 0) return { status: "FAIL", compile };
  const result = await child(binary, [], { env: guardedEnv(library, events), timeout: 10_000 });
  const raw = existsSync(events) ? await readFile(events, "utf8") : "";
  const attempts = parseLines(raw).filter((entry) => entry.kind === "attempt");
  const operations = [...new Set(attempts.map((entry) => entry.operation))];
  const status = result.code === 0 && attempts.length > 0 && attempts.every((entry) => entry.blocked === true) && operations.some((entry) => entry.includes("connect")) && operations.includes("getaddrinfo") && operations.includes("sendto") ? "PASS" : "BLOCKED_ENVIRONMENT";
  return { status, child: { pid: result.pid, code: result.code, signal: result.signal }, attempts, operations, rawEvents: raw.trim().split("\n").filter(Boolean), stdout: result.stdout, stderr: result.stderr };
}

async function sandboxControl() {
  const profile = "(version 1) (allow default) (deny network-outbound) (deny network-inbound)";
  const probe = [
    "import net from 'node:net';",
    "const socket = net.createConnection({ host: '127.0.0.1', port: 9, lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) });",
    "let blocked = false;",
    "await new Promise((resolve) => { socket.once('error', () => { blocked = true; resolve(); }); socket.once('connect', resolve); setTimeout(() => { blocked ||= socket.destroyed; resolve(); }, 1500); });",
    "socket.destroy(); process.stdout.write('SANDBOX_RESULT:' + JSON.stringify({ blocked }) + '\\n');",
  ].join("\n");
  const result = await child("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--input-type=module", "-e", probe], { env: { ...process.env }, timeout: 10_000 });
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("SANDBOX_RESULT:"));
  let parsed = null; try { parsed = line ? JSON.parse(line.slice("SANDBOX_RESULT:".length)) : null; } catch {}
  return { status: result.code === 0 && parsed?.blocked === true ? "PASS" : "BLOCKED_ENVIRONMENT", child: { pid: result.pid, code: result.code, signal: result.signal }, blocked: parsed?.blocked === true, stdout: result.stdout, stderr: result.stderr };
}

function queryProbe(root, events) {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import { codeIntel } from " + JSON.stringify(path.join(ROOT, "src/engine.js")) + ";",
    "import { closeIndexManager } from " + JSON.stringify(path.join(ROOT, "src/index-manager.js")) + ";",
    "import { closeUnified } from " + JSON.stringify(path.join(ROOT, "src/unified.js")) + ";",
    "const root = " + JSON.stringify(root) + ";",
    "const phaseFile = " + JSON.stringify(events.replace(/events\.jsonl$/, "phases.jsonl")) + ";",
    "const phase = (name) => appendFileSync(phaseFile, JSON.stringify({ name, pid: process.pid, timeMs: Date.now() }) + '\\n');",
    "const outcomes = {}; let shutdown = []; let failure = null;",
    "try {",
    "  phase('retrieval');",
    "  outcomes.search = await codeIntel({ operation: 'search', root, query: 'percentage discount invoice cents', limit: 10, maxChars: 8000, timeoutMs: 120000, indexTimeoutMs: 300000 });",
    "  phase('graph');",
    "  outcomes.graph = await codeIntel({ operation: 'architecture', root, query: 'start', symbol: 'start', relativePath: 'flow.mjs', limit: 10, maxChars: 8000, timeoutMs: 120000, indexTimeoutMs: 300000 });",
    "  phase('semantic');",
    "  outcomes.symbol = await codeIntel({ operation: 'symbol', root, symbol: 'apply_discount', relativePath: 'discount.py', timeoutMs: 120000, indexTimeoutMs: 300000 });",
    "  outcomes.references = await codeIntel({ operation: 'references', root, symbol: 'apply_discount', relativePath: 'discount.py', timeoutMs: 120000, indexTimeoutMs: 300000 });",
    "} catch (error) { failure = { message: error instanceof Error ? error.message : String(error), stack: error?.stack }; }",
    "try { closeIndexManager(); shutdown.push('closeIndexManager'); } catch (error) { shutdown.push({ closeIndexManager: String(error) }); }",
    "try { await closeUnified(); shutdown.push('closeUnified'); } catch (error) { shutdown.push({ closeUnified: String(error) }); }",
    "process.stdout.write('OFFLINE_RESULT:' + JSON.stringify({ outcomes: Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, { isError: value.isError, meta: value.meta }])), failure, shutdown, pid: process.pid }) + '\\n');",
  ].join("\n");
}

async function runtimeProof(library, scratch) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-offline-workspace-"));
  const events = path.join(scratch, "runtime-events.jsonl");
  const phases = path.join(scratch, "runtime-phases.jsonl");
  await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(workspace, "discount.mjs"), "export function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
  await writeFile(path.join(workspace, "invoice.mjs"), "import { applyDiscount } from './discount.mjs'; export function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");
  await writeFile(path.join(workspace, "flow.mjs"), "export function start() { return middle(); } export function middle() { return finish(); } export function finish() { return 1; }\n");
  await writeFile(path.join(workspace, "discount.py"), "def apply_discount(cents, percent):\n    return round(cents * (100 - percent) / 100)\n");
  await writeFile(path.join(workspace, "invoice.py"), "from discount import apply_discount\n\ndef invoice_total(cents, percent):\n    return apply_discount(cents, percent)\n");
  const env = { ...guardedEnv(library, events), LAZY_INTEL_ENGINE: "unified", LAZY_INTEL_ROOT: workspace, LAZY_INTEL_ALLOWED_ROOTS: workspace, LAZY_INTEL_AUTO_INDEX: "false", LAZY_INTEL_MAINTENANCE_MS: "0", LAZY_INTEL_LSP: JSON.stringify({ python: PYRIGHT }) };
  const result = await child(process.execPath, ["--input-type=module", "-e", queryProbe(workspace, events)], { env, timeout: 600_000 });
  const rawEvents = existsSync(events) ? await readFile(events, "utf8") : "";
  const rawPhases = existsSync(phases) ? await readFile(phases, "utf8") : "";
  const eventsParsed = parseLines(rawEvents);
  const boots = eventsParsed.filter((entry) => entry.kind === "boot");
  const attempts = eventsParsed.filter((entry) => entry.kind === "attempt");
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("OFFLINE_RESULT:"));
  let parsed = null;
  try { parsed = line ? JSON.parse(line.slice("OFFLINE_RESULT:".length)) : null; } catch { parsed = null; }
  const queryOutcomes = Object.fromEntries(Object.entries(parsed?.outcomes ?? {}).map(([key, value]) => [key, querySummary(value)]));
  const querySuccess = Boolean(parsed && !parsed.failure && backendOk(parsed.outcomes.search, "zvec") && backendOk(parsed.outcomes.graph, "codegraph") && backendOk(parsed.outcomes.symbol, "serena") && backendOk(parsed.outcomes.references, "serena"));
  const semanticBoot = boots.some((entry) => entry.pid !== result.pid && /node|pyright/i.test(entry.executable ?? ""));
  const childBoots = boots.filter((entry) => entry.pid !== result.pid);
  const nodeChildBoots = childBoots.filter((entry) => /node/i.test(entry.executable ?? ""));
  const pythonLspBoots = childBoots.filter((entry) => /python/i.test(entry.executable ?? ""));
  const coverage = { queryPid: result.pid, bootCount: boots.length, bootPids: boots.map((entry) => entry.pid), ownedChildBootCount: childBoots.length, nodeChildBootPids: nodeChildBoots.map((entry) => entry.pid), pythonLspChildPids: pythonLspBoots.map((entry) => entry.pid), retrievalAndGraphChildBoots: nodeChildBoots.length >= 2, semanticLspChildBoot: pythonLspBoots.length > 0, noObservationIsPass: false };
  const shutdownOrder = parsed?.shutdown ?? [];
  const shutdownCorrect = shutdownOrder[0] === "closeIndexManager" && shutdownOrder[1] === "closeUnified";
  await rm(workspace, { recursive: true, force: true });
  return { workspace, status: querySuccess && result.code === 0 && attempts.length === 0 && coverage.retrievalAndGraphChildBoots && coverage.semanticLspChildBoot && shutdownCorrect ? "PASS" : result.code === 0 ? "BLOCKED_ENVIRONMENT" : "FAIL", child: { pid: result.pid, code: result.code, signal: result.signal }, queryOutcomes, queryFailure: parsed?.failure ?? null, shutdownOrder, shutdownCorrect, rawEvents: rawEvents.trim().split("\n").filter(Boolean), rawPhases: rawPhases.trim().split("\n").filter(Boolean), boots, attempts, coverage };
}

function topStatus(prereq, positive, native, sandbox, runtime) {
  if (!prereq.platform || !prereq.clang || !prereq.pyright || !prereq.built) return "BLOCKED_ENVIRONMENT";
  if (positive.status === "FAIL" || native.status === "FAIL" || sandbox.status === "FAIL" || runtime.status === "FAIL") return "FAIL";
  if (positive.status !== "PASS" || native.status !== "PASS" || sandbox.status !== "PASS" || runtime.status !== "PASS") return "BLOCKED_ENVIRONMENT";
  return "PASS";
}

async function main(argv) {
  const reportPath = argv[argv.indexOf("--write") >= 0 ? argv.indexOf("--write") + 1 : -1] || DEFAULT_REPORT;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-offline-proof-"));
  const prereq = { platform: process.platform === "darwin", clang: false, pyright: existsSync(PYRIGHT), built: existsSync(path.join(ROOT, "packages/core/dist/index.js")) && existsSync(path.join(ROOT, "vendor/zvec-grep/dist/lazy-entry.js")) };
  let positive = { status: "BLOCKED_ENVIRONMENT", attempts: [], reason: "interposer was not compiled" };
  let native = { status: "BLOCKED_ENVIRONMENT", attempts: [], reason: "interposer was not compiled" };
  let sandbox = { status: "BLOCKED_ENVIRONMENT", reason: "sandbox-exec unavailable" };
  let runtime = { status: "BLOCKED_ENVIRONMENT", attempts: [], reason: "interposer was not compiled" };
  let compile = null;
  let report = null;
  try {
    const clang = await run("clang", ["--version"], { timeout: 10_000 });
    prereq.clang = clang.code === 0;
    if (prereq.platform && prereq.clang) {
      compile = await compileInterposer(scratch);
      if (compile.compiled) {
        positive = await positiveControl(compile.library, scratch);
        native = await nativeControl(compile.library, scratch);
        sandbox = await sandboxControl();
        if (positive.status !== "FAIL" && native.status === "PASS" && prereq.built && prereq.pyright) runtime = await runtimeProof(compile.library, scratch);
        else runtime = { status: "BLOCKED_ENVIRONMENT", reason: "positive control or build prerequisite unavailable" };
      }
    }
  } finally {
    await mkdir(path.dirname(reportPath), { recursive: true });
    report = {
      schemaVersion: "lazy-intel.offline-evidence.v1",
      status: topStatus(prereq, positive, native, sandbox, runtime),
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      scope: { processTreeOnly: true, machineGlobalMutation: false, modelDownloads: false, policy: "temporary DYLD_INSERT_LIBRARIES scoped to verifier-owned process tree", hooks: ["socket", "socket$NOCANCEL", "connect", "connect$NOCANCEL", "sendto", "getaddrinfo"], source: "scripts/native/offline_interposer.c" },
      prerequisites: { ...prereq, pyrightPath: PYRIGHT, buildRequired: "npm run build (does not download or change models)" },
      compile,
      positiveControl: positive,
      nativeControl: native,
      sandboxControl: sandbox,
      runtime,
      limitations: runtime.status !== "PASS" ? ["A missing native attempt observation is not treated as PASS; inspect raw boot/attempt records and the scoped Darwin interposer limitation."] : [],
      cleanup: { scratchRemoved: true, scratchPath: scratch, ownedTemporaryAssets: [compile?.library].filter(Boolean) },
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await rm(scratch, { recursive: true, force: true });
    process.stdout.write(JSON.stringify(report) + "\n");
  }
  return report.status === "PASS" ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
