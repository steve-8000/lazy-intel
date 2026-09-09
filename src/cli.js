#!/usr/bin/env node
import process from "node:process";
import { startMcpServer } from "./mcp/server.js";
import { doctor, initProject, installOmp } from "./admin.js";

const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "serve":
      startMcpServer();
      break;
    case "doctor": {
      const root = args[0] ?? process.cwd();
      const rows = await doctor(root);
      printRows(rows);
      if (rows.some((r) => !r.ok)) process.exitCode = 1;
      break;
    }
    case "init": {
      const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
      const embedding = option(args, "--embedding");
      const rebuild = args.includes("--rebuild");
      const rows = await initProject(root, { embedding, rebuild });
      for (const row of rows) console.log(`${row.backend}: ${row.action}${row.detail ? `\n${row.detail}` : ""}`);
      break;
    }
    case "install-omp": {
      const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
      const { configPath } = await installOmp(root, { global: args.includes("--global") });
      console.log(configPath);
      console.log("OMP: run /mcp reload, then /mcp test lazy-intel");
      break;
    }
    case "version":
    case "--version":
    case "-v":
      console.log("lazy-intel 0.2.0");
      break;
    default:
      help();
      if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 2;
  }
} catch (error) {
  console.error(`lazy-intel: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function printRows(rows) {
  for (const r of rows) console.log(`${r.ok ? "OK " : "ERR"}  ${r.item.padEnd(16)} ${r.detail ?? ""}`);
}
function help() {
  console.log(`lazy-intel 0.2.0

Usage:
  lazy-intel serve
  lazy-intel doctor [project-root]
  lazy-intel init [project-root] [--embedding MODEL] [--rebuild]   # optional; runtime auto-indexes
  lazy-intel install-omp [project-root] [--global]   # --global writes ~/.omp/agent/mcp.json
  lazy-intel version

Runtime ownership:
  Sharpshooter = memory
  zvec-grep    = semantic/hybrid workspace retrieval
  CodeGraph    = architecture/call-path/impact
  Serena       = live LSP symbol semantics
  OMP native   = source/edit/build/test truth

Indexes are autonomous: startup/first-query create, file-change sync, background repair.
Agent control is available through code_intel status/sync/reindex/repair.
`);
}
