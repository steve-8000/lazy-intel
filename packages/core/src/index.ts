/**
 * Public surface of the lazy-intel control plane.
 *
 * Everything the engine and the workers share lives behind this entry so the
 * fork boundary stays in one place: `src/**` (the MCP product) never imports a
 * vendored module directly, and a worker never imports the product.
 */
export * from "./contracts.js";

export * from "./runtime/protocol.js";
export { WorkerSupervisor, newRequestId } from "./runtime/supervisor.js";
export type { SupervisorOptions, CallContext, CallResult } from "./runtime/supervisor.js";
export { WorkerPool } from "./runtime/pool.js";
export type { WorkerPoolOptions } from "./runtime/pool.js";
export { serveWorker, WorkerError } from "./runtime/worker-client.js";
export type { Handler, HandlerContext, HandlerResult, ServeOptions } from "./runtime/worker-client.js";
export { stagePreparedBatch, readPreparedBatch } from "./runtime/prepared.js";
export type { PreparedBatchPart, PreparedBatchReference } from "./runtime/prepared.js";

export { createRetrievalAdapter } from "./adapters/retrieval.js";
export type { RetrievalAdapter, RetrievalAdapterOptions } from "./adapters/retrieval.js";
export { createGraphAdapter } from "./adapters/graph.js";
export type { GraphAdapterOptions } from "./adapters/graph.js";
export { createSemanticAdapter } from "./adapters/semantic.js";
export type { SemanticAdapterOptions } from "./adapters/semantic.js";

export { WorkspaceRuntime, openWorkspaceRuntime } from "./workspace/runtime.js";
export type { WorkspaceRuntimeHandle, WorkspaceRuntimeOptions } from "./workspace/runtime.js";
export { WorkspaceJournal } from "./workspace/journal.js";
export type { JournalAck, JournalEntry, JournalIntent, JournalOperation, JournalRecord, JournalReplayHandlers, JournalScan } from "./workspace/journal.js";
export { buildCapturedManifest, captureManifest, captureSnapshotSet, captureSourceSnapshots, captureWorkspaceSnapshot, discoverWorkspaceFiles } from "./workspace/snapshots.js";
export type { SnapshotCaptureOptions, SnapshotFileInput, SnapshotSet, WorkspaceSnapshotOptions } from "./workspace/snapshots.js";
export { PublicationCoordinator, PublicationCrash, PublicationNotReadable } from "./workspace/publication.js";
export type { ProjectionRead, PublicationFailurePoint, PublicationOptions, PublicationStatus, PublicationBatch, PublicationReadLease, ApplyProjection } from "./workspace/publication.js";

export { addNativeAlias, canonicalAnchorKey, createCanonicalAnchor, evidenceAnchorsAgree, evidenceIdentity, mergeEvidence } from "./evidence/identity.js";
export type { CanonicalAnchorInput } from "./evidence/identity.js";
