#!/usr/bin/env node
/**
 * Release performance harness. The preregistered corpus and thresholds are
 * constants here; this runner only writes the measured artifact.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const runFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLES = 5;
const REQUEST_TIMEOUT_MS = 130_000;
const RSS_INTERVAL_MS = 50;
const MAX_RSS_SAMPLES = 256;
const MODES = ["cold", "restart", "warm", "dirty"];
const ANCHOR_NAMES = ["applyDiscount", "invoiceTotal"];

const CORPUS = [
  ["package.json", "{\"type\":\"module\",\"name\":\"release-corpus\"}\n"],
  ["src/discount.mjs", "export function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n"],
  ["src/invoice.mjs", "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n"],
  ["README.md", "The anchored task corpus contains a discount calculation and its caller.\n"],
];

// These are preregistered guardrails, not measured candidate scores.
const THRESHOLDS = {
  cold_p95_ms: { operator: "<=", value: 30000 },
  restart_p95_ms: { operator: "<=", value: 30000 },
  warm_p95_ms: { operator: "<=", value: 10000 },
  dirty_p95_ms: { operator: "<=", value: 30000 },
  process_tree_rss_p95_bytes: { operator: "<=", value: 2_000_000_000 },
  quality_min_anchored_results: { operator: ">=", value: 1 },
  quality_required_anchor: { operator: "contains", value: "applyDiscount" },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values, p) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const rank = (p / 100) * (finite.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return finite[lower];
  return finite[lower] + (finite[upper] - finite[lower]) * (rank - lower);
}

function corpusHash() {
  return sha256(CORPUS.map(([name, body]) => `${name}\0${body}`).join("\0"));
}

async function prepareCorpus() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-perf-corpus-"));
  for (const [relative, body] of CORPUS) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return dir;
}

async function preparePerfWorkspace() {
  const corpus = await prepareCorpus();
  // The runtime's actual state root is workspace/.lazy-intel. There is no
  // LAZY_INTEL_STATE_ROOT override, so restart reuses this directory exactly.
  return { corpus, stateRoot: path.join(corpus, ".lazy-intel") };
}

function parsePs(stdout) {
  return stdout.trim().split("\n").filter(Boolean).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4] }];
  });
}

async function processTreeRss(pid) {
  try {
    const { stdout } = await runFile("ps", ["-axo", "pid=,ppid=,rss=,command="], { maxBuffer: 4 * 1024 * 1024 });
    const processes = parsePs(stdout);
    const byParent = new Map();
    for (const row of processes) {
      const children = byParent.get(row.ppid) ?? [];
      children.push(row);
      byParent.set(row.ppid, children);
    }
    const selected = [];
    const pending = [Number(pid)];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const row = processes.find((candidate) => candidate.pid === current);
      if (row) selected.push(row);
      for (const child of byParent.get(current) ?? []) pending.push(child.pid);
    }
    return { totalBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0), processes: selected };
  } catch {
    return { totalBytes: 0, processes: [] };
  }
}

function startProcessTreeSampler(pid) {
  const peak = {
    rssBytes: 0,
    processes: [],
    samples: [],
    samplerErrors: [],
  };
  let active = true;
  let running = false;

  const take = async () => {
    if (!active || running) return;
    running = true;
    try {
      const snapshot = await processTreeRss(pid);
      if (snapshot.totalBytes > peak.rssBytes) {
        peak.rssBytes = snapshot.totalBytes;
        peak.processes = snapshot.processes;
      }
      if (peak.samples.length < MAX_RSS_SAMPLES) {
        peak.samples.push({
          rssBytes: snapshot.totalBytes,
          processes: snapshot.processes,
        });
      }
    } catch (error) {
      if (peak.samplerErrors.length < 8) peak.samplerErrors.push(String(error?.message ?? error));
    } finally {
      running = false;
    }
  };

  void take();
  const timer = setInterval(() => void take(), RSS_INTERVAL_MS);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await take();
      active = false;
      return peak;
    },
  };
}

function workerEnvironment(corpus) {
  return {
    ...process.env,
    LAZY_INTEL_ROOT: corpus,
    LAZY_INTEL_ALLOWED_ROOTS: corpus,
    LAZY_INTEL_ENGINE: "unified",
    LAZY_INTEL_AUTO_INDEX: "false",
    LAZY_INTEL_OFFLINE: "1",
    LAZY_INTEL_PERFORMANCE_PROFILE: "release",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    CODEGRAPH_NO_DOWNLOAD: "1",
  };
}

async function createWorker(corpus) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-perf-worker-"));
  const file = path.join(dir, "worker.mjs");
  const engine = path.join(ROOT, "src/engine.js");
  const indexManager = path.join(ROOT, "src/index-manager.js");
  const unified = path.join(ROOT, "src/unified.js");
  const source = `
import readline from "node:readline";
import { codeIntel } from ${JSON.stringify(engine)};
import { closeIndexManager } from ${JSON.stringify(indexManager)};
import { closeUnified } from ${JSON.stringify(unified)};

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Watchers must stop before unified runtimes close, otherwise a late event
  // can reopen work while the process is being measured and shut down.
  closeIndexManager();
  await closeUnified();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown(); });
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim() || closing) continue;
  const request = JSON.parse(line);
  if (request.shutdown) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, shutdown: true }) + "\\n");
    await shutdown();
    break;
  }
  try {
    const result = await codeIntel(request.input);
    process.stdout.write(JSON.stringify({ id: request.id, ok: !result.isError, result }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: String(error?.stack || error) }) + "\\n");
  }
}
`;
  await writeFile(file, source);
  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    env: workerEnvironment(corpus),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const worker = { child, dir, pending: new Map(), stderr: "", stdoutErrors: [] };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        const resolve = worker.pending.get(value.id);
        if (resolve) {
          worker.pending.delete(value.id);
          resolve(value);
        }
      } catch (error) {
        if (worker.stdoutErrors.length < 8) worker.stdoutErrors.push(String(error?.message ?? error));
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    worker.stderr += chunk;
    if (worker.stderr.length > 32_000) worker.stderr = worker.stderr.slice(-32_000);
  });
  return worker;
}

function workerRequest(worker, id, input, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.pending.delete(id);
      worker.child.removeListener("exit", onExit);
      callback(value);
    };
    const onExit = (code, signal) => finish(reject, new Error(`performance worker exited id=${id} code=${code} signal=${signal} stderr=${worker.stderr.slice(-2000)}`));
    const timer = setTimeout(() => {
      finish(reject, new Error(`performance worker request timeout id=${id} stderr=${worker.stderr.slice(-2000)}`));
    }, timeoutMs);
    worker.child.once("exit", onExit);
    worker.pending.set(id, (value) => finish(resolve, value));
    try {
      worker.child.stdin.write(JSON.stringify({ id, input }) + "\n");
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function closeWorker(worker) {
  if (!worker) return;
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    const id = `shutdown-${Date.now()}-${Math.random()}`;
    try {
      await workerRequest(worker, id, { shutdown: true }, 30_000);
    } catch {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
    }
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
          resolve();
        }, 5_000);
        worker.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  for (const reject of worker.pending.values()) reject(new Error("performance worker closed"));
  worker.pending.clear();
  await rm(worker.dir, { recursive: true, force: true });
}

function perfInput(root, freshness = "auto") {
  return {
    operation: "search",
    root,
    query: "applyDiscount invoiceTotal",
    limit: 10,
    maxChars: 8000,
    timeoutMs: 120000,
    indexTimeoutMs: 120000,
    freshness,
  };
}

function nowNs() {
  return process.hrtime.bigint();
}

async function exactAnchorQuality(response, root, expectedHashes) {
  const evidence = response?.result?.meta?.evidence;
  const matches = [];
  if (!Array.isArray(evidence)) return { anchoredResultCount: 0, matches, applyDiscount: [], invoiceTotal: [], allExact: false };
  for (const item of evidence) {
    const anchor = item?.anchor;
    const span = anchor?.span;
    const relativePath = anchor?.relativePath;
    if (!relativePath || span?.coordinateSystem !== "utf8-bytes" || !Number.isInteger(span.startByte) || !Number.isInteger(span.endByte)) continue;
    const expectedHash = expectedHashes[relativePath];
    if (!expectedHash || span.startByte < 0 || span.endByte <= span.startByte) continue;
    let bytes;
    try {
      bytes = await readFile(path.join(root, relativePath));
    } catch {
      continue;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash || anchor.contentHash !== actualHash) continue;
    if (span.endByte > bytes.length) continue;
    const slice = bytes.subarray(span.startByte, span.endByte);
    const text = slice.toString("utf8");
    const textBytesMatch = item.textKind !== "source" || item.text == null || Buffer.from(item.text, "utf8").equals(slice);
    const sourceCheckMatch = item.sourceCheck === "matched" || (item.sourceCheck?.status === "matched" && item.sourceCheck.sha256 === actualHash);
    const entry = {
      id: item.id,
      relativePath,
      contentHash: actualHash,
      span: { coordinateSystem: span.coordinateSystem, startByte: span.startByte, endByte: span.endByte },
      byteLength: slice.length,
      text: item.text,
      spanText: text,
      textBytesMatch,
      sourceCheckMatch,
    };
    matches.push(entry);
  }
  const applyDiscount = matches.filter((entry) => entry.spanText.includes("applyDiscount"));
  const invoiceTotal = matches.filter((entry) => entry.spanText.includes("invoiceTotal"));
  return {
    anchoredResultCount: matches.length,
    matches,
    applyDiscount,
    invoiceTotal,
    allExact: applyDiscount.length > 0 && invoiceTotal.length > 0
      && [...applyDiscount, ...invoiceTotal].every((entry) => entry.textBytesMatch && entry.sourceCheckMatch),
  };
}

async function measureRequest({ mode, index, worker, root, startedAt, startupMs = 0, expectedHashes, oldDiscountHash, newDiscountHash, freshness = "auto" }) {
  const sampler = startProcessTreeSampler(worker.child.pid);
  let response;
  let error;
  try {
    response = await workerRequest(worker, `${mode}-${index}`, perfInput(root, freshness));
  } catch (caught) {
    error = String(caught?.stack || caught);
  }
  const peak = await sampler.stop();
  const elapsedMs = Number(nowNs() - startedAt) / 1e6;
  let quality;
  try {
    quality = await exactAnchorQuality(response, root, expectedHashes);
  } catch (caught) {
    quality = { anchoredResultCount: 0, matches: [], applyDiscount: [], invoiceTotal: [], allExact: false, error: String(caught?.stack || caught) };
  }
  const actualDiscountHash = quality.matches.find((entry) => entry.relativePath === "src/discount.mjs")?.contentHash ?? null;
  return {
    mode,
    index,
    elapsedMs,
    startupMs,
    startupIncluded: mode === "cold" || mode === "restart",
    peakProcessTreeRssBytes: peak.rssBytes,
    processTree: peak.processes,
    rssSamples: peak.samples,
    rssSamplerErrors: peak.samplerErrors,
    exitCode: response?.ok === true ? 0 : 1,
    querySuccess: response?.ok === true,
    anchored: quality.allExact,
    quality,
    expectedDiscountHash: newDiscountHash ?? oldDiscountHash ?? null,
    previousDiscountHash: oldDiscountHash ?? null,
    actualDiscountHash,
    dirtyHashChanged: mode === "dirty" ? Boolean(oldDiscountHash && newDiscountHash && oldDiscountHash !== newDiscountHash && actualDiscountHash === newDiscountHash) : null,
    response,
    ...(error ? { error } : {}),
  };
}

async function cleanupWorkspace(workspace) {
  if (!workspace) return;
  await rm(workspace.corpus, { recursive: true, force: true });
}

async function coldSample(index) {
  const workspace = await preparePerfWorkspace();
  let worker;
  const startedAt = nowNs();
  try {
    worker = await createWorker(workspace.corpus);
    const startupMs = Number(nowNs() - startedAt) / 1e6;
    const hashes = Object.fromEntries(CORPUS.map(([name, body]) => [name, sha256(Buffer.from(body))]));
    return await measureRequest({ mode: "cold", index, worker, root: workspace.corpus, startedAt, startupMs, expectedHashes: hashes, oldDiscountHash: hashes["src/discount.mjs"] });
  } catch (error) {
    return {
      mode: "cold", index, elapsedMs: Number(nowNs() - startedAt) / 1e6, startupMs: null, startupIncluded: true,
      peakProcessTreeRssBytes: 0, processTree: [], rssSamples: [], rssSamplerErrors: [], exitCode: 1,
      querySuccess: false, anchored: false, quality: { anchoredResultCount: 0, matches: [], applyDiscount: [], invoiceTotal: [], allExact: false },
      response: null, error: String(error?.stack || error),
    };
  } finally {
    await closeWorker(worker);
    await cleanupWorkspace(workspace);
  }
}

async function measureWorkerMode(mode, samples) {
  if (mode === "cold") {
    const rows = [];
    for (let index = 0; index < samples; index++) rows.push(await coldSample(index));
    return rows;
  }

  const workspace = await preparePerfWorkspace();
  let worker;
  const rows = [];
  const hashes = Object.fromEntries(CORPUS.map(([name, body]) => [name, sha256(Buffer.from(body))]));
  try {
    worker = await createWorker(workspace.corpus);
    const primeResponse = await workerRequest(worker, `${mode}-prime`, perfInput(workspace.corpus, "strict"));
    const primeQuality = await exactAnchorQuality(primeResponse, workspace.corpus, hashes);
    if (primeResponse?.ok !== true) {
      for (let index = 0; index < samples; index++) rows.push({
        mode, index, elapsedMs: null, startupMs: mode === "restart" ? null : 0, startupIncluded: mode === "restart",
        peakProcessTreeRssBytes: 0, processTree: [], rssSamples: [], rssSamplerErrors: [], exitCode: 1,
        querySuccess: false, anchored: false, quality: primeQuality, response: primeResponse,
        error: `${mode} prime query failed`,
      });
      return rows;
    }

    if (mode === "restart") {
      await closeWorker(worker);
      worker = null;
      for (let index = 0; index < samples; index++) {
        const startedAt = nowNs();
        try {
          worker = await createWorker(workspace.corpus);
          const startupMs = Number(nowNs() - startedAt) / 1e6;
          rows.push(await measureRequest({ mode, index, worker, root: workspace.corpus, startedAt, startupMs, expectedHashes: hashes, oldDiscountHash: hashes["src/discount.mjs"] }));
        } catch (error) {
          rows.push({ mode, index, elapsedMs: Number(nowNs() - startedAt) / 1e6, startupMs: null, startupIncluded: true, peakProcessTreeRssBytes: 0, processTree: [], rssSamples: [], rssSamplerErrors: [], exitCode: 1, querySuccess: false, anchored: false, quality: { anchoredResultCount: 0, matches: [], applyDiscount: [], invoiceTotal: [], allExact: false }, response: null, error: String(error?.stack || error) });
        } finally {
          await closeWorker(worker);
          worker = null;
        }
      }
      return rows;
    }

    for (let index = 0; index < samples; index++) {
      let expectedHashes = hashes;
      let newDiscountHash = null;
      if (mode === "dirty") {
        const body = `export function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100) + ${index}; }\n`;
        await writeFile(path.join(workspace.corpus, "src/discount.mjs"), body);
        newDiscountHash = sha256(Buffer.from(body));
        expectedHashes = { ...hashes, "src/discount.mjs": newDiscountHash };
      }
      const startedAt = nowNs();
      try {
        rows.push(await measureRequest({ mode, index, worker, root: workspace.corpus, startedAt, expectedHashes, oldDiscountHash: hashes["src/discount.mjs"], newDiscountHash, freshness: mode === "dirty" ? "strict" : "auto" }));
      } catch (error) {
        rows.push({ mode, index, elapsedMs: Number(nowNs() - startedAt) / 1e6, startupMs: 0, startupIncluded: false, peakProcessTreeRssBytes: 0, processTree: [], rssSamples: [], rssSamplerErrors: [], exitCode: 1, querySuccess: false, anchored: false, quality: { anchoredResultCount: 0, matches: [], applyDiscount: [], invoiceTotal: [], allExact: false }, response: null, error: String(error?.stack || error) });
      }
    }
    return rows;
  } finally {
    await closeWorker(worker);
    await cleanupWorkspace(workspace);
  }
}

function summaryForMode(mode, rows) {
  const elapsed = rows.map((row) => row.elapsedMs);
  const startup = rows.map((row) => row.startupMs);
  const rss = rows.map((row) => row.peakProcessTreeRssBytes);
  const anchored = rows.map((row) => row.quality?.anchoredResultCount ?? 0);
  return {
    mode,
    n: rows.length,
    elapsedMsP95: percentile(elapsed, 95),
    startupMsP95: percentile(startup, 95),
    processTreeRssBytesP95: percentile(rss, 95),
    querySuccessCount: rows.filter((row) => row.querySuccess).length,
    exactAnchorCount: rows.filter((row) => row.anchored).length,
    minAnchoredResults: anchored.length ? Math.min(...anchored) : 0,
    dirtyHashEvidenceCount: mode === "dirty" ? rows.filter((row) => row.dirtyHashChanged).length : null,
    failures: rows.filter((row) => row.error || !row.querySuccess).map((row) => ({ index: row.index, error: row.error ?? "query returned ok=false", response: row.response })),
  };
}

async function runWorkerMeasurements(samples) {
  const rows = [];
  const failures = [];
  for (const mode of MODES) {
    try {
      rows.push(...await measureWorkerMode(mode, samples));
    } catch (error) {
      failures.push({ mode, error: String(error?.stack || error) });
    }
  }
  return {
    samples: rows,
    corpus: { files: CORPUS.map(([name]) => name), sha256: corpusHash() },
    worker_protocol: "newline JSON request/response; candidate src/engine.js codeIntel; persistent worker per warm/dirty; graceful closeIndexManager then closeUnified",
    ...(failures.length ? { failures } : {}),
  };
}

function reportPrepared() {
  return {
    schema_version: 2,
    status: "PREPARED",
    generated_at: new Date().toISOString(),
    corpus: { files: CORPUS.map(([name]) => name), sha256: corpusHash(), source: "scripts/verify-performance.mjs" },
    preregistered_thresholds: THRESHOLDS,
    matrix: MODES.map((mode) => ({
      mode,
      samples: DEFAULT_SAMPLES,
      lifecycle: mode === "cold" ? "new workspace/state + startup" : mode === "restart" ? "existing indexed state + new runtime + startup" : mode === "warm" ? "persistent runtime + repeated requests" : "persistent runtime + source mutation + strict refresh + refreshed evidence",
      latency: "raw elapsedMs",
      startup: mode === "cold" || mode === "restart" ? "included in elapsedMs; startupMs reported" : "excluded after prime",
      memory: "aggregate process-tree RSS from bounded ps sampler",
    })),
    measurement_policy: {
      no_model_downloads: true,
      no_network_configuration_mutation: true,
      candidate_must_be_supplied: true,
      baseline_retained: true,
      quality_thresholds_are_not_derived_from_candidate: true,
      quality_anchors: ANCHOR_NAMES,
      state_root: "workspace/.lazy-intel (runtime default; no LAZY_INTEL_STATE_ROOT override)",
      per_request_deadline_ms: 120000,
    },
    immutable_preregistration: true,
  };
}

function thresholdCheck(name, measured, threshold, pass) {
  return { measured, threshold, pass };
}

function buildChecks(summaries, rows) {
  const checks = {};
  for (const mode of MODES) {
    checks[`${mode}_p95_ms`] = thresholdCheck(`${mode}_p95_ms`, summaries[mode].elapsedMsP95, THRESHOLDS[`${mode}_p95_ms`], summaries[mode].elapsedMsP95 !== null && summaries[mode].elapsedMsP95 <= THRESHOLDS[`${mode}_p95_ms`].value);
  }
  const rssValues = rows.map((row) => row.peakProcessTreeRssBytes).filter((value) => Number.isFinite(value));
  const rssP95 = percentile(rssValues, 95);
  checks.process_tree_rss_p95_bytes = thresholdCheck("process_tree_rss_p95_bytes", rssP95, THRESHOLDS.process_tree_rss_p95_bytes, rssP95 !== null && rssP95 <= THRESHOLDS.process_tree_rss_p95_bytes.value);
  const minAnchoredResults = rows.length ? Math.min(...rows.map((row) => row.quality?.anchoredResultCount ?? 0)) : 0;
  checks.quality_min_anchored_results = thresholdCheck("quality_min_anchored_results", minAnchoredResults, THRESHOLDS.quality_min_anchored_results, minAnchoredResults >= THRESHOLDS.quality_min_anchored_results.value);
  const requiredAnchorRows = rows.filter((row) => row.quality?.applyDiscount?.length > 0).length;
  checks.quality_required_anchor = thresholdCheck("quality_required_anchor", { anchor: "applyDiscount", rows: requiredAnchorRows, totalRows: rows.length }, THRESHOLDS.quality_required_anchor, rows.length === DEFAULT_SAMPLES * MODES.length && requiredAnchorRows === rows.length);
  const bothAnchorRows = rows.filter((row) => row.quality?.applyDiscount?.length > 0 && row.quality?.invoiceTotal?.length > 0).length;
  checks.quality_both_anchors = { measured: { rows: bothAnchorRows, totalRows: rows.length }, pass: rows.length === DEFAULT_SAMPLES * MODES.length && bothAnchorRows === rows.length, anchors: ANCHOR_NAMES };
  const dirtyRows = rows.filter((row) => row.mode === "dirty");
  checks.dirty_new_hash_evidence = { measured: { rows: dirtyRows.filter((row) => row.dirtyHashChanged).length, totalRows: dirtyRows.length }, pass: dirtyRows.length === DEFAULT_SAMPLES && dirtyRows.every((row) => row.dirtyHashChanged === true) };
  return checks;
}

async function enrichReport(report) {
  const output = path.join(ROOT, "docs/unified/performance-measurement.json");
  let previous = null;
  try { previous = JSON.parse(await readFile(output, "utf8")); } catch {}
  const archived = Array.isArray(previous?.runs) ? [...previous.runs] : [];
  if (Array.isArray(previous?.samples) && previous.samples.length > 0) archived.push({ kind: "archived-run-before-overwrite", generated_at: previous.generated_at, status: previous.status, candidate: previous.candidate, samples: previous.samples, corpus: previous.corpus, summary: previous.summary, checks: previous.checks, preregistered_thresholds: previous.preregistered_thresholds });
  const rows = report.samples ?? [];
  const completenessPass = rows.length === DEFAULT_SAMPLES * MODES.length && MODES.every((mode) => rows.filter((row) => row.mode === mode).length === DEFAULT_SAMPLES);
  const performanceChecks = ["cold_p95_ms", "restart_p95_ms", "warm_p95_ms", "dirty_p95_ms", "process_tree_rss_p95_bytes"];
  const qualityChecks = ["quality_min_anchored_results", "quality_required_anchor", "quality_both_anchors", "dirty_new_hash_evidence"];
  const performancePass = performanceChecks.every((name) => report.checks?.[name]?.pass === true);
  const qualityPass = qualityChecks.every((name) => report.checks?.[name]?.pass === true);
  const rssByCommand = {};
  for (const row of rows) for (const processRow of row.processTree ?? []) { const key = processRow.command.includes("workers/retrieval") ? "retrieval_worker" : processRow.command.includes("workers/graph") ? "graph_worker" : processRow.command.includes("perf-worker") ? "benchmark_worker" : "other_owned_descendant"; rssByCommand[key] = Math.max(rssByCommand[key] ?? 0, processRow.rssBytes); }
  const preregPath = path.join(ROOT, "docs/unified/performance-preregistration.json");
  return { ...report, measurement_completeness: { status: completenessPass ? "PASS" : "FAIL", expectedRows: DEFAULT_SAMPLES * MODES.length, actualRows: rows.length }, performance_status: { status: performancePass ? "PASS" : "FAIL", checks: performanceChecks }, quality_status: { status: qualityPass ? "PASS" : "FAIL", checks: qualityChecks }, verdicts: { performance: { status: performancePass ? "PASS" : "FAIL", reason: performancePass ? "all preregistered performance checks passed" : "one or more preregistered performance checks failed" }, quality: { status: qualityPass ? "PASS" : "FAIL", reason: qualityPass ? "all exact quality checks passed" : "one or more quality checks failed" } }, preregistration_identity: { path: "docs/unified/performance-preregistration.json", sha256: sha256(await readFile(preregPath)), corpus_sha256: report.corpus?.sha256 }, measurement_scope: { rss_sampler: "worker PID plus descendant process tree only; unrelated machine processes excluded", shutdown: "closeIndexManager before closeUnified; bounded SIGKILL fallback targets only owned worker child", raw_process_fields: ["pid", "ppid", "rssBytes", "command"] }, rss_breakdown: { peak_process_max_rss_bytes: rssByCommand }, runs: archived };
}

async function main(argv) {
  const output = path.join(ROOT, "docs/unified/performance-measurement.json");
  if (argv.includes("--prepare")) { console.log(JSON.stringify(reportPrepared(), null, 2)); return 0; }
  if (argv.includes("--rebuild-report")) { const report = await enrichReport(JSON.parse(await readFile(output, "utf8"))); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2)); return report.status === "MEASURED" ? 0 : 1; }
  if (!argv.includes("--run") || !argv.includes("--worker")) throw new Error("usage: verify-performance.mjs --prepare | --rebuild-report | --run --worker [--samples=N]");
  const samplesArg = argv.find((arg) => arg.startsWith("--samples="));
  const samples = samplesArg ? Math.max(1, Number(samplesArg.slice("--samples=".length))) : DEFAULT_SAMPLES;
  const measurement = await runWorkerMeasurements(samples);
  const summaries = Object.fromEntries(MODES.map((mode) => [mode, summaryForMode(mode, measurement.samples.filter((row) => row.mode === mode))]));
  const checks = buildChecks(summaries, measurement.samples);
  const expectedRows = samples * MODES.length;
  const valid = samples === DEFAULT_SAMPLES && measurement.samples.length === expectedRows && Object.values(checks).every((check) => check.pass === true) && MODES.every((mode) => summaries[mode].n === samples);
  const report = await enrichReport({ schema_version: 2, status: valid ? "MEASURED" : "FAIL", generated_at: new Date().toISOString(), candidate: { source: "src/engine.js", profile: "release", samples, protocol: "worker" }, samples: measurement.samples, corpus: measurement.corpus, worker_protocol: measurement.worker_protocol, ...(measurement.failures ? { failures: measurement.failures } : {}), summary: summaries, checks, preregistered_thresholds: THRESHOLDS });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2)); return valid ? 0 : 1;
}
try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(`verify-performance: ${error.message}`); process.exitCode = 2; }
