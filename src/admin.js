import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexStatus, ensureIndexes, reindexIndexes } from "./index-manager.js";
import { pathExists, resolveBin, run } from "./lib/process.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// OMP must expose exactly one code-intelligence MCP; the standalone backends are subsumed.
const SUPERSEDED_SERVERS = ["zvec-grep", "codegraph", "serena"];

async function pins() {
  const lock = JSON.parse(await readFile(path.join(repoRoot, "upstreams.lock.json"), "utf8"));
  return {
    zg: lock.upstreams["zvec-grep"].version,
    codegraph: lock.upstreams.codegraph.version,
    serena: lock.upstreams.serena.version,
  };
}

async function engineRange() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  return pkg.engines?.node ?? "";
}

export async function doctor(root = process.cwd()) {
  const rows = [];
  const pin = await pins();
  const range = await engineRange();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeMinor = Number(process.versions.node.split(".")[1]);
  const nodeOk = (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5)) && nodeMajor < 25;
  rows.push({ item: "node", ok: nodeOk, detail: `${process.version} (${process.execPath}); required ${range}` });

  rows.push(await checkVersion("zg", ["version"], pin.zg));
  rows.push(await checkVersion("codegraph", ["version"], pin.codegraph));
  rows.push(await checkVersion("serena", ["--version"], pin.serena));
  rows.push(await zvecRuntimeRow());

  const status = await indexStatus(path.resolve(root));
  rows.push({ item: "embedding", ok: true, detail: status.embedding });
  for (const backend of ["zvec", "codegraph"]) {
    const b = status.backends[backend];
    rows.push({
      item: `${backend} index`,
      ok: b.present && (b.ready || b.building),
      detail: b.ready
        ? `ready; ${b.dirty === null ? "baseline unverified until first sync" : `dirty=${b.dirty}`}`
        : b.building ? "building" : (b.detail ?? "absent; auto-created on first use"),
    });
  }
  return rows;
}

async function checkVersion(item, args, expected) {
  try {
    const command = await resolveBin(item);
    const r = await run(command, args, { timeoutMs: 30_000 });
    const found = (r.stdout || r.stderr).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const version = found.match(/\d+\.\d+\.\d+/)?.[0];
    const ok = version === expected;
    return { item, ok, detail: `${version ?? found} (pinned ${expected})${ok ? "" : " MISMATCH"} @ ${command}` };
  } catch (error) {
    return { item, ok: false, detail: error.message };
  }
}

async function zvecRuntimeRow() {
  try {
    const zg = await resolveBin("zg");
    const r = await run(zg, ["server", "status"], { timeoutMs: 15_000 });
    const ready = /ready|running/i.test(r.stdout);
    const url = r.stdout.match(/http:\/\/\S+/)?.[0] ?? "no url";
    return { item: "zvec daemon", ok: true, detail: ready ? `shared server ${url}` : "direct mode (no shared server)" };
  } catch (error) {
    return { item: "zvec daemon", ok: true, detail: `direct mode (${error.message.split("\n")[0]})` };
  }
}

export async function initProject(root, options = {}) {
  const absolute = path.resolve(root);
  if (options.rebuild) {
    return reindexIndexes(absolute, ["zvec", "codegraph"], { embedding: options.embedding, timeoutMs: 1_800_000 });
  }
  return ensureIndexes(absolute, ["zvec", "codegraph"], { freshness: "strict", embedding: options.embedding, timeoutMs: 1_800_000 });
}

// Homebrew's Cellar path carries the patch version; the opt symlink survives upgrades.
async function stableNodePath() {
  const cellar = process.execPath.match(/^(\/.*)\/Cellar\/(node@\d+)\/[^/]+\/bin\/node$/);
  if (cellar) {
    const linked = `${cellar[1]}/opt/${cellar[2]}/bin/node`;
    if (await pathExists(linked)) return linked;
  }
  return process.execPath;
}

export async function installOmp(root, options = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = (major > 22 || (major === 22 && minor >= 5)) && major < 25;
  if (!supported) {
    throw new Error(`refusing to write ${process.execPath} (Node ${process.version}) into OMP configuration; `
      + `lazy-intel requires ${await engineRange()}. Re-run install-omp with a supported runtime, e.g. `
      + `PATH="$(brew --prefix node@22)/bin:$PATH"`);
  }
  const absolute = path.resolve(root);
  const configPath = options.global
    ? path.join(os.homedir(), ".omp", "agent", "mcp.json")
    : path.join(absolute, ".omp", "mcp.json");
  await mkdir(path.dirname(configPath), { recursive: true });

  let config = {};
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch {}
  config.$schema ??= "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
  config.mcpServers ??= {};

  const cliPath = path.join(repoRoot, "src", "cli.js");
  const entry = {
    type: "stdio",
    command: await stableNodePath(),
    args: [cliPath, "serve"],
    timeout: 120000,
    env: {
      LAZY_INTEL_TIMEOUT_MS: "30000",
      LAZY_INTEL_INDEX_TIMEOUT_MS: "600000",
      LAZY_INTEL_AUTO_INDEX: "true",
      LAZY_INTEL_AUTO_REPAIR: "true",
      LAZY_INTEL_MAINTENANCE_MS: "5000",
      LAZY_INTEL_ZVEC_MODE: "auto",
      LAZY_INTEL_SERENA_CONTEXT: "agent",
      SERENA_USAGE_REPORTING: "false",
      DO_NOT_TRACK: "1",
    },
  };
  // A project-scoped install pins the root; the global install follows OMP's session cwd.
  if (!options.global) entry.cwd = absolute;
  config.mcpServers["lazy-intel"] = entry;

  const disabled = new Set(config.disabledServers ?? []);
  const superseded = SUPERSEDED_SERVERS.filter((name) => name in config.mcpServers || disabled.has(name));
  for (const name of superseded) disabled.add(name);
  config.disabledServers = [...disabled];

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { configPath, superseded };
}
