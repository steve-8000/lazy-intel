import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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

// Only explicit absolute overrides or our installed dependencies are executable trust roots.
// Never search cwd or PATH: either can contain an untrusted project's fake backend.
export async function resolveBin(name) {
  const key = BIN_ENV[name];
  if (!key) throw new Error(`unsupported backend executable: ${name}`);
  const override = process.env[key];
  const candidate = override || (name === "serena"
    ? path.join(homedir(), ".local", "bin", binName(name))
    : path.join(repoRoot, "node_modules", ".bin", binName(name)));
  if (!path.isAbsolute(candidate)) throw new Error(`${key} must be an absolute executable path`);
  const executable = await realpath(candidate);
  if (!(await stat(executable)).isFile()) throw new Error(`${key} is not a file: ${executable}`);
  await access(executable, constants.X_OK);
  return executable;
}

export function run(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 30_000,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    signal,
    stdin,
    ownProcessGroup = true,
  } = options;

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      detached: ownProcessGroup,
    });
    const outputLimit = Math.max(0, Number.isFinite(maxOutputBytes) ? maxOutputBytes : DEFAULT_MAX_OUTPUT);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let overflow = false;
    let timedOut = false;
    let requestSettled = false;
    let childClosed = false;
    let childExited = false;
    let exitCode = null;
    let exitSignal = null;
    let terminationReason = null;
    let killTimer = null;
    let cleanupTimer = null;
    let timer = null;
    const result = {
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      overflow: false,
      timedOut: false,
      killedBy: null,
      latencyMs: 0,
    };

    const updateResult = (code = exitCode, sig = exitSignal, flush = false) => {
      result.code = code;
      result.signal = sig;
      result.stdout = flush ? `${stdout}${stdoutDecoder.end()}` : stdout;
      result.stderr = flush ? `${stderr}${stderrDecoder.end()}` : stderr;
      result.overflow = overflow;
      result.timedOut = timedOut;
      result.killedBy = terminationReason === "abort" || terminationReason === "timeout" || terminationReason === "overflow"
        ? terminationReason
        : null;
      result.latencyMs = Math.round(performance.now() - started);
      return result;
    };

    const sendSignal = (sig) => {
      try {
        if (ownProcessGroup && child.pid != null) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // The group can disappear between escalation steps.
      }
    };

    const makeAbortError = () => {
      const reason = signal?.reason;
      if (reason instanceof Error) return reason;
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      return error;
    };

    const settleTermination = (reason, cause) => {
      if (requestSettled) return;
      requestSettled = true;
      const current = updateResult();
      if (reason === "timeout") {
        reject(Object.assign(new Error(`${path.basename(command)} ${args[0] ?? ""} timed out after ${timeoutMs}ms`.trim()), { result: current }));
      } else if (reason === "overflow") {
        reject(Object.assign(new Error(`process output exceeded ${outputLimit} bytes`), { result: current }));
      } else if (reason === "abort") {
        reject(Object.assign(makeAbortError(), { result: current }));
      } else {
        reject(Object.assign(cause ?? new Error("process terminated"), { result: current }));
      }
    };

    const terminate = (reason, cause) => {
      if (terminationReason) return;
      terminationReason = reason;
      timedOut = reason === "timeout";
      if (reason === "overflow") overflow = true;
      sendSignal("SIGTERM");
      settleTermination(reason, cause);
      killTimer = setTimeout(() => {
        if (!childClosed && !childExited) sendSignal("SIGKILL");
      }, 500);
      killTimer.unref?.();
      cleanupTimer = setTimeout(() => {
        if (!childClosed && !childExited) {
          console.warn(`[lazy-intel] child process pid ${child.pid ?? "unknown"} was not reaped within 1000ms`);
        }
      }, 1000);
      cleanupTimer.unref?.();
    };

    const capture = (target, chunk) => {
      outputBytes += chunk.length;
      if (overflow) return;
      const remaining = Math.max(0, outputLimit - (outputBytes - chunk.length));
      const kept = Math.min(chunk.length, remaining);
      if (kept > 0) {
        const part = chunk.subarray(0, kept);
        if (target === "stdout") stdout += stdoutDecoder.write(part);
        else stderr += stderrDecoder.write(part);
      }
      if (outputBytes > outputLimit) terminate("overflow");
    };
    child.stdout.on("data", (c) => capture("stdout", c));
    child.stderr.on("data", (c) => capture("stderr", c));
    const onAbort = () => terminate("abort");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (requestSettled) return;
      requestSettled = true;
      reject(error);
    });
    child.on("exit", (code, sig) => {
      childExited = true;
      exitCode = code;
      exitSignal = sig;
      clearTimeout(killTimer);
      clearTimeout(cleanupTimer);
      killTimer = null;
      cleanupTimer = null;
    });
    child.on("close", (code, sig) => {
      childClosed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", onAbort);
      const finalResult = updateResult(code, sig, true);
      if (requestSettled) return;
      requestSettled = true;
      if (finalResult.timedOut) {
        reject(Object.assign(new Error(`${path.basename(command)} ${args[0] ?? ""} timed out after ${timeoutMs}ms`.trim()), { result: finalResult }));
      } else if (finalResult.overflow) {
        reject(Object.assign(new Error(`process output exceeded ${outputLimit} bytes`), { result: finalResult }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(finalResult.stderr || `${command} exited ${code}`), { result: finalResult }));
      } else {
        resolve(finalResult);
      }
    });

    if (stdin != null) {
      child.stdin.on("error", (error) => terminate("stdin", error));
      child.stdin.end(stdin);
    }

    timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => terminate("timeout"), timeoutMs) : null;
    timer?.unref();
  });
}
