/**
 * Long-lived private worker processes and the rules for talking to them.
 *
 * Three facts from the source review shape everything here.
 *
 * 1. The vendored libraries do real synchronous and native work. zvec-grep runs
 *    tree-sitter and embedding back ends; CodeGraph opens SQLite and spawns its
 *    own parse and store workers. Hosting them in the MCP process would let one
 *    native fault take down the tool, so each lives in its own child process.
 *
 * 2. `ZvecGrepContextOptions` has no `AbortSignal`
 *    (vendor/zvec-grep/src/engine/service/types.ts:82-113). A read therefore
 *    cannot be cancelled cooperatively. The honest model is: the *caller* has a
 *    deadline, the *job* has a lifetime, and they are not the same thing. When a
 *    caller gives up we abandon the job and discard whatever comes back. We never
 *    pretend the call aborted.
 *
 * 3. A cancelled caller must not damage a shared backend. Aborting during
 *    startup detaches that caller; the worker keeps starting for everyone else.
 *
 * Abandoned jobs are the pressure valve: a worker serves one job at a time, so
 * enough physical jobs still in flight after their callers leave means the worker
 * is wedged behind work nobody wants. Past `abandonedJobLimit` the supervisor
 * recycles the process, which is the only way to reclaim it when the library offers
 * no cancellation.
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { Outcome, WorkspaceId } from "../contracts.js";
import {
  MAX_MESSAGE_BYTES,
  isWorkerMessage,
  messageBytes,
  type ParentRequest,
  type WorkerErrorCode,
  type WorkerKind,
  type WorkerMessage,
} from "./protocol.js";

export interface SupervisorOptions {
  readonly kind: WorkerKind;
  /** Absolute path to the worker entry module. */
  readonly modulePath: string;
  readonly workspaceId: WorkspaceId;
  readonly env?: Readonly<Record<string, string>>;
  readonly execArgv?: readonly string[];
  readonly startupTimeoutMs?: number;
  /** Restarts allowed inside `restartWindowMs` before the worker is declared dead. */
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  /** Abandoned in-flight jobs tolerated before the process is recycled. */
  readonly abandonedJobLimit?: number;
  /** Diagnostics from the worker's stdout/stderr. Never protocol data. */
  readonly onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface CallContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Absolute `performance.now()` value at which the caller stops waiting. */
  readonly deadlineMonotonicMs: number;
  readonly workspaceId?: WorkspaceId;
}

export type CallResult<T> =
  | { readonly ok: true; readonly outcome: Outcome; readonly payload: T; readonly workerEpoch: string; readonly workMs: number }
  | { readonly ok: false; readonly code: WorkerErrorCode | "worker_failed" | "cancelled"; readonly message: string; readonly retryable: boolean; readonly workerEpoch: string | null };

interface PendingCall {
  readonly requestId: string;
  readonly workerEpoch: string;
  settle(message: WorkerMessage & { type: "response" }): void;
  fail(result: CallResult<never>): void;
}

interface PhysicalJob {
  readonly workerEpoch: string;
  abandoned: boolean;
}

const DEFAULTS = {
  startupTimeoutMs: 30_000,
  maxRestarts: 5,
  restartWindowMs: 60_000,
  abandonedJobLimit: 3,
} as const;

export class WorkerSupervisor {
  readonly #options: SupervisorOptions;
  #child: ChildProcess | null = null;
  #epoch: string | null = null;
  #upstreamCommit: string | null = null;
  #starting: Promise<{ child: ChildProcess; epoch: string }> | null = null;
  #startingChild: ChildProcess | null = null;
  #pending = new Map<string, PendingCall>();
  #physicalJobs = new Map<string, PhysicalJob>();
  #abandoned = 0;
  #restartTimes: number[] = [];
  #closed = false;
  #closing: Promise<void> | null = null;
  #deadReason: string | null = null;

  constructor(options: SupervisorOptions) {
    this.#options = options;
  }

  get epoch(): string | null {
    return this.#epoch;
  }

  get upstreamCommit(): string | null {
    return this.#upstreamCommit;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.connected;
  }

  get inFlight(): number {
    return this.#physicalJobs.size;
  }

  /**
   * Run one operation on the worker.
   *
   * Never throws for backend problems: a failure is a typed `CallResult` so the
   * engine can degrade one read instead of losing a whole request.
   */
  async call<Req, Res>(operation: string, payload: Req, context: CallContext): Promise<CallResult<Res>> {
    if (this.#closed) {
      return { ok: false, code: "worker_failed", message: `${this.#options.kind} worker is closed`, retryable: false, workerEpoch: null };
    }
    if (context.signal.aborted) {
      return { ok: false, code: "cancelled", message: "caller aborted before dispatch", retryable: false, workerEpoch: this.#epoch };
    }

    let started: { child: ChildProcess; epoch: string };
    try {
      started = await this.#ensureStarted(context.signal);
    } catch (error) {
      if (context.signal.aborted) {
        // The caller left during startup. The worker keeps starting for others.
        return { ok: false, code: "cancelled", message: "caller aborted during worker startup", retryable: false, workerEpoch: null };
      }
      return { ok: false, code: "worker_failed", message: error instanceof Error ? error.message : String(error), retryable: !this.#closed, workerEpoch: null };
    }
    if (this.#closed) return { ok: false, code: "worker_failed", message: `${this.#options.kind} worker is closed`, retryable: false, workerEpoch: null };
    if (context.signal.aborted) return { ok: false, code: "cancelled", message: "caller aborted before dispatch", retryable: false, workerEpoch: started.epoch };

    const remainingBudgetMs = Math.max(0, Math.round(context.deadlineMonotonicMs - performance.now()));
    if (remainingBudgetMs === 0) {
      return { ok: false, code: "deadline", message: "no budget left for this read", retryable: false, workerEpoch: started.epoch };
    }

    const request: ParentRequest<Req> = {
      type: "request",
      requestId: context.requestId,
      workerEpoch: started.epoch,
      workspaceId: context.workspaceId ?? this.#options.workspaceId,
      operation,
      remainingBudgetMs,
      payload,
    };

    const size = messageBytes(request);
    if (size > MAX_MESSAGE_BYTES) {
      return { ok: false, code: "payload_too_large", message: `request is ${size} bytes, limit is ${MAX_MESSAGE_BYTES}`, retryable: false, workerEpoch: started.epoch };
    }

    return await new Promise<CallResult<Res>>((resolve) => {
      let finished = false;
      const finish = (result: CallResult<Res>): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };

      const abandon = (): void => {
        const job = this.#physicalJobs.get(context.requestId);
        if (!job || job.abandoned) return;
        // The job keeps running: the library gave us no way to stop it. Mark it
        // so its eventual answer is discarded and the pressure is counted.
        job.abandoned = true;
        this.#abandoned += 1;
        if (this.#abandoned >= (this.#options.abandonedJobLimit ?? DEFAULTS.abandonedJobLimit)) {
          void this.#recycle(`${this.#abandoned} abandoned jobs`);
        }
      };

      const onAbort = (): void => {
        abandon();
        finish({ ok: false, code: "cancelled", message: "caller aborted while the read was in flight", retryable: false, workerEpoch: started.epoch });
      };

      const budgetTimer = setTimeout(() => {
        abandon();
        finish({ ok: false, code: "deadline", message: `read exceeded its ${remainingBudgetMs}ms share of the request budget`, retryable: false, workerEpoch: started.epoch });
      }, remainingBudgetMs);
      budgetTimer.unref?.();

      const cleanup = (): void => {
        clearTimeout(budgetTimer);
        context.signal.removeEventListener("abort", onAbort);
        this.#pending.delete(context.requestId);
      };

      this.#pending.set(context.requestId, {
        requestId: context.requestId,
        workerEpoch: started.epoch,
        settle: (message) => {
          if (message.ok) {
            finish({ ok: true, outcome: message.outcome, payload: message.payload as Res, workerEpoch: message.workerEpoch, workMs: message.workMs });
          } else {
            const failure = message as Extract<WorkerMessage, { type: "response"; ok: false }>;
            finish({ ok: false, code: failure.code, message: failure.message, retryable: failure.retryable, workerEpoch: failure.workerEpoch });
          }
        },
        fail: (result) => finish(result as CallResult<Res>),
      });
      this.#physicalJobs.set(context.requestId, { workerEpoch: started.epoch, abandoned: false });

      context.signal.addEventListener("abort", onAbort, { once: true });
      started.child.send(request, (error) => {
        if (error) {
          this.#dropPhysicalJob(context.requestId, started.epoch);
          finish({ ok: false, code: "worker_failed", message: `send failed: ${error.message}`, retryable: true, workerEpoch: started.epoch });
        }
      });
    });
  }

  close(): Promise<void> {
    return this.#closing ??= this.#closeOwned();
  }

  async #closeOwned(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    const starting = this.#starting;
    const startingChild = this.#startingChild;
    this.#child = null;
    this.#epoch = null;
    this.#physicalJobs.clear();
    this.#abandoned = 0;
    for (const entry of this.#pending.values()) {
      entry.fail({ ok: false, code: "worker_failed", message: "supervisor closed", retryable: false, workerEpoch: entry.workerEpoch });
    }
    this.#pending.clear();

    const children = new Set<ChildProcess>();
    if (child) children.add(child);
    if (startingChild) children.add(startingChild);
    const termination = Promise.all([...children].map((owned) => this.#terminate(owned)));
    if (starting) await starting.catch(() => {});
    await termination;
  }

  async #ensureStarted(signal: AbortSignal): Promise<{ child: ChildProcess; epoch: string }> {
    if (this.#deadReason) throw new Error(this.#deadReason);
    if (this.#child && this.#child.connected && this.#epoch) return { child: this.#child, epoch: this.#epoch };
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
      this.#startingChild = null;
    });
    // Race the shared startup against this caller's abort, so one impatient caller
    // never cancels a start that other callers are also waiting on.
    let onAbort!: () => void;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const started = await Promise.race([this.#starting, abortPromise]);
      if (this.#closed) {
        await this.#terminate(started.child);
        throw new Error("supervisor closed during worker startup");
      }
      return started;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #start(): Promise<{ child: ChildProcess; epoch: string }> {
    const options = this.#options;
    const child = fork(options.modulePath, [], {
      // `ipc` is a separate channel from stdout: upstream logging can never be
      // mistaken for protocol, and protocol can never be mistaken for logging.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, ...options.env, LAZY_INTEL_WORKER_KIND: options.kind },
      execArgv: options.execArgv ? [...options.execArgv] : [],
      serialization: "json",
    });
    this.#startingChild = child;

    for (const [stream, source] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      source?.setEncoding("utf8");
      source?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim().length > 0) options.onLog?.(line, stream);
        }
      });
    }

    const handshake = new Promise<{ child: ChildProcess; epoch: string }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const failStartup = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(reason));
        child.kill("SIGKILL");
      };
      timer = setTimeout(() => {
        failStartup(options.kind + " worker did not report ready within " + (options.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs) + "ms");
      }, options.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs);
      timer.unref?.();

      let epoch: string | null = null;
      child.on("message", (raw: unknown) => {
        const type = typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as { type?: unknown }).type
          : undefined;
        if (type === "hello") {
          if (!isWorkerMessage(raw) || raw.type !== "hello") {
            failStartup("invalid " + options.kind + " worker hello");
            return;
          }
          if (raw.kind !== options.kind) {
            failStartup(options.kind + " worker reported kind " + raw.kind);
            return;
          }
          if (raw.pid !== child.pid) {
            failStartup(options.kind + " worker reported pid " + raw.pid + ", expected " + child.pid);
            return;
          }
          if (epoch !== null) {
            failStartup(options.kind + " worker reported hello more than once");
            return;
          }
          epoch = raw.workerEpoch;
          this.#upstreamCommit = raw.upstreamCommit;
          return;
        }
        if (type === "ready") {
          if (!isWorkerMessage(raw) || raw.type !== "ready") {
            failStartup("invalid " + options.kind + " worker ready");
            return;
          }
          if (epoch === null) {
            failStartup(options.kind + " worker reported ready before hello");
            return;
          }
          if (raw.workerEpoch !== epoch) {
            failStartup(options.kind + " worker ready epoch did not match hello");
            return;
          }
          if (this.#closed) {
            failStartup("supervisor closed during worker startup");
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#child = child;
          this.#epoch = epoch;
          resolve({ child, epoch });
          return;
        }
        if (!isWorkerMessage(raw)) return;
        if (raw.type === "response") this.#onResponse(raw);
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(this.#closed ? "supervisor closed during worker startup" : error.message));
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(this.#closed ? "supervisor closed during worker startup" : options.kind + " worker exited during startup (code=" + code + " signal=" + signal + ")"));
        }
        this.#onExit(child, code, signal);
      });
    });

    return await handshake;
  }

  #onResponse(message: WorkerMessage & { type: "response" }): void {
    const job = this.#physicalJobs.get(message.requestId);
    if (!job) return;
    const entry = this.#pending.get(message.requestId);
    if (!entry) {
      this.#physicalJobs.delete(message.requestId);
      if (job.abandoned) this.#abandoned = Math.max(0, this.#abandoned - 1);
      return;
    }
    if (entry.workerEpoch !== message.workerEpoch || job.workerEpoch !== message.workerEpoch) {
      // A stale reply must be dropped before the live physical job or pending
      // call is mutated. A valid current-epoch reply for the same request may
      // still arrive and must be allowed to settle it.
      return;
    }
    this.#physicalJobs.delete(message.requestId);
    if (job.abandoned) this.#abandoned = Math.max(0, this.#abandoned - 1);
    entry.settle(message);
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = null;
    const epoch = this.#epoch;
    this.#epoch = null;
    for (const [requestId, job] of this.#physicalJobs) {
      if (job.workerEpoch === epoch) this.#physicalJobs.delete(requestId);
    }
    this.#abandoned = 0;

    for (const entry of this.#pending.values()) {
      if (entry.workerEpoch !== epoch) continue;
      entry.fail({
        ok: false,
        code: "worker_failed",
        message: `${this.#options.kind} worker exited (code=${code} signal=${signal})`,
        // A crash on one input is worth one retry on a fresh process; the engine
        // decides whether to spend budget on it.
        retryable: true,
        workerEpoch: entry.workerEpoch,
      });
    }

    if (this.#closed) return;
    const now = Date.now();
    const window = this.#options.restartWindowMs ?? DEFAULTS.restartWindowMs;
    this.#restartTimes = this.#restartTimes.filter((at) => now - at < window);
    this.#restartTimes.push(now);
    if (this.#restartTimes.length > (this.#options.maxRestarts ?? DEFAULTS.maxRestarts)) {
      // Crash-looping. Staying down and reporting `unavailable` is better than
      // burning the machine respawning a worker that cannot serve.
      this.#deadReason = `${this.#options.kind} worker crashed ${this.#restartTimes.length} times in ${window}ms and will not be restarted automatically`;
    }
  }

  /** Replace the process. In-flight callers of the old epoch already have their answer. */
  async #recycle(reason: string): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const epoch = this.#epoch;
    this.#child = null;
    this.#epoch = null;
    for (const [requestId, job] of this.#physicalJobs) {
      if (job.workerEpoch === epoch) this.#physicalJobs.delete(requestId);
    }
    this.#abandoned = 0;
    this.#options.onLog?.(`recycling ${this.#options.kind} worker: ${reason}`, "stderr");
    await this.#terminate(child);
  }

  #dropPhysicalJob(requestId: string, workerEpoch: string): void {
    const job = this.#physicalJobs.get(requestId);
    if (!job || job.workerEpoch !== workerEpoch) return;
    this.#physicalJobs.delete(requestId);
    if (job.abandoned) this.#abandoned = Math.max(0, this.#abandoned - 1);
  }

  /** SIGTERM, then SIGKILL. The promise resolves on exit, not on signal delivery. */
  async #terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const result = await Promise.race([exited.then(() => "exited" as const), delay(2_000, "timeout" as const, { ref: false })]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

/** Every supervisor creates its own request ids; callers may pass their own. */
export function newRequestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
