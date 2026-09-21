import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ZVEC_ENTRY = path.join(ROOT, "vendor/zvec-grep/dist/lazy-entry.js");
const CODEGRAPH_ENTRY = path.join(ROOT, "vendor/codegraph/dist/lazy-entry.js");
const BUILT = existsSync(ZVEC_ENTRY) && existsSync(CODEGRAPH_ENTRY);
const SKIP = BUILT ? false : "vendored forks are not built; run `npm run build` first";

/**
 * Relative module specifiers in a built file. The vendored output is plain
 * TypeScript emit, so `import ... from "./x.js"` and `require("./x")` are the
 * only two shapes that appear.
 */
function relativeSpecifiers(source) {
  const out = new Set();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g)) {
    out.add(match[1]);
  }
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every built module reachable from `entry` through relative specifiers. */
function moduleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

function subtreesTouched(graph, distRoot) {
  const out = new Set();
  for (const file of graph) {
    const rel = path.relative(distRoot, file);
    if (rel.startsWith("..")) continue;
    const top = rel.split(path.sep)[0];
    if (top.endsWith(".js")) continue;
    out.add(top);
  }
  return out;
}

test("the zvec fork entry cannot reach the CLI, MCP server or daemon", { skip: SKIP }, () => {
  const distRoot = path.join(ROOT, "vendor/zvec-grep/dist");
  const touched = subtreesTouched(moduleGraph(ZVEC_ENTRY), distRoot);
  // Guard against the graph walker silently resolving nothing.
  assert.ok(touched.has("engine"), `expected the engine subtree, saw: ${[...touched].join(", ")}`);
  for (const forbidden of ["cli", "mcp", "daemon"]) {
    assert.ok(!touched.has(forbidden), `vendor/zvec-grep/dist/lazy-entry.js reaches ${forbidden}/`);
  }
});

test("the CodeGraph fork entry cannot reach the CLI, installer, upgrade, telemetry, UI or the MCP server", { skip: SKIP }, () => {
  const distRoot = path.join(ROOT, "vendor/codegraph/dist");
  const graph = moduleGraph(CODEGRAPH_ENTRY);
  const touched = subtreesTouched(graph, distRoot);
  assert.ok(touched.has("extraction"), `expected the extraction subtree, saw: ${[...touched].join(", ")}`);
  for (const forbidden of ["bin", "installer", "upgrade", "ui", "telemetry"]) {
    assert.ok(!touched.has(forbidden), `vendor/codegraph/dist/lazy-entry.js reaches ${forbidden}/`);
  }
  // `mcp/version.js` is a leaf that only reads package.json, and the facade stamps
  // its version from it. The server itself must stay out: upstream's src/index.ts
  // re-exported MCPServer, which dragged in upgrade/update-check (a background
  // GitHub update probe, src/mcp/index.ts:53) and telemetry. A recorded local
  // patch removed that line; if it returns, an updater is reachable from a query.
  const reachedMcp = [...graph]
    .map((file) => path.relative(distRoot, file))
    .filter((rel) => rel.startsWith(`mcp${path.sep}`));
  assert.deepEqual(reachedMcp, [`mcp${path.sep}version.js`], `unexpected MCP modules on the library path: ${reachedMcp.join(", ")}`);
});

/**
 * Resource kinds that mean something was *started*. A bare PipeWrap is not in the
 * list: Node materialises stdio pipe handles on demand, and they do not hold the
 * loop open. The stronger half of this test is that the child exits at all.
 */
const STARTED_SOMETHING = ["Timeout", "Immediate", "FSEventWrap", "StatWatcher", "TCPSERVERWRAP", "TCPWRAP", "PIPESERVERWRAP", "ChildProcess", "Worker", "MessagePort"];

test("importing either fork entry starts no server, watcher, worker or timer", { skip: SKIP, timeout: 60_000 }, async () => {
  const probe = `
    const before = process.getActiveResourcesInfo();
    await import(${JSON.stringify(ZVEC_ENTRY)});
    const { createRequire } = await import("node:module");
    createRequire(${JSON.stringify(CODEGRAPH_ENTRY)})(${JSON.stringify(CODEGRAPH_ENTRY)});
    const after = process.getActiveResourcesInfo();
    const leaked = [...after];
    for (const kind of before) {
      const at = leaked.indexOf(kind);
      if (at !== -1) leaked.splice(at, 1);
    }
    process.stdout.write("LEAKED:" + JSON.stringify(leaked) + "\\n");
  `;
  // If an import started a server, watcher or interval, the child never exits and
  // execFile's timeout kills it — which is itself the failure signal.
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], { cwd: ROOT, timeout: 45_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("LEAKED:"));
  assert.ok(line, `probe produced no result: ${stdout}`);
  const leaked = JSON.parse(line.slice("LEAKED:".length));
  const started = leaked.filter((kind) => STARTED_SOMETHING.includes(kind));
  assert.deepEqual(started, [], `fork entry import started: ${started.join(", ")}`);
});
test("the fork entries expose the surface the workers are typed against", { skip: SKIP }, async () => {
  const zvec = await import(ZVEC_ENTRY);
  assert.equal(typeof zvec.createZvecGrep, "function");
  assert.equal(typeof zvec.createEmbeddingModel, "function");
  assert.equal(zvec.LAZY_INTEL_ZVEC_UPSTREAM_COMMIT, "309a66995809243d3274fa8b5bea63ab11dda1a0");

  const { createRequire } = await import("node:module");
  const codegraph = createRequire(CODEGRAPH_ENTRY)(CODEGRAPH_ENTRY);
  assert.equal(typeof codegraph.CodeGraph, "function");
  assert.equal(typeof codegraph.DatabaseConnection, "function");
  assert.equal(codegraph.LAZY_INTEL_CODEGRAPH_UPSTREAM_COMMIT, "dfccdf62547fcd76d343344d823a0e1998d3a89f");
  // The published wrapper's escape hatches must not be re-exported by our entry.
  assert.equal(codegraph.MCPServer, undefined);
});

test("every vendored tree matches its UPSTREAM.json ledger", async () => {
  const { stdout } = await run(process.execPath, [path.join(ROOT, "scripts/verify-vendor.mjs"), "--json"], { cwd: ROOT });
  const report = JSON.parse(stdout);
  assert.equal(report.status, "PASS", stdout);
  assert.equal(report.vendors.length, readdirSync(path.join(ROOT, "vendor")).length);
  for (const vendor of report.vendors) {
    assert.equal(vendor.drift.length, 0, `${vendor.vendor}: ${JSON.stringify(vendor.drift)}`);
    assert.equal(vendor.missing.length, 0, `${vendor.vendor}: missing ${vendor.missing.join(", ")}`);
  }
});
