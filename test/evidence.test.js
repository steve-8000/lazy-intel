import test from "node:test";
import assert from "node:assert/strict";
import { makeEvidence, dedupe, identityKey, sortEvidence } from "../src/evidence.js";

const provenance = (backend, executionId = backend) => ({
  backend, operation: "symbol", backendVersion: "1", adapterVersion: "1", executionId,
});

function item({ id, kind = "definition", path = "src/a.js", start = 1, signature = "f(x)", backend = "serena", executionId = backend }) {
  return makeEvidence({
    id, kind, method: "lsp",
    locator: { rootKey: "/workspace", relativePath: path, range: { startLine: start, endLineExclusive: start + 1 } },
    subject: { qualifiedName: "f", signature, backendId: `${id}-backend`, backendNamespace: backend },
    text: `function ${signature}`,
    sourceCheck: { status: "matched", sha256: "same-source" },
    observation: {
      before: { processEpoch: 1, generation: 1, appliedGeneration: 1, watcher: "active", baseline: "applied" },
      after: { processEpoch: 1, generation: 1, appliedGeneration: 1, watcher: "active", baseline: "applied" },
      consistency: "observed_stable",
    },
    provenance: [provenance(backend, executionId)],
  });
}

test("dedupe preserves overloads, modules, claims, and merges only true duplicates", () => {
  const overload = item({ id: "overload", start: 2, signature: "f(string)" });
  const otherModule = item({ id: "module", path: "src/b.js" });
  const duplicate = item({ id: "duplicate", executionId: "zvec", backend: "zvec" });
  const original = item({ id: "original" });
  const reference = item({ id: "reference", kind: "reference" });
  const merged = dedupe([original, overload, otherModule, duplicate, reference]);
  assert.equal(merged.length, 4);
  assert.equal(merged.find((entry) => entry.id === "original").provenance.length, 2);
  assert.equal(identityKey(overload) !== identityKey(original), true);
  assert.equal(identityKey(otherModule) !== identityKey(original), true);
  assert.equal(identityKey(reference) !== identityKey(original), true);
});

test("sortEvidence is deterministic and independent of input order", () => {
  const values = [
    item({ id: "r", kind: "reference", start: 3 }),
    item({ id: "d", kind: "definition", start: 2 }),
    item({ id: "x", kind: "retrieval", start: 1 }),
  ];
  const first = sortEvidence(values, { operation: "references" }).map((entry) => entry.id);
  const shuffled = sortEvidence([values[2], values[0], values[1]], { operation: "references" }).map((entry) => entry.id);
  assert.deepEqual(first, shuffled);
});
