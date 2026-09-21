/**
 * Parent <-> worker wire protocol.
 *
 * Carried on the Node IPC channel that `child_process.fork` creates, never on
 * stdout. The vendored libraries write progress and diagnostics to stdout and
 * stderr whenever they feel like it; if the protocol shared that stream, one
 * upstream `console.log` would corrupt a response. Keeping them apart means the
 * worker's stdout is only ever logging, and logging can never be parsed as data.
 */

import type { Outcome, WorkspaceId } from "../contracts.js";

/** Bumped only on an incompatible change; a mismatch fails the handshake. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Hard ceiling on one serialised message. Structured clone over IPC will happily
 * move a 200 MB result and stall the event loop for seconds; a bounded protocol
 * turns that into a typed `payload_too_large` instead of a stall.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export type WorkerKind = "retrieval" | "graph" | "semantic";

export interface WorkerHello {
  readonly type: "hello";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly kind: WorkerKind;
  /** Identifies this process instance. A restart produces a new epoch. */
  readonly workerEpoch: string;
  /** The upstream commit the loaded fork was built from, for evidence provenance. */
  readonly upstreamCommit: string;
  readonly pid: number;
}

export interface WorkerReady {
  readonly type: "ready";
  readonly workerEpoch: string;
}

export interface ParentRequest<T = unknown> {
  readonly type: "request";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly workspaceId: WorkspaceId;
  readonly operation: string;
  /**
   * What the parent still allows for this call. The parent stays authoritative:
   * a worker may shorten its own work but never extends the request budget.
   */
  readonly remainingBudgetMs: number;
  readonly payload: T;
}

export interface WorkerResponse<T = unknown> {
  readonly type: "response";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ok: true;
  readonly outcome: Outcome;
  readonly payload: T;
  readonly workMs: number;
}

export interface WorkerFailure {
  readonly type: "response";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ok: false;
  readonly code: WorkerErrorCode;
  readonly message: string;
  /** Whether the same call could plausibly succeed on a fresh worker. */
  readonly retryable: boolean;
  readonly workMs: number;
}

export type WorkerErrorCode =
  | "invalid_request"
  | "unsupported_operation"
  | "payload_too_large"
  | "deadline"
  | "backend_failed"
  | "not_initialized";

export interface ParentShutdown {
  readonly type: "shutdown";
  readonly reason: string;
}

export type ParentMessage = ParentRequest | ParentShutdown;
export type WorkerMessage = WorkerHello | WorkerReady | WorkerResponse | WorkerFailure;

/**
 * Byte size of a message once serialised.
 *
 * IPC uses JSON, so JSON length is the real transfer size — not a proxy for it.
 */
export function messageBytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message) ?? "", "utf8");
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "hello" || type === "ready" || type === "response";
}

export function isParentMessage(value: unknown): value is ParentMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "request" || type === "shutdown";
}
