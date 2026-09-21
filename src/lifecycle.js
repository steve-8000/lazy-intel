import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveBin, run } from "./lib/process.js";

const EXPLICIT_EMBEDDING = process.env.LAZY_INTEL_EMBEDDING || undefined;
const ZVEC_MODE = process.env.LAZY_INTEL_ZVEC_MODE ?? "auto";

// The shared zvec-grep configuration is the single source of truth for the vector space.
export async function configuredEmbedding() {
  if (process.env.ZVEC_GREP_EMBEDDING) return process.env.ZVEC_GREP_EMBEDDING;
  const home = process.env.ZVEC_GREP_HOME || path.join(homedir(), ".zvec-grep");
  try {
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    return config?.defaults?.embedding ?? null;
  } catch {
    return null;
  }
}

async function cliRun(backend, root, args, { signal, timeoutMs }, tolerateFailure = false) {
  const command = await resolveBin(backend === "zvec" ? "zg" : "codegraph");
  const env = backend === "codegraph" ? { DO_NOT_TRACK: "1" } : {};
  try {
    return await run(command, args, {
      cwd: root,
      timeoutMs,
      signal,
      maxOutputBytes: 8 * 1024 * 1024,
      env,
    });
  } catch (error) {
    if (tolerateFailure && error.result) return error.result;
    throw error;
  }
}

function firstLine(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? null;
}

function pickLine(text, pattern) {
  return text.split("\n").map((line) => line.trim()).find((line) => pattern.test(line)) ?? firstLine(text);
}

function makeCliDriver(backend) {
  return {
    async probe(root, { signal, timeoutMs }) {
      if (backend === "zvec") {
        const result = await cliRun(backend, root, ["status", root, "--mode", ZVEC_MODE, "--check-ready"], { signal, timeoutMs }, true);
        const text = `${result.stdout}\n${result.stderr}`;
        const building = /state:\s*(indexing|updating)|index is (updating|indexing)/i.test(text);
        const absent = /not configured|no workspace index/i.test(text);
        return { present: !absent, ready: result.code === 0, building: building && !absent, detail: firstLine(text) };
      }
      const result = await cliRun(backend, root, ["status", root], { signal, timeoutMs }, true);
      const text = `${result.stdout}\n${result.stderr}`;
      const absent = /not initialized|not configured/i.test(text);
      return { present: !absent, ready: result.code === 0 && !absent, building: false, detail: pickLine(text, /not initialized|not configured|symbols?|files?|up to date|stale|last index/i) };
    },

    async create(root, { signal, timeoutMs, embedding }) {
      if (backend === "zvec") {
        const selectedEmbedding = embedding ?? EXPLICIT_EMBEDDING ?? await configuredEmbedding();
        if (!selectedEmbedding) {
          throw new Error("no zvec embedding available: set LAZY_INTEL_EMBEDDING or ZVEC_GREP_EMBEDDING, or configure a default with `zg config model set <model>` (a new index cannot pick a model on its own)");
        }
        const args = ["index", root, "--mode", ZVEC_MODE];
        if (embedding ?? EXPLICIT_EMBEDDING) args.push("--embedding", embedding ?? EXPLICIT_EMBEDDING);
        await cliRun(backend, root, args, { signal, timeoutMs });
      } else {
        await cliRun(backend, root, ["init", root], { signal, timeoutMs });
      }
    },

    async refresh(root, { signal, timeoutMs }) {
      await cliRun(backend, root, backend === "zvec" ? ["index", root, "--mode", ZVEC_MODE] : ["sync", root], { signal, timeoutMs });
    },

    async rebuild(root, { signal, timeoutMs, embedding }) {
      if (backend === "zvec") {
        const args = ["index", root, "--mode", ZVEC_MODE, "--rebuild"];
        if (embedding ?? EXPLICIT_EMBEDDING) args.push("--embedding", embedding ?? EXPLICIT_EMBEDDING);
        await cliRun(backend, root, args, { signal, timeoutMs });
      } else {
        await cliRun(backend, root, ["index", root], { signal, timeoutMs });
      }
    },
  };
}

/**
 * The manager memoizes one driver per backend, so the embedding lookup and the
 * dynamic import here happen once rather than on every ensure.
 */
export async function getDriver(backend) {
  if (process.env.LAZY_INTEL_ENGINE !== "unified") return makeCliDriver(backend);

  // Dynamic because unified imports index-manager, which imports this module. A
  // static edge would run the manager's policy through a half-initialized unified.
  const { embeddedLifecycle } = await import("./unified.js");
  const embedding = EXPLICIT_EMBEDDING ?? await configuredEmbedding();
  return {
    probe: (root, options) => embeddedLifecycle(root, backend, "probe", options, { embedding }),
    create: (root, options) => embeddedLifecycle(root, backend, "create", options, { embedding }),
    refresh: (root, options) => embeddedLifecycle(root, backend, "refresh", options, { embedding }),
    rebuild: (root, options) => embeddedLifecycle(root, backend, "rebuild", options, { embedding }),
  };
}
