import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicationCoordinator, PublicationCrash, PublicationNotReadable } from "../../packages/core/dist/workspace/publication.js";

const failurePoints = [
  ["before-component-write", "old"],
  ["after-component-write-before-ack", "old"],
  ["after-ack-before-catalog-publication", "old"],
  ["before-catalog-publication", "new"],
  ["after-catalog-publication", "new"],
];

for (const [failureAt, expected] of failurePoints) {
  test(`recovers ${failureAt} without serving a mixed revision`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-publication-"));
    const state = path.join(root, ".lazy-intel");
    await writeFile(path.join(root, "source.txt"), "source\n");
    const coordinator = await PublicationCoordinator.open(state);
    await coordinator.publish({ manifestId: "manifest-old", profileDigest: "profile", components: { retrieval: { revision: "old" }, graph: { revision: "old" } } });
    await assert.rejects(
      coordinator.publish({ manifestId: "manifest-new", profileDigest: "profile", components: { retrieval: { revision: "new" }, graph: { revision: "new" } }, failureAt }),
      (error) => error instanceof PublicationCrash,
    );
    if (failureAt !== "after-catalog-publication") {
      await assert.rejects(() => coordinator.read("retrieval"), (error) => error instanceof PublicationNotReadable && error.code === "applying");
    }
    await coordinator.close();

    const recovered = await PublicationCoordinator.open(state);
    const retrieval = await recovered.read("retrieval");
    const graph = await recovered.read("graph");
    assert.equal(retrieval.data.revision, expected);
    assert.equal(graph.data.revision, expected);
    assert.equal(retrieval.view.appliedManifestId, graph.view.appliedManifestId);
    assert.equal(recovered.status().mixedViews, false);
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  });
}

test("mixed applied manifests are reported and coherent reads are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-mixed-"));
  const state = path.join(root, ".lazy-intel");
  const coordinator = await PublicationCoordinator.open(state);
  await coordinator.publish({ manifestId: "manifest-old", profileDigest: "profile", components: { retrieval: { revision: "old" }, graph: { revision: "old" } } });
  await coordinator.publish({ manifestId: "manifest-new", profileDigest: "profile", components: { retrieval: { revision: "new" } } });
  assert.equal(coordinator.status().mixedViews, true);
  await assert.rejects(() => coordinator.read("graph", { requireCoherent: true }), (error) => error instanceof PublicationNotReadable && error.code === "mixed-views");
  await coordinator.close();
  await rm(root, { recursive: true, force: true });
});
