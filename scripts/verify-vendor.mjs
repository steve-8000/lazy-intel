#!/usr/bin/env node
// Verify every vendored upstream tree against its UPSTREAM.json ledger.
//
// The ledger records the pinned upstream commit and the Git blob SHA of every
// imported file. A vendored file may differ from upstream only when the ledger
// lists it under `local_patches`; anything else is undeclared drift and fails.
// Run this before any release and after any vendor edit.
//
//   node scripts/verify-vendor.mjs            # all vendors
//   node scripts/verify-vendor.mjs zvec-grep  # one vendor
//   node scripts/verify-vendor.mjs --json     # machine-readable report on stdout
//
// Exit 0 = clean, 1 = drift or missing files, 2 = usage/IO error.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_ROOT = path.join(ROOT, "vendor");

/** Git's blob object id: sha1 over `blob <bytelength>\0` followed by the raw bytes. */
function gitBlobSha(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

async function readLedger(name) {
  const file = path.join(VENDOR_ROOT, name, "UPSTREAM.json");
  const ledger = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(ledger.manifest) || ledger.manifest.length === 0) {
    throw new Error(`${name}: UPSTREAM.json has no manifest`);
  }
  return ledger;
}

/**
 * Directories produced by a build rather than imported from upstream. They are
 * gitignored; treating them as drift would make every post-build run fail and
 * train people to ignore this tool.
 */
const GENERATED = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);

/** Every imported-looking file in the vendor tree, so extra files are visible too. */
async function walk(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (GENERATED.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(abs, rel, out);
    else if (entry.isFile()) out.add(rel);
  }
  return out;
}

async function verify(name) {
  const ledger = await readLedger(name);
  const dir = path.join(VENDOR_ROOT, name);
  const patched = new Map((ledger.local_patches ?? []).map((p) => [p.path, p]));
  const result = { vendor: name, commit: ledger.upstream.commit, files: ledger.manifest.length, verbatim: 0, patched: [], drift: [], missing: [], untracked: [] };

  for (const { path: rel, blob } of ledger.manifest) {
    const abs = path.join(dir, rel);
    let buffer;
    try {
      buffer = await readFile(abs);
    } catch {
      result.missing.push(rel);
      continue;
    }
    const actual = gitBlobSha(buffer);
    if (actual === blob) {
      result.verbatim += 1;
      if (patched.has(rel)) result.drift.push({ path: rel, reason: "declared as patched but is byte-identical to upstream" });
      continue;
    }
    const patch = patched.get(rel);
    if (!patch) {
      result.drift.push({ path: rel, reason: "modified without a local_patches entry", upstream: blob, actual });
      continue;
    }
    if (patch.original_blob !== blob) {
      result.drift.push({ path: rel, reason: "local_patches.original_blob does not match the imported blob", declared: patch.original_blob, upstream: blob });
      continue;
    }
    if (patch.resulting_blob !== actual) {
      result.drift.push({ path: rel, reason: "file no longer matches local_patches.resulting_blob", declared: patch.resulting_blob, actual });
      continue;
    }
    result.patched.push(rel);
  }

  const tracked = new Set(ledger.manifest.map((f) => f.path));
  const present = await walk(dir, "", new Set());
  for (const rel of present) {
    if (tracked.has(rel)) continue;
    if (rel === "UPSTREAM.json") continue;
    if ((ledger.added_files ?? []).includes(rel)) continue;
    result.untracked.push(rel);
  }
  result.untracked.sort();
  return result;
}

async function main(argv) {
  const json = argv.includes("--json");
  const names = argv.filter((a) => !a.startsWith("--"));
  let vendors = names;
  if (vendors.length === 0) {
    const entries = await readdir(VENDOR_ROOT, { withFileTypes: true }).catch(() => []);
    vendors = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }
  if (vendors.length === 0) {
    process.stderr.write("verify-vendor: no vendor directories found\n");
    return 2;
  }

  const results = [];
  for (const name of vendors) results.push(await verify(name));
  const failed = results.some((r) => r.drift.length > 0 || r.missing.length > 0 || r.untracked.length > 0);

  if (json) {
    process.stdout.write(JSON.stringify({ status: failed ? "FAIL" : "PASS", vendors: results }, null, 2) + "\n");
    return failed ? 1 : 0;
  }

  for (const r of results) {
    process.stdout.write(`${r.vendor} @ ${r.commit.slice(0, 12)}  ${r.verbatim}/${r.files} verbatim, ${r.patched.length} declared patches\n`);
    for (const rel of r.patched) process.stdout.write(`  patched   ${rel}\n`);
    for (const rel of r.missing) process.stdout.write(`  MISSING   ${rel}\n`);
    for (const d of r.drift) process.stdout.write(`  DRIFT     ${d.path}: ${d.reason}\n`);
    for (const rel of r.untracked) process.stdout.write(`  UNTRACKED ${rel}\n`);
  }
  process.stdout.write(failed ? "verify-vendor: FAIL\n" : "verify-vendor: PASS\n");
  return failed ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`verify-vendor: ${error.message}\n`);
  process.exitCode = 2;
}
