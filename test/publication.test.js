import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PublicationCoordinator, PublicationCrash, PublicationNotReadable } from "../packages/core/dist/workspace/publication.js";

async function workspace() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "lazy-intel-publication-")));
}

function batch(batchId, manifestId, storeRoot) {
  return { batchId, manifestId, profileDigest: "profile", projections: ["graph"], sources: [], deletedPaths: [], full: true, ...(storeRoot ? { storeRoot } : {}) };
}

function apply(projection, value) {
  return { batchId: value.batchId, projection, state: "applied", manifestId: value.manifestId, durableBoundary: value.manifestId };
}

test("abandon restores old views and its journal decision survives reopening", async () => {
  const root = await workspace();
  let coordinator;
  try {
    coordinator = await PublicationCoordinator.open(root);
    await coordinator.publishBatch(batch("first", "manifest-first"), apply);
    const stale = batch("stale", "manifest-stale");
    await assert.rejects(
      () => coordinator.publishBatch(stale, apply, { failureAt: "before-catalog-publication" }),
      (error) => error instanceof PublicationCrash,
    );

    const abandoned = await coordinator.abandon(stale.batchId);
    assert.equal(abandoned.batchId, stale.batchId);
    assert.equal(coordinator.status().pendingBatches.length, 0);
    assert.equal(coordinator.view("graph").state, "clean");
    assert.equal(coordinator.view("graph").appliedManifestId, "manifest-first");
    await coordinator.close();

    coordinator = await PublicationCoordinator.open(root);
    assert.equal(coordinator.status().pendingBatches.length, 0);
    assert.equal((await coordinator.read("graph")).view.appliedManifestId, "manifest-first");
  } finally {
    await coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an abandonment whose catalog save was lost to a crash is not replayed", async () => {
  const root = await workspace();
  const catalogPath = path.join(root, "runtime", "publication-catalog.json");
  let coordinator;
  try {
    coordinator = await PublicationCoordinator.open(root);
    await coordinator.publishBatch(batch("first", "manifest-first"), apply);
    const stale = batch("stale", "manifest-stale");
    await assert.rejects(() => coordinator.publishBatch(stale, apply, { failureAt: "after-component-write-before-ack" }), (error) => error instanceof PublicationCrash);
    const beforeAbandon = await readFile(catalogPath);
    await coordinator.abandon(stale.batchId);
    await coordinator.close();
    // The journal ack is durable; the catalog write after it never happened.
    await writeFile(catalogPath, beforeAbandon);

    coordinator = await PublicationCoordinator.open(root, { deferRecovery: true });
    const replayed = [];
    coordinator.registerRecovery((projection, value) => { replayed.push(value.batchId); return apply(projection, value); });
    await coordinator.recover();
    assert.deepEqual(replayed, []);
    assert.equal(coordinator.status().pendingBatches.length, 0);
    assert.equal(coordinator.view("graph").appliedManifestId, "manifest-first");
  } finally {
    await coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoning a batch that wrote into the live store leaves that view unreadable", async () => {
  const root = await workspace();
  const shared = path.join(root, "stores", "shared");
  let coordinator;
  try {
    coordinator = await PublicationCoordinator.open(root);
    await coordinator.publishBatch(batch("first", "manifest-first", shared), apply);
    const incremental = batch("incremental", "manifest-incremental", shared);
    await assert.rejects(() => coordinator.publishBatch(incremental, apply, { failureAt: "after-component-write-before-ack" }), (error) => error instanceof PublicationCrash);
    await coordinator.abandon(incremental.batchId);
    assert.equal(coordinator.view("graph").state, "needs_recovery");
    await assert.rejects(() => coordinator.read("graph"), (error) => error instanceof PublicationNotReadable && error.code === "needs_recovery");
  } finally {
    await coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("write-mode open retains roll-forward recovery when an apply callback is registered", async () => {
  const root = await workspace();
  let coordinator;
  try {
    coordinator = await PublicationCoordinator.open(root);
    const pending = batch("recoverable", "manifest-recoverable");
    await assert.rejects(
      () => coordinator.publishBatch(pending, apply, { failureAt: "after-component-write-before-ack" }),
      (error) => error instanceof PublicationCrash,
    );
    await coordinator.close();

    coordinator = await PublicationCoordinator.open(root, { deferRecovery: true });
    coordinator.registerRecovery(apply);
    await coordinator.recover();
    assert.equal(coordinator.status().pendingBatches.length, 0);
    assert.equal(coordinator.view("graph").state, "clean");
    assert.equal(coordinator.view("graph").appliedManifestId, "manifest-recoverable");
  } finally {
    await coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("publication journal stays bounded and compacted journals still recover or abandon new pending work", async () => {
  const root = await workspace();
  let coordinator;
  try {
    coordinator = await PublicationCoordinator.open(root);
    const journalPath = path.join(root, "runtime", "publication.journal");
    for (let index = 0; index < 12; index += 1) {
      await coordinator.publishBatch(batch("published-" + index, "manifest-" + index), apply);
    }
    assert.ok((await stat(journalPath)).size < 1024, "completed publication payloads accumulated in the journal");

    const pending = batch("after-compaction", "manifest-pending");
    await assert.rejects(
      () => coordinator.publishBatch(pending, apply, { failureAt: "before-component-write" }),
      (error) => error instanceof PublicationCrash,
    );
    await coordinator.close();

    coordinator = await PublicationCoordinator.open(root, { deferRecovery: true });
    const abandoned = await coordinator.abandon(pending.batchId);
    assert.equal(abandoned.batchId, pending.batchId);
    await coordinator.close();
    coordinator = await PublicationCoordinator.open(root);
    assert.equal(coordinator.status().pendingBatches.length, 0);
    assert.equal(coordinator.view("graph").appliedManifestId, "manifest-11");
    assert.ok((await stat(journalPath)).size < 1024);
  } finally {
    await coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});
