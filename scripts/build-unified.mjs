#!/usr/bin/env node
// One coordinated build for the unified engine.
//
// Deliberately NOT an npm workspace. Each vendored upstream keeps its own
// package-lock and its own node_modules, because hoisting would silently move
// zvec-grep and CodeGraph onto one resolved dependency set and change the code
// their pinned locks were tested against. "One build" means one command and one
// ordering, not one forced dependency version.
//
//   node scripts/build-unified.mjs                 # install (if needed) + build everything
//   node scripts/build-unified.mjs --only=vendor   # only the vendored forks
//   node scripts/build-unified.mjs --only=core     # only packages/core
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

/**
 * Build order is a dependency order, not a preference:
 * contracts first (the workers are typed against them), then the vendored
 * libraries the workers load.
 */
const TARGETS = [
  {
    name: "core",
    group: "core",
    dir: "packages/core",
    lockfile: null,
    build: ["npm", ["run", "build"]],
    outputs: ["dist/contracts.js", "dist/index.js"],
  },
  {
    name: "zvec-grep",
    group: "vendor",
    dir: "vendor/zvec-grep",
    lockfile: "package-lock.json",
    build: ["npm", ["run", "build"]],
    // lazy-entry.js is the headless surface; its presence proves the fork entry
    // compiled, not merely that upstream did.
    outputs: ["dist/index.js", "dist/lazy-entry.js"],
  },
  {
    name: "codegraph",
    group: "vendor",
    dir: "vendor/codegraph",
    lockfile: "package-lock.json",
    build: ["npm", ["run", "build"]],
    // schema.sql and the grammars are copied by the upstream copy-assets step.
    // A TypeScript build that type-checks but loses these assets is a runtime
    // failure at first query, so they are part of the build contract.
    outputs: ["dist/index.js", "dist/lazy-entry.js", "dist/db/schema.sql", "dist/extraction/wasm/tree-sitter-typescript.wasm"],
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
  if (options.only && !["core", "vendor"].includes(options.only)) {
    throw new Error(`--only must be core or vendor, got ${options.only}`);
  }
  return options;
}

function exec(command, args, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", (error) => resolve({ code: -1, output: `${error.message}\n`, ms: Date.now() - started }));
    child.on("close", (code) => resolve({ code: code ?? -1, output: out, ms: Date.now() - started }));
  });
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Reinstall when node_modules is absent or older than the lockfile it was built from. */
async function needsInstall(dir, lockfile) {
  const modules = path.join(dir, "node_modules");
  if (!(await exists(modules))) return "node_modules missing";
  if (!lockfile) return null;
  const lockPath = path.join(dir, lockfile);
  if (!(await exists(lockPath))) return null;
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

  const reason = await needsInstall(dir, target.lockfile);
  if (reason) {
    if (!options.install) {
      record.status = "failed";
      record.error = `${target.name}: ${reason} and --no-install was given`;
      return record;
    }
    // npm ci for a locked vendor tree; npm install only where no lock is pinned.
    const args = target.lockfile ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
    log(`${target.name}: npm ${args[0]} (${reason})`);
    const install = await exec("npm", args, dir);
    record.steps.push({ step: `npm ${args[0]}`, code: install.code, ms: install.ms });
    if (install.code !== 0) {
      record.status = "failed";
      record.error = install.output.trimEnd();
      return record;
    }
  }

  log(`${target.name}: ${target.build[0]} ${target.build[1].join(" ")}`);
  const built = await exec(target.build[0], target.build[1], dir);
  record.steps.push({ step: target.build[1].join(" "), code: built.code, ms: built.ms });
  if (built.code !== 0) {
    record.status = "failed";
    record.error = built.output.trimEnd();
    return record;
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

/** The vendored source must still match its ledger, or the build is of something else. */
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
  const selected = TARGETS.filter((t) => !options.only || t.group === options.only);

  const results = [];
  for (const target of selected) {
    results.push(await buildTarget(target, options, log));
    if (results.at(-1).status !== "ok") break; // a broken contract build makes the rest meaningless
  }

  const failed = results.some((r) => r.status !== "ok");
  const report = {
    status: failed ? "FAIL" : "PASS",
    node: process.version,
    vendor_pins: await vendorLedgerCommits(),
    targets: results,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const r of results) {
      const ms = r.steps.reduce((sum, s) => sum + s.ms, 0);
      process.stdout.write(`${r.status === "ok" ? "ok  " : "FAIL"} ${r.target} (${ms}ms)\n`);
      if (r.error) process.stdout.write(`${r.error}\n`);
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
