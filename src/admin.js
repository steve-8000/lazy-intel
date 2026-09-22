import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexStatus, ensureIndexes, reindexIndexes } from "./index-manager.js";
import { pathExists } from "./lib/process.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// OMP must expose exactly one code-intelligence MCP; the standalone backends are subsumed.
const SUPERSEDED_SERVERS = ["zvec-grep", "codegraph", "serena"];


async function engineRange() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  return pkg.engines?.node ?? "";
}

export async function doctor(root = process.cwd()) {
  const rows = [];
  const range = await engineRange();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeMinor = Number(process.versions.node.split(".")[1]);
  const nodeOk = (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5)) && nodeMajor < 25;
  rows.push({ item: "node", ok: nodeOk, detail: `${process.version} (${process.execPath}); required ${range}` });

  rows.push({ item: "engine", ok: true, detail: "unified embedded forks; rollback requires the previous binary and its separate state" });
  rows.push(await vendorRow());


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

/**
 * The vendored forks and whether they are built. In unified mode an unbuilt
 * vendor tree is a hard fault: the query path has nothing to load.
 */
async function vendorRow() {
  const lock = JSON.parse(await readFile(path.join(repoRoot, "upstreams.lock.json"), "utf8"));
  const parts = [];
  let built = true;
  for (const [name, entry] of Object.entries(lock.upstreams)) {
    if (!entry.vendor) continue;
    let revision = "no ledger";
    try {
      const ledger = JSON.parse(await readFile(path.join(repoRoot, entry.ledger), "utf8"));
      revision = `patch ${ledger.patch_revision ?? 0}`;
    } catch { /* reported as "no ledger" below */ }
    parts.push(`${name}@${entry.commit.slice(0, 12)} (${revision})`);
  }
  for (const artefact of ["packages/core/dist/index.js", "vendor/zvec-grep/dist/lazy-entry.js", "vendor/codegraph/dist/lazy-entry.js"]) {
    if (!(await pathExists(path.join(repoRoot, artefact)))) built = false;
  }
  return {
    item: "vendored forks",
    ok: built,
    detail: `${parts.join(", ")}; build ${built ? "present" : "MISSING — run npm run build"}`,
  };
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
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (config.mcpServers != null && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))
    || (config.disabledServers != null && (!Array.isArray(config.disabledServers) || config.disabledServers.some((name) => typeof name !== "string")))) {
    throw new Error(`invalid OMP configuration: ${configPath}`);
  }
  config.$schema ??= "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
  config.mcpServers ??= {};

  const cliPath = path.join(repoRoot, "src", "cli.js");
  const entry = {
    type: "stdio",
    command: await stableNodePath(),
    args: [cliPath, "serve"],
    timeout: 1920000,
    env: {
      LAZY_INTEL_TIMEOUT_MS: "30000",
      LAZY_INTEL_INDEX_TIMEOUT_MS: "600000",
      LAZY_INTEL_AUTO_INDEX: "true",
      LAZY_INTEL_AUTO_REPAIR: "true",
      LAZY_INTEL_MAINTENANCE_MS: "5000",
      SERENA_USAGE_REPORTING: "false",
      DO_NOT_TRACK: "1",
      ...config.mcpServers["lazy-intel"]?.env,
    },
  };
  // Settings that only meant something when the backends were external executables.
  const obsolete = ["LAZY_INTEL_ZVEC_MODE", "LAZY_INTEL_SERENA_CONTEXT", "LAZY_INTEL_SERENA_BIN", "LAZY_INTEL_ZG_BIN", "LAZY_INTEL_CODEGRAPH_BIN"];
  for (const key of obsolete) delete entry.env[key];
  // A project-scoped install pins the root; the global install follows OMP's session cwd.
  if (!options.global) entry.cwd = absolute;
  config.mcpServers["lazy-intel"] = entry;

  const disabled = new Set(config.disabledServers ?? []);
  for (const name of SUPERSEDED_SERVERS) {
    delete config.mcpServers[name];
    disabled.add(name); // Prevent other harness configuration sources from reconnecting it.
  }
  config.disabledServers = [...disabled];

  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, configPath);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(configPath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return { configPath };
}
