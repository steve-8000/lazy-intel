#!/usr/bin/env node
// One coordinated build for the unified engine. Each owned fork keeps its own
// lockfile and node_modules; the semantic worker keeps its uv.lock/.venv.
//
//   node scripts/build-unified.mjs                 # install (if needed) + build everything
//   node scripts/build-unified.mjs --only=vendor   # only the vendored forks
//   node scripts/build-unified.mjs --only=core     # only packages/core
//   node scripts/build-unified.mjs --only=semantic # only the Python worker environment
//   node scripts/build-unified.mjs --clean         # drop dist/ first
//   node scripts/build-unified.mjs --no-install    # fail instead of installing
//   node scripts/build-unified.mjs --json          # machine-readable report
//
// Exit 0 = every selected target built, 1 = a target failed, 2 = usage error.

import { spawn } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    name: "core",
    group: "core",
    dir: "packages/core",
    lockfile: "package-lock.json",
    install: ["npm", ["ci", "--no-audit", "--no-fund"]],
    build: ["npm", ["run", "build"]],
    outputs: ["dist/contracts.js", "dist/index.js"],
  },
  {
    name: "zvec-grep",
    group: "vendor",
    dir: "vendor/zvec-grep",
    lockfile: "package-lock.json",
    install: ["npm", ["ci", "--no-audit", "--no-fund"]],
    build: ["npm", ["run", "build"]],
    outputs: ["dist/index.js", "dist/lazy-entry.js"],
  },
  {
    name: "codegraph",
    group: "vendor",
    dir: "vendor/codegraph",
    lockfile: "package-lock.json",
    install: ["npm", ["ci", "--no-audit", "--no-fund"]],
    build: ["npm", ["run", "build"]],
    outputs: ["dist/index.js", "dist/lazy-entry.js", "dist/db/schema.sql", "dist/extraction/wasm/tree-sitter-typescript.wasm"],
  },
  {
    name: "semantic",
    group: "semantic",
    dir: "workers/semantic",
    lockfile: "uv.lock",
    environment: ".venv/bin/python",
    install: ["uv", ["sync", "--locked"]],
    build: null,
    outputs: [".venv/bin/python"],
  },
];

function parseArgs(argv) {
  const options = { only: null, clean: false, install: true, json: false };
  for (const arg of argv) {
    if (arg === "--clean") options.clean = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--only=")) options.only = arg.slice("--only=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.only && !["core", "vendor", "semantic"].includes(options.only)) {
    throw new Error(`--only must be core, vendor, or semantic, got ${options.only}`);
  }
  return options;
}

function exec(command, args, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ code: -1, output: `${error.message}\n`, ms: Date.now() - started }));
    child.on("close", (code) => resolve({ code: code ?? -1, output, ms: Date.now() - started }));
  });
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

/** Install only the target's owned, lockfile-pinned environment when absent. */
async function needsInstall(dir, target) {
  if (target.environment) return (await exists(path.join(dir, target.environment))) ? null : `${target.environment} missing`;
  const modules = path.join(dir, "node_modules");
  if (!(await exists(modules))) return "node_modules missing";
  const lockPath = path.join(dir, target.lockfile);
  if (!(await exists(lockPath))) return `${target.lockfile} missing`;
  const [lockStat, modulesStat] = await Promise.all([stat(lockPath), stat(modules)]);
  return lockStat.mtimeMs > modulesStat.mtimeMs ? "lockfile is newer than node_modules" : null;
}

async function buildTarget(target, options, log) {
  const dir = path.join(ROOT, target.dir);
  const record = { target: target.name, dir: target.dir, steps: [], status: "ok" };
  if (!(await exists(dir))) {
    record.status = "missing";
    record.error = `${target.dir} does not exist`;
    return record;
  }
  if (options.clean) {
    await rm(path.join(dir, "dist"), { recursive: true, force: true });
    record.steps.push({ step: "clean", code: 0, ms: 0 });
  }
  const reason = await needsInstall(dir, target);
  if (reason) {
    if (!options.install) {
      record.status = "failed";
      record.error = `${target.name}: ${reason} and --no-install was given`;
      return record;
    }
    log(`${target.name}: ${target.install[0]} ${target.install[1].join(" ")} (${reason})`);
    const installed = await exec(target.install[0], target.install[1], dir);
    record.steps.push({ step: target.install.join(" "), code: installed.code, ms: installed.ms });
    if (installed.code !== 0) {
      record.status = "failed";
      record.error = installed.output.trimEnd();
      return record;
    }
  }
  if (target.build) {
    log(`${target.name}: ${target.build[0]} ${target.build[1].join(" ")}`);
    const built = await exec(target.build[0], target.build[1], dir);
    record.steps.push({ step: target.build[1].join(" "), code: built.code, ms: built.ms });
    if (built.code !== 0) {
      record.status = "failed";
      record.error = built.output.trimEnd();
      return record;
    }
  }
  const missing = [];
  for (const output of target.outputs) {
    if (!(await exists(path.join(dir, output)))) missing.push(output);
  }
  if (missing.length > 0) {
    record.status = "failed";
    record.error = `build reported success but these outputs are missing: ${missing.join(", ")}`;
  }
  record.outputs = target.outputs;
  return record;
}

async function vendorLedgerCommits() {
  const out = {};
  for (const target of TARGETS) {
    if (target.group !== "vendor") continue;
    const ledger = path.join(ROOT, target.dir, "UPSTREAM.json");
    if (!(await exists(ledger))) continue;
    const parsed = JSON.parse(await readFile(ledger, "utf8"));
    out[target.name] = { commit: parsed.upstream.commit, patch_revision: parsed.patch_revision ?? 0 };
  }
  return out;
}

async function main(argv) {
  const options = parseArgs(argv);
  const log = options.json ? () => {} : (line) => process.stdout.write(`${line}\n`);
  const selected = TARGETS.filter((target) => !options.only || target.group === options.only);
  const results = [];
  for (const target of selected) {
    results.push(await buildTarget(target, options, log));
    if (results.at(-1).status !== "ok") break;
  }
  const failed = results.some((result) => result.status !== "ok");
  const report = { status: failed ? "FAIL" : "PASS", node: process.version, vendor_pins: await vendorLedgerCommits(), targets: results };
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const result of results) {
      const ms = result.steps.reduce((sum, step) => sum + step.ms, 0);
      process.stdout.write(`${result.status === "ok" ? "ok  " : "FAIL"} ${result.target} (${ms}ms)\n`);
      if (result.error) process.stdout.write(`${result.error}\n`);
    }
    process.stdout.write(failed ? "build-unified: FAIL\n" : "build-unified: PASS\n");
  }
  return failed ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`build-unified: ${error.message}\n`);
  process.exitCode = 2;
}
