#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const repo = path.resolve(new URL("..", import.meta.url).pathname);
const fixtureRoot = path.join(repo, "test", "fixtures");
const source = {
  "src/main.js": "export function add(a, b) { return a + b; }\nexport function answer() { return add(40, 2); }\n",
  "src/consumer.js": "import { add } from './main.js';\nexport const value = add(1, 2);\n",
  "README.txt": "fixture workspace for lazy-intel backend capture\n",
};
const sourceBytes = Object.entries(source).map(([name, body]) => `${name}\0${body}`).join("");
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    const out = []; const err = []; let settled = false;
    child.stdout.on("data", (chunk) => out.push(chunk)); child.stderr.on("data", (chunk) => err.push(chunk));
    const timer = setTimeout(() => { if (!settled) { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 500).unref(); } }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: null, signal: null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: error.message }); } });
    child.on("close", (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); } });
  });
}
async function save(backend, name, command, args, result, extra = {}) {
  const dir = path.join(fixtureRoot, backend); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ backend, case: name, command, args, ...result, ...extra }, null, 2) + "\n");
  return { backend, case: name, command, args, available: Boolean(result.error == null && (result.code === 0 || result.stdout || result.stderr)), ...(result.error ? { captureError: result.error } : {}), ...extra };
}
async function packageVersion(packageName) {
  const direct = path.join(repo, "node_modules", ...packageName.split("/"), "package.json");
  try { const p = require.resolve(`${packageName}/package.json`, { paths: [repo] }); return { version: JSON.parse(await readFile(p, "utf8")).version, packageJson: p }; }
  catch (error) {
    try { return { version: JSON.parse(await readFile(direct, "utf8")).version, packageJson: direct }; }
    catch (fallbackError) { return { version: null, packageJson: null, packageMetadataUnavailable: fallbackError.message }; }
  }
}
async function serenaCase(root, name, toolName, toolArgs, commandArgs) {
  const command = process.env.SERENA_BIN ?? path.join(process.env.HOME ?? "", ".local/bin/serena");
  const child = spawn(command, commandArgs, { cwd: root, env: { ...process.env, SERENA_USAGE_REPORTING: "false", DO_NOT_TRACK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = ""; const messages = []; const stderr = [];
  child.stdout.on("data", (chunk) => { buffer += chunk.toString("utf8"); let nl; while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); try { messages.push(JSON.parse(line)); } catch {} } });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture-capture", version: "1" } });
  await new Promise((resolve) => setTimeout(resolve, 1500)); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  send(2, "tools/list", {}); await new Promise((resolve) => setTimeout(resolve, 300));
  send(3, "tools/call", { name: toolName, arguments: toolArgs }); await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill("SIGTERM"); const result = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return save("serena", name, command, commandArgs, { ...result, stdout: JSON.stringify(messages, null, 2), stderr: stderr.join("") });
}

const root = await mkdtemp(path.join(tmpdir(), "lazy-intel-fixture-"));
for (const [name, body] of Object.entries(source)) { const dest = path.join(root, name); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, body); }
const manifest = { formatVersion: 1, capturedAt: new Date().toISOString(), platform: platform(), arch: arch(), node: process.version, fixtureSourceSha256: sourceHash, workspace: "disposable temporary workspace", backends: {}, cases: [] };
try {
  const zg = path.join(repo, "node_modules/.bin/zg");
  manifest.backends.zvec = { package: "@zvec/zvec-grep", ...(await packageVersion("@zvec/zvec-grep")) };
  const zcases = [["success", ["query", "--rg", "add", root]], ["zero-result", ["query", "--rg", "definitely-no-fixture-match", root]], ["truncated-limited", ["query", "--rg", "--limit", "1", "add", root]], ["unsupported-operation", ["unsupported-operation", root]], ["error", ["query", "--rg", "add", "/definitely/missing/path"]]];
  for (const [name, args] of zcases) manifest.cases.push(await save("zvec", name, zg, args, await exec(zg, args, { cwd: root })));
  const cg = path.join(repo, "node_modules/.bin/codegraph");
  manifest.backends.codegraph = { package: "@colbymchenry/codegraph", ...(await packageVersion("@colbymchenry/codegraph")) };
  const init = await exec(cg, ["init", "--yes", root], { cwd: root, timeoutMs: 180_000 }); manifest.codegraphInit = { command: cg, args: ["init", "--yes", root], ...init };
  const ccases = [["success", ["explore", "add", "--path", root, "--max-files", "4"]], ["zero-result", ["explore", "definitely-no-fixture-match", "--path", root, "--max-files", "4"]], ["truncated-limited", ["explore", "add", "--path", root, "--max-files", "1"]], ["unsupported-operation", ["unsupported-operation", "--path", root]], ["error", ["impact", "MissingSymbol", "--path", root, "--json"]]];
  for (const [name, args] of ccases) manifest.cases.push(await save("codegraph", name, cg, args, await exec(cg, args, { cwd: root, timeoutMs: 120_000 })));
  const impactArgs = ["impact", "add", "--path", root, "--depth", "2", "--json"]; manifest.cases.push(await save("codegraph", "impact-json", cg, impactArgs, await exec(cg, impactArgs, { cwd: root, timeoutMs: 120_000 })));
  const sb = process.env.SERENA_BIN ?? path.join(process.env.HOME ?? "", ".local/bin/serena");
  const serenaVersion = await exec(sb, ["--version"], { cwd: root, timeoutMs: 20_000 });
  manifest.backends.serena = { package: "serena-agent", version: serenaVersion.stdout.trim() || null, packageJson: null, packageMetadataUnavailable: "Pinned executable is a Python tool entry point; no package.json is installed beside it.", versionCommand: { command: sb, args: ["--version"], ...serenaVersion } };
  const common = ["start-mcp-server", "--transport", "stdio", "--context", "agent", "--project", root, "--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "ERROR"];
  manifest.cases.push(await serenaCase(root, "success", "find_symbol", { name_path_pattern: "add", relative_path: "src/main.js", max_answer_chars: 4000 }, common));
  manifest.cases.push(await serenaCase(root, "zero-result", "find_symbol", { name_path_pattern: "DefinitelyMissing", relative_path: "src/main.js", max_answer_chars: 4000 }, common));
  manifest.cases.push(await serenaCase(root, "truncated-limited", "find_symbol", { name_path_pattern: "add", relative_path: "src/main.js", max_matches: 1, max_answer_chars: 80 }, common));
  manifest.cases.push(await serenaCase(root, "unsupported-operation", "not_a_serena_tool", {}, common));
  manifest.cases.push(await serenaCase(root, "error", "find_symbol", { name_path_pattern: 42, relative_path: "missing.js", max_answer_chars: 4000 }, common));
} finally { await rm(root, { recursive: true, force: true }); }
await mkdir(fixtureRoot, { recursive: true }); await writeFile(path.join(fixtureRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
