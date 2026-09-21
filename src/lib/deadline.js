import { BackendError } from "../contracts.js";

/**
 * One monotonic budget per request.
 *
 * The clock starts when the request is admitted, not when a backend finally gets a turn:
 * queue waiting and the single transport retry spend the same budget, so a slow queue can
 * never silently extend the deadline the caller asked for. Every downstream step takes
 * `min(local cap, remaining)` instead of its own independent timeout.
 */

export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 3_600_000;

/**
 * Default whole-request ceiling.
 *
 * Deliberately generous: a first index build legitimately takes minutes, and cutting it to
 * an arbitrary 30s would break the existing cold-start path. A caller that wants a tight
 * bound passes requestTimeoutMs explicitly.
 */
export function defaultRequestTimeoutMs({ indexTimeoutMs, timeoutMs }) {
  return Math.min(MAX_REQUEST_TIMEOUT_MS, indexTimeoutMs + 2 * timeoutMs + 1_000);
}

export class RequestTimeoutError extends Error {
  constructor(elapsedMs, budgetMs) {
    super(`request exceeded its ${budgetMs}ms deadline after ${elapsedMs}ms`);
    this.name = "RequestTimeoutError";
    this.code = "TIMEOUT";
  }
}

export class RequestCancelledError extends Error {
  constructor(reason) {
    super("request cancelled by the client");
    this.name = "RequestCancelledError";
    this.code = "CANCELLED";
    if (reason !== undefined) this.cause = reason;
  }
}

/**
 * @param {object} options
 * @param {AbortSignal} [options.signal] Peer cancellation from the MCP layer.
 * @param {number} options.requestTimeoutMs Whole-request ceiling in milliseconds.
 * @param {() => number} [options.clock] Monotonic clock, injectable for tests.
 */
export function createDeadline({ signal, requestTimeoutMs, clock = () => performance.now() } = {}) {
  const budgetMs = Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, requestTimeoutMs ?? MAX_REQUEST_TIMEOUT_MS));
  const startedAtMonoMs = clock();
  const deadlineMonoMs = startedAtMonoMs + budgetMs;
  const controller = new AbortController();

  /** @type {"cancelled" | "timeout" | null} */
  let stopKind = null;

  const onParentAbort = () => {
    if (stopKind) return;
    stopKind = "cancelled";
    controller.abort(new RequestCancelledError(signal?.reason));
  };

  const fire = () => {
    if (stopKind) return;
    stopKind = "timeout";
    controller.abort(new RequestTimeoutError(Math.round(clock() - startedAtMonoMs), budgetMs));
  };

  let timer = setTimeout(fire, budgetMs);
  timer.unref?.();

  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const deadline = {
    startedAtMonoMs,
    deadlineMonoMs,
    budgetMs,
    signal: controller.signal,
    /** Peer cancellation and local timeout are different causes and are recorded as such. */
    get stopKind() { return stopKind; },
    elapsedMs() { return Math.round(clock() - startedAtMonoMs); },
    remainingMs() { return Math.max(0, Math.round(deadlineMonoMs - clock())); },
    expired() { return clock() >= deadlineMonoMs; },
    /**
     * Budget for the next step. Returns `min(localCapMs, remaining)` and refuses to start
     * work that cannot finish: a zero-length timeout is an immediate failure, not a hang.
     */
    budget(localCapMs) {
      deadline.throwIfStopped();
      const remaining = deadline.remainingMs();
      if (remaining <= 0) throw new RequestTimeoutError(deadline.elapsedMs(), budgetMs);
      return Math.max(1, Math.min(localCapMs, remaining));
    },
    /** True when a step of at least `minimumMs` still fits inside the budget. */
    affords(minimumMs) {
      return !stopKind && deadline.remainingMs() >= minimumMs;
    },
    throwIfStopped() {
      if (stopKind === "cancelled") throw new RequestCancelledError(signal?.reason);
      if (stopKind === "timeout") throw new RequestTimeoutError(deadline.elapsedMs(), budgetMs);
      if (deadline.expired()) {
        fire();
        throw new RequestTimeoutError(deadline.elapsedMs(), budgetMs);
      }
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener("abort", onParentAbort);
    },
  };
  return deadline;
}

/**
 * Classify a thrown abort.
 *
 * An `AbortError` name alone proves nothing: a backend CLI that exits on SIGTERM raises the
 * same name as a real client cancellation. The parent signal state and the deadline's own
 * stop kind are the evidence.
 */
export function classifyAbort(error, deadline) {
  if (error instanceof RequestCancelledError) return "CANCELLED";
  if (error instanceof RequestTimeoutError) return "TIMEOUT";
  if (deadline?.stopKind === "cancelled") return "CANCELLED";
  if (deadline?.stopKind === "timeout") return "TIMEOUT";
  if (error?.code === "CANCELLED" || error?.code === "TIMEOUT") return error.code;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "TIMEOUT";
  return null;
}

/** Convert any thrown value into a taxonomy code for envelope construction. */
export function errorCodeFor(error, deadline) {
  const aborted = classifyAbort(error, deadline);
  if (aborted) return aborted;
  if (error instanceof BackendError) return error.code;
  if (error?.result?.timedOut) return "TIMEOUT";
  if (error?.result?.overflow) return "OUTPUT_LIMIT";
  return "INTERNAL_ERROR";
}
