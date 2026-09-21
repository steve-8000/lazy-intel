/**
 * The worker side of the protocol.
 *
 * A worker is a plain Node process that loads exactly one vendored fork entry and
 * answers requests on the IPC channel. It owns no policy: the parent decides the
 * budget, the workspace and which operation to run. Everything this module does
 * is keep that contract honest — one job at a time, bounded payloads, typed
 * failures, and a hard rule that protocol never touches stdout.
 */

import { randomUUID } from "node:crypto";

import type { Outcome } from "../contracts.js";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  isParentMessage,
  messageBytes,
  type ParentRequest,
  type WorkerErrorCode,
  type WorkerKind,
  type WorkerMessage,
} from "./protocol.js";

export interface HandlerContext {
  readonly requestId: string;
  readonly workspaceId: string;
  /** What the parent still allows. A worker may finish early; it may not extend this. */
  readonly remainingBudgetMs: number;
}

export interface HandlerResult<T> {
  readonly outcome: Outcome;
  readonly payload: T;
}

export type Handler = (payload: unknown, context: HandlerContext) => Promise<HandlerResult<unknown>>;

export interface ServeOptions {
  readonly kind: WorkerKind;
  /** Upstream commit of the fork this worker loaded, stamped into evidence provenance. */
  readonly upstreamCommit: string;
  readonly handlers: Readonly<Record<string, Handler>>;
  /** Released on shutdown; failures here are logged, never thrown at the parent. */
  readonly dispose?: () => Promise<void>;
}

/**
 * A backend failure the parent should see as typed rather than as a crash.
 *
 * Throwing a plain `Error` from a handler is also fine — it maps to
 * `backend_failed`. This class exists for the cases where the worker knows the
 * more specific code, such as an unsupported language or a missing index.
 */
export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly retryable: boolean;

  constructor(code: WorkerErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function send(message: WorkerMessage): void {
  // `process.send` exists because the parent forked us with an ipc channel. If it
  // is missing, the worker was started wrongly and has no way to answer anyone.
  if (typeof process.send !== "function") {
    process.stderr.write("lazy-intel worker started without an IPC channel\n");
    process.exit(78); // EX_CONFIG
  }
  process.send(message);
}

/**
 * Run the worker loop. Resolves only when the parent asks for shutdown or the
 * channel closes, so a worker entry can simply `await serveWorker(...)`.
 */
export async function serveWorker(options: ServeOptions): Promise<void> {
  const workerEpoch = randomUUID();
  // One job at a time. The vendored libraries do synchronous native work, so
  // interleaving requests inside one process buys no parallelism and makes the
  // deadline arithmetic a lie.
  let queue: Promise<void> = Promise.resolve();

  const respond = (requestId: string, result: HandlerResult<unknown>, workMs: number): void => {
    const message: WorkerMessage = { type: "response", requestId, workerEpoch, ok: true, outcome: result.outcome, payload: result.payload, workMs };
    const size = messageBytes(message);
    if (size > MAX_MESSAGE_BYTES) {
      // Truncating the payload here would silently change the answer. Reporting
      // the bound lets the parent ask for less instead of believing a short list.
      send({ type: "response", requestId, workerEpoch, ok: false, code: "payload_too_large", message: `response is ${size} bytes, limit is ${MAX_MESSAGE_BYTES}; narrow the request`, retryable: false, workMs });
      return;
    }
    send(message);
  };

  const handle = async (request: ParentRequest): Promise<void> => {
    const startedAt = performance.now();
    const handler = options.handlers[request.operation];
    if (!handler) {
      send({ type: "response", requestId: request.requestId, workerEpoch, ok: false, code: "unsupported_operation", message: `${options.kind} worker has no operation ${request.operation}`, retryable: false, workMs: 0 });
      return;
    }
    try {
      const result = await handler(request.payload, {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        remainingBudgetMs: request.remainingBudgetMs,
      });
      respond(request.requestId, result, Math.round(performance.now() - startedAt));
    } catch (error) {
      const workMs = Math.round(performance.now() - startedAt);
      if (error instanceof WorkerError) {
        send({ type: "response", requestId: request.requestId, workerEpoch, ok: false, code: error.code, message: error.message, retryable: error.retryable, workMs });
        return;
      }
      send({
        type: "response",
        requestId: request.requestId,
        workerEpoch,
        ok: false,
        code: "backend_failed",
        message: error instanceof Error ? error.message : String(error),
        // An unclassified backend throw may be input-specific or may be a broken
        // process; the parent's retry budget decides, not the worker.
        retryable: true,
        workMs,
      });
    }
  };

  const finished = new Promise<void>((resolve) => {
    process.on("message", (raw: unknown) => {
      if (!isParentMessage(raw)) return;
      if (raw.type === "shutdown") {
        resolve();
        return;
      }
      if (raw.workerEpoch !== workerEpoch) {
        // Addressed to a process we are not. Answering would let a stale parent
        // view mix with this one's.
        return;
      }
      queue = queue.then(() => handle(raw));
    });
    process.once("disconnect", () => resolve());
    // The parent supervises lifetime; a bare SIGTERM still drains the current job.
    process.once("SIGTERM", () => resolve());
  });

  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, kind: options.kind, workerEpoch, upstreamCommit: options.upstreamCommit, pid: process.pid });
  send({ type: "ready", workerEpoch });

  await finished;
  await queue.catch(() => {});
  if (options.dispose) {
    try {
      await options.dispose();
    } catch (error) {
      process.stderr.write(`lazy-intel ${options.kind} worker dispose failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
