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

async function serviceFor(root) {
  const existing = services.get(root);
  if (existing) return existing;
  const service = await createZvecGrep({ root });
  services.set(root, service);
  return service;
}

async function context(payload) {
  const request = requestObject(payload, "context");
  const service = await serviceFor(request.root);
  return { outcome: "ok", payload: await service.context({ ...request.options, root: request.root }) };
}

async function info(payload) {
  const request = requestObject(payload, "info");
  const service = await serviceFor(request.root);
  return { outcome: "ok", payload: await service.info({ ...request.options, root: request.root }) };
}

async function index(payload) {
  const request = requestObject(payload, "index");
  const service = await serviceFor(request.root);
  return { outcome: "ok", payload: await service.index({ ...request.options, root: request.root }) };
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
