#!/usr/bin/env node
// Exercise the unified local workers. Published backend CLIs are intentionally
// not probed: they are fixture/rollback inputs, not production dependencies.
import assert from "node:assert/strict";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/lib/process.js";
import { StdioMcpClient, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/client.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-compat-"));
const pins = JSON.parse(await readFile(path.join(repo, "upstreams.lock.json"), "utf8")).upstreams;
const report = {
  status: "FAIL",
  engine: "unified",
  versions: {},
  artifacts: {},
  operations: [],
  semantic: { status: "UNAVAILABLE", reason: "no explicit LAZY_INTEL_LSP toolchain was supplied" },
  latencyMs: {},
  scope: "Local vendored forks and core with a disposable two-file JavaScript workspace. Published backend CLIs are not production inputs. Retrieval uses the configured zvec embedding behavior; model calls are allowed. Semantic reads require an explicit existing language-server executable via LAZY_INTEL_LSP and never download one.",
};
let client;

async function present(relativePath, executable = false) {
  try {
    await access(path.join(repo, relativePath), executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function localPins() {
  const local = {};
  for (const [name, entry] of Object.entries(pins)) {
    const vendor = name === "zvec-grep" ? "vendor/zvec-grep" : name === "codegraph" ? "vendor/codegraph" : null;
    let version = entry.version;
    if (vendor) {
      try {
        version = JSON.parse(await readFile(path.join(repo, vendor, "package.json"), "utf8")).version;
      } catch { /* ledger version remains the declared local pin */ }
    }
    local[name] = `${version} @ ${entry.commit.slice(0, 12)} (vendored)`;
  }
  return local;
}

const configuredSemanticToolchain = () => {
  const raw = process.env.LAZY_INTEL_LSP?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const languageServerPath = parsed?.typescript;
    if (typeof languageServerPath !== "string" || !path.isAbsolute(languageServerPath)) {
      return { error: "LAZY_INTEL_LSP must be JSON with an absolute typescript executable path" };
    }
    return { languageServerPath };
  } catch (error) {
    return { error: `LAZY_INTEL_LSP is not valid JSON: ${error.message}` };
  }
};

const open = async () => {
  const semantic = configuredSemanticToolchain();
  if (semantic?.error) {
    report.semantic = { status: "UNAVAILABLE", reason: semantic.error };
  } else if (semantic) {
    try {
      await access(semantic.languageServerPath, constants.X_OK);
      report.semantic = { status: "READY", language: "typescript", languageServerPath: semantic.languageServerPath };
    } catch {
      report.semantic = { status: "UNAVAILABLE", reason: `configured language server is not executable: ${semantic.languageServerPath}` };
    }
  }
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    LAZY_INTEL_ROOT: root,
    LAZY_INTEL_ALLOWED_ROOTS: "",
    LAZY_INTEL_AUTO_INDEX: "false",
    LAZY_INTEL_MAINTENANCE_MS: "0",
  };
  if (semantic && !semantic.error) env.LAZY_INTEL_LSP = JSON.stringify({ typescript: semantic.languageServerPath });
  client = new StdioMcpClient(process.execPath, [path.join(repo, "src/cli.js"), "serve"], { cwd: root, timeoutMs: 900000, env });
  await client.start();
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(client.protocolVersion), `unsupported negotiated version: ${client.protocolVersion}`);
  assert.equal(client.protocolVersion, "2025-06-18");
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["code_intel"]);
};

const query = async (operation, args, { semantic = false } = {}) => {
  const started = performance.now();
  const result = await client.callTool("code_intel", { operation, root, ...args, indexTimeoutMs: 600000, timeoutMs: 120000 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  for (const field of ["root", "operation", "routes", "backends"]) assert.ok(Object.hasOwn(result.structuredContent, field), `missing unified metadata: ${field}`);
  const unavailable = result.structuredContent.backends.filter((backend) => !backend.ok);
  if (semantic && unavailable.length > 0) {
    report.semantic = { ...report.semantic, status: "UNAVAILABLE", reason: unavailable.map((backend) => backend.detail ?? backend.error ?? backend.backend).join("; ") };
    return { text: result.content.map((block) => block.text ?? "").join("\n"), ms: Math.round(performance.now() - started), unavailable: true };
  }
  assert.equal(unavailable.length, 0, JSON.stringify(result.structuredContent));
  report.operations.push(operation);
  return { text: result.content.map((block) => block.text ?? "").join("\n"), ms: Math.round(performance.now() - started) };
};

try {
  report.versions = await localPins();
  report.artifacts = {
    core: await present("packages/core/dist/index.js"),
    retrieval: await present("vendor/zvec-grep/dist/lazy-entry.js"),
    graph: await present("vendor/codegraph/dist/lazy-entry.js"),
    semanticPython: await present("workers/semantic/.venv/bin/python", true),
  };
  assert.ok(Object.values(report.artifacts).every(Boolean), JSON.stringify(report.artifacts));

  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["*.mjs"] }));
  await writeFile(path.join(root, ".gitignore"), ".zvec-grep/\n.codegraph/\n.serena-lazy/\n");
  await run("git", ["init", "--quiet", root], { cwd: root, timeoutMs: 30000 });
  await writeFile(path.join(root, "discount.mjs"), "// Percentage discounts reduce an invoice amount in integer cents.\nexport function applyDiscount(cents, percent) { return Math.round(cents * (100 - percent) / 100); }\n");
  await writeFile(path.join(root, "invoice.mjs"), "import { applyDiscount } from './discount.mjs';\nexport function invoiceTotal(cents, percent) { return applyDiscount(cents, percent); }\n");

  await open();
  const search = await query("search", { query: "percentage discount invoice cents" });
  assert.match(search.text, /discount\.mjs/); report.latencyMs.firstSearch = search.ms;
  const architecture = await query("architecture", { query: "invoiceTotal calls applyDiscount" });
  assert.match(architecture.text, /invoiceTotal/);
  const impact = await query("impact", { symbol: "applyDiscount" });
  assert.match(impact.text, /invoice/);

  if (report.semantic.status === "READY") {
    const references = await query("references", { symbol: "applyDiscount", relativePath: "discount.mjs" }, { semantic: true });
    if (!references.unavailable) assert.match(references.text, /invoice\.mjs/);
    const symbol = await query("symbol", { symbol: "applyDiscount", relativePath: "discount.mjs", includeBody: true }, { semantic: true });
    if (!symbol.unavailable) assert.match(symbol.text, /100 - percent/);
  }

  client.close(); await new Promise((resolve) => client.child.once("close", resolve));
  await open();
  const restarted = await query("search", { query: "percentage discount invoice cents" });
  assert.match(restarted.text, /discount\.mjs/); report.latencyMs.restartFirstSearch = restarted.ms;
  report.latencyMs.warmSearch = (await query("search", { query: "percentage discount invoice cents" })).ms;
  report.status = "PASS";
} finally {
  if (client && !client.closed) { client.close(); await new Promise((resolve) => client.child.once("close", resolve)); }
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
