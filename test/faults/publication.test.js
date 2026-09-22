import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicationCoordinator, PublicationCrash, PublicationNotReadable } from "../../packages/core/dist/workspace/publication.js";

const failurePoints = [
  ["before-component-write", 0],
  ["after-component-write-before-ack", 1],
  ["after-ack-before-catalog-publication", 1],
  ["before-catalog-publication", 2],
  ["after-catalog-publication", 2],
];
function batch(manifestId, batchId = `${manifestId}-batch`) {
  return { batchId, manifestId, profileDigest: "profile", projections: ["retrieval", "graph"], sources: [], deletedPaths: [], full: true };
}
function applyTo(stores, value, calls = []) {
  return async (projection, current) => {
    calls.push(projection);
    stores[projection] = value;
    return { batchId: current.batchId, projection, state: "applied", manifestId: current.manifestId, durableBoundary: `${value}-${projection}` };
  };
}

for (const [failureAt, alreadyApplied] of failurePoints) {
  test(`recovers callback-owned stores at ${failureAt}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-publication-"));
    const stores = { retrieval: undefined, graph: undefined };
    const coordinator = await PublicationCoordinator.open(root);
    await coordinator.publishBatch(batch("manifest-old", "old-batch"), applyTo(stores, "old"));
    const next = batch("manifest-new", "new-batch");
    await assert.rejects(() => coordinator.publishBatch(next, applyTo(stores, "new"), { failureAt }), (error) => error instanceof PublicationCrash);
    assert.equal(stores.retrieval, alreadyApplied > 0 ? "new" : "old");
    if (failureAt !== "after-catalog-publication") await assert.rejects(() => coordinator.read(["retrieval", "graph"]), (error) => error instanceof PublicationNotReadable && error.code === "needs_recovery");
    await coordinator.close();

    const recovered = await PublicationCoordinator.open(root);
    assert.equal(recovered.status().needsRecovery, failureAt !== "after-catalog-publication");
    const replayCalls = [];
    recovered.registerRecovery(applyTo(stores, "new", replayCalls));
    await recovered.recover();
    assert.equal(stores.retrieval, "new");
    assert.equal(stores.graph, "new");
    const expectedReplay = failureAt === "before-component-write" || failureAt === "after-component-write-before-ack" ? 2 : failureAt === "after-ack-before-catalog-publication" ? 1 : 0;
    assert.equal(replayCalls.length, expectedReplay);
    await recovered.read(["retrieval", "graph"], {}, async (views, lease) => {
      assert.equal(views.retrieval.appliedManifestId, "manifest-new");
      assert.equal(views.graph.appliedManifestId, "manifest-new");
      lease.release();
    });
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  });
}

test("mixed applied manifests refuse a coherent multi-projection callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-mixed-"));
  const stores = { retrieval: undefined, graph: undefined };
  const coordinator = await PublicationCoordinator.open(root);
  await coordinator.publishBatch(batch("manifest-old", "old-batch"), applyTo(stores, "old"));
  await coordinator.publishBatch({ ...batch("manifest-new", "new-retrieval"), projections: ["retrieval"] }, applyTo(stores, "new"));
  await assert.rejects(() => coordinator.read(["retrieval", "graph"], { requireCoherent: true }, async () => "unreachable"), (error) => error instanceof PublicationNotReadable && error.code === "mixed-views");
  await coordinator.close();
  await rm(root, { recursive: true, force: true });
});

test("a read lease blocks publication until released and exposes immutable views", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-lease-"));
  const stores = { retrieval: undefined, graph: undefined };
  const coordinator = await PublicationCoordinator.open(root);
  await coordinator.publishBatch(batch("manifest-old", "old-batch"), applyTo(stores, "old"));
  let releaseRead;
  const readStarted = coordinator.read("retrieval", {}, async (views, lease) => { assert.throws(() => { views.retrieval.state = "applying"; }, TypeError); await new Promise((resolve) => { releaseRead = () => { lease.release(); resolve(); }; }); });
  await new Promise((resolve) => setImmediate(resolve));
  let applied = false;
  const publish = coordinator.publishBatch({ ...batch("manifest-new", "new-batch"), projections: ["retrieval"] }, async (projection, current) => { applied = true; return { batchId: current.batchId, projection, state: "applied", manifestId: current.manifestId, durableBoundary: "new" }; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, false);
  releaseRead();
  await readStarted;
  await publish;
  assert.equal(applied, true);
  await coordinator.close();
  await rm(root, { recursive: true, force: true });
});

test("failed recovery blocks the next publication until the pending transaction recovers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-recovery-order-"));
  const stores = { retrieval: undefined, graph: undefined };
  const coordinator = await PublicationCoordinator.open(root);
  await coordinator.publishBatch(batch("manifest-old", "old-batch"), applyTo(stores, "old"));
  await assert.rejects(() => coordinator.publishBatch(batch("manifest-t1", "t1-batch"), applyTo(stores, "t1"), { failureAt: "before-component-write" }), (error) => error instanceof PublicationCrash);
  await coordinator.close();

  const recovered = await PublicationCoordinator.open(root);
  let failRecovery = true;
  recovered.registerRecovery(async (projection, current) => {
    if (failRecovery) throw new Error("recovery apply failed");
    stores[projection] = current.manifestId;
    return { batchId: current.batchId, projection, state: "applied", manifestId: current.manifestId, durableBoundary: "recovered-" + projection };
  });
  await assert.rejects(() => recovered.recover(), /recovery apply failed/);
  assert.equal(recovered.status().needsRecovery, true);
  await assert.rejects(() => recovered.publishBatch(batch("manifest-t2", "t2-batch"), applyTo(stores, "t2")), (error) => error instanceof PublicationNotReadable && error.code === "needs_recovery");

  failRecovery = false;
  await recovered.recover();
  assert.equal(recovered.status().needsRecovery, false);
  assert.equal(stores.retrieval, "manifest-t1");
  assert.equal(stores.graph, "manifest-t1");
  await recovered.publishBatch(batch("manifest-t2", "t2-batch"), applyTo(stores, "t2"));
  assert.equal(recovered.view("retrieval")?.appliedManifestId, "manifest-t2");
  await recovered.close();
  await rm(root, { recursive: true, force: true });
});
