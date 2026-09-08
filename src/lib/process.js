import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN_ENV = { zg: "LAZY_INTEL_ZG_BIN", codegraph: "LAZY_INTEL_CODEGRAPH_BIN", serena: "LAZY_INTEL_SERENA_BIN" };
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

export async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function binName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function localBin(name) {
  return path.resolve(process.cwd(), "node_modules", ".bin", binName(name));
}

// Pinned project-local CLIs win over anything on PATH so the runtime matches upstreams.lock.json.
export async function resolveBin(name) {
  const override = process.env[BIN_ENV[name] ?? ""];
  if (override) return override;
  const candidates = [
    path.resolve(repoRoot, "node_modules", ".bin", binName(name)),
    localBin(name),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return name;
}

export function run(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 30_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    signal,
    stdin,
  } = options;

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    let timedOut = false;

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      if (!settled) child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs) : null;
    timer?.unref();

    const capture = (target, chunk) => {
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout += value;
      else stderr += value;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
        overflow = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (c) => capture("stdout", c));
    child.stderr.on("data", (c) => capture("stderr", c));
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, sig) => {
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        signal: sig,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        overflow,
        timedOut,
        latencyMs: Math.round(performance.now() - started),
      };
      if (timedOut) {
        reject(Object.assign(new Error(`${path.basename(command)} ${args[0] ?? ""} timed out after ${timeoutMs}ms`.trim()), { result }));
      } else if (overflow) {
        reject(Object.assign(new Error(`process output exceeded ${maxOutputBytes} bytes`), { result }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(stderr.trim() || `${command} exited ${code}`), { result }));
      } else {
        resolve(result);
      }
    });

    if (stdin != null) {
      child.stdin.end(stdin);
    }
  });
}
