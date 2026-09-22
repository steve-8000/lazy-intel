import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { createZvecGrep, LAZY_INTEL_ZVEC_UPSTREAM_COMMIT } from "../../vendor/zvec-grep/dist/lazy-entry.js";
import { serveWorker, WorkerError, readPreparedBatch } from "../../packages/core/dist/index.js";

const services = new Map();
const serviceEmbeddings = new Map();
const queues = new Map();
const fullPreparedBatchIds = new Set();

function requestObject(payload, operation, { requireStateRoot = true } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new WorkerError("invalid_request", `${operation} payload must be an object`);
  }
  const root = payload.root;
  const stateRoot = payload.stateRoot;
  if (typeof root !== "string" || root.length === 0) {
    throw new WorkerError("invalid_request", `${operation} payload.root must be a non-empty path`);
  }
  if (requireStateRoot && (typeof stateRoot !== "string" || stateRoot.length === 0)) {
    throw new WorkerError("invalid_request", `${operation} payload.stateRoot must be an explicit store path`);
  }
  return {
    root: resolve(root),
    stateRoot: typeof stateRoot === "string" ? resolve(stateRoot) : undefined,
    options: payload.options && typeof payload.options === "object" ? payload.options : {},
  };
}

function keyFor(root, stateRoot) {
  return `${root}\0${stateRoot}`;
}

async function serviceFor(root, stateRoot, options = {}) {
  const key = keyFor(root, stateRoot);
  const requestedEmbedding = options.embedding;
  const existing = services.get(key);
  if (existing && (requestedEmbedding === undefined || serviceEmbeddings.get(key) === requestedEmbedding)) return existing;
  if (existing) {
    await existing.close();
    services.delete(key);
    serviceEmbeddings.delete(key);
  }
  const { root: _root, stateRoot: _stateRoot, rebuild: _rebuild, signal: _signal, includeStatus: _includeStatus, ...createOptions } = options;
  const service = await createZvecGrep({ root, stateRoot, ...createOptions });
  services.set(key, service);
  serviceEmbeddings.set(key, requestedEmbedding);
  return service;
}

function serial(root, stateRoot, task) {
  const key = keyFor(root, stateRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  queues.set(key, current.then(() => undefined, () => undefined));
  return current;
}

function formatFor(relativePath) {
  const extension = extname(relativePath).toLowerCase().replace(/^\./, "");
  return extension || "text";
}

function kindFor(relativePath) {
  const extension = extname(relativePath).toLowerCase();
  if ([".md", ".markdown", ".txt", ".rst", ".adoc"].includes(extension)) return "text";
  if ([".json", ".yaml", ".yml", ".toml", ".xml", ".csv"].includes(extension)) return "data";
  return "code";
}

function preparedBatch(root, batch) {
  if (!batch || typeof batch !== "object") {
    throw new WorkerError("invalid_request", "apply batch must be an object");
  }
  const sources = Array.isArray(batch.sources) ? batch.sources : [];
  const upserts = sources.map((source) => {
    if (!source || typeof source !== "object" || typeof source.relativePath !== "string" || typeof source.content !== "string") {
      throw new WorkerError("invalid_request", "apply batch sources must contain captured text snapshots");
    }
    const absolutePath = join(root, source.relativePath);
    const contentBytes = Buffer.byteLength(source.content, "utf8");
    if (contentBytes !== source.byteLength || createHash("sha256").update(source.content).digest("hex") !== source.contentHash) {
      throw new WorkerError("invalid_request", `captured source hash/length mismatch for ${source.relativePath}`);
    }
    return {
      file: {
        id: source.fileId,
        absolutePath,
        relativePath: source.relativePath,
        rootPath: root,
        sizeBytes: source.byteLength,
        lastModifiedTime: 0,
        contentHash: source.contentHash,
        kind: kindFor(source.relativePath),
        format: formatFor(source.relativePath),
      },
      content: { kind: "text", text: source.content },
    };
  });
  const deletedPaths = (Array.isArray(batch.deletedPaths) ? batch.deletedPaths : []).map((relativePath) => join(root, relativePath));
  if (batch.full === true) fullPreparedBatchIds.add(batch.batchId);
  const full = fullPreparedBatchIds.has(batch.batchId);
  return { upserts, deletedPaths, full, batchId: batch.batchId, part: batch.part, final: batch.final };
}

async function context(payload) {
  const request = requestObject(payload, "context");
  return serial(request.root, request.stateRoot, async () => {
    const service = await serviceFor(request.root, request.stateRoot, request.options);
    const options = { ...request.options, root: request.root, stateRoot: request.stateRoot, autoUpdate: false };
    return { outcome: "ok", payload: await service.context(options) };
  });
}

async function info(payload) {
  const request = requestObject(payload, "info");
  return serial(request.root, request.stateRoot, async () => {
    const service = await serviceFor(request.root, request.stateRoot, request.options);
    return { outcome: "ok", payload: await service.info({ root: request.root, stateRoot: request.stateRoot, includeStatus: true }) };
  });
}

async function apply(payload, context) {
  const request = requestObject(payload, "apply");
  let batch;
  try {
    batch = await readPreparedBatch(request.stateRoot, payload.batchRef);
  } catch (error) {
    fullPreparedBatchIds.delete(payload.batchRef?.batchId);
    throw error;
  }
  return serial(request.root, request.stateRoot, async () => {
    try {
      const service = await serviceFor(request.root, request.stateRoot, request.options);
      const prepared = preparedBatch(request.root, batch);
      const signal = AbortSignal.timeout(Math.max(1, context.remainingBudgetMs));
      let result;
      try {
        result = await service.indexPrepared({ stateRoot: request.stateRoot, embeddingCachePath: request.options.embeddingCachePath, batch: prepared, signal });
      } finally {
        try {
          await service.releaseEmbeddingResources();
        } catch {
          // Resource release is best-effort and must not fail the apply.
        }
      }
      if (batch.final === true) fullPreparedBatchIds.delete(batch.batchId);
      return {
        outcome: "ok",
        payload: {
          batchId: batch.batchId,
          projection: "retrieval",
          state: "applied",
          manifestId: batch.manifestId,
          durableBoundary: "zvec.finalizeWrites",
          storeRoot: request.stateRoot,
          filesIndexed: result.filesIndexed,
          filesDeleted: result.filesDeleted,
        },
      };
    } catch (error) {
      fullPreparedBatchIds.delete(batch.batchId);
      throw error;
    }
  });
}

async function closeStore(payload) {
  const request = requestObject(payload, "close-store");
  return serial(request.root, request.stateRoot, async () => {
    const key = keyFor(request.root, request.stateRoot);
    const service = services.get(key);
    if (service) {
      await service.close();
      services.delete(key);
      serviceEmbeddings.delete(key);
    }
    queues.delete(key);
    return { outcome: "ok", payload: { root: request.root, stateRoot: request.stateRoot, closed: Boolean(service) } };
  });
}

async function dispose() {
  const pending = [];
  for (const service of services.values()) pending.push(service.close());
  services.clear();
  serviceEmbeddings.clear();
  queues.clear();
  await Promise.all(pending);
}

await serveWorker({
  kind: "retrieval",
  upstreamCommit: LAZY_INTEL_ZVEC_UPSTREAM_COMMIT,
  handlers: { context, info, apply, "close-store": closeStore },
  dispose,
});