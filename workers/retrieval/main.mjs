import { createZvecGrep, LAZY_INTEL_ZVEC_UPSTREAM_COMMIT } from "../../vendor/zvec-grep/dist/lazy-entry.js";
import { serveWorker, WorkerError } from "../../packages/core/dist/index.js";

const services = new Map();

function requestObject(payload, operation) {
  if (!payload || typeof payload !== "object") {
    throw new WorkerError("invalid_request", `${operation} payload must be an object`);
  }
  const root = payload.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new WorkerError("invalid_request", `${operation} payload.root must be a non-empty path`);
  }
  return { root, options: payload.options && typeof payload.options === "object" ? payload.options : {} };
}

async function serviceFor(root, options = {}) {
  const existing = services.get(root);
  if (existing) return existing;
  const { root: _root, rebuild: _rebuild, signal: _signal, includeStatus: _includeStatus, ...createOptions } = options;
  const service = await createZvecGrep({ root, ...createOptions });
  services.set(root, service);
  return service;
}

async function context(payload) {
  const request = requestObject(payload, "context");
  const service = await serviceFor(request.root, request.options);
  return { outcome: "ok", payload: await service.context({ ...request.options, root: request.root }) };
}

async function info(payload) {
  const request = requestObject(payload, "info");
  const service = await serviceFor(request.root, request.options);
  return { outcome: "ok", payload: await service.info({ root: request.root, includeStatus: true }) };
}

async function index(payload, context) {
  const request = requestObject(payload, "index");
  const service = await serviceFor(request.root, request.options);
  const { embedding: _embedding, ...indexOptions } = request.options;
  const signal = AbortSignal.timeout(Math.max(1, context.remainingBudgetMs));
  return { outcome: "ok", payload: await service.index({ ...indexOptions, root: request.root, signal }) };
}

async function dispose() {
  const pending = [];
  for (const service of services.values()) pending.push(service.close());
  services.clear();
  await Promise.all(pending);
}

await serveWorker({
  kind: "retrieval",
  upstreamCommit: LAZY_INTEL_ZVEC_UPSTREAM_COMMIT,
  handlers: { context, info, index },
  dispose,
});
