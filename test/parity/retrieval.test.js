import assert from "node:assert/strict";
import test from "node:test";
import { extractForIndexing, vectorContentForFragment } from "../../vendor/zvec-grep/dist/engine/extraction/index.js";
import { indexChunkOptions } from "../../vendor/zvec-grep/dist/engine/pipeline/indexing/input-budget.js";
import {
  ingestPreparedSnapshots,
  prepareSnapshot,
} from "../../vendor/zvec-grep/dist/engine/pipeline/indexing/prepared.js";

function fileInfo() {
  return {
    id: "file-1",
    absolutePath: "/snapshot/sample.js",
    relativePath: "sample.js",
    rootPath: "/snapshot",
    sizeBytes: 48,
    lastModifiedTime: 1,
    contentHash: "snapshot-hash",
    kind: "code",
    format: "javascript",
  };
}

function model(calls) {
  return {
    info: {
      reference: "test",
      provider: "test",
      name: "test",
      dimension: 2,
      metric: "cosine",
      inputKinds: ["text"],
      limits: { maxBatchSize: 8, maxInputTokens: 128 },
    },
    async embed(contents) {
      calls.push(contents.map((content) => content.text));
      return { vectors: contents.map((_, index) => [index, index + 1]), truncated: [] };
    },
    async dispose() {},
  };
}

test("prepared snapshot input matches stock extraction and vector composition", async () => {
  const file = fileInfo();
  const content = "export function greet(name) { return name; }\n";
  const embeddingCalls = [];
  const embeddingModel = model(embeddingCalls);
  const snapshot = await prepareSnapshot(
    { file, content: { kind: "text", text: content } },
    embeddingModel,
  );
  const options = indexChunkOptions(128, content);
  const stock = await extractForIndexing(
    { kind: "text", file, text: content },
    options,
  );
  const expectedInputs = stock
    .filter(({ fragment }) => embeddingModel.info.inputKinds.includes(fragment.content.kind))
    .map(({ fragment, embeddingSource }) =>
      vectorContentForFragment(fragment, embeddingSource, options.maxChunkChars),
    );
  assert.deepEqual(snapshot.fragments, stock.map(({ fragment }) => fragment));
  assert.deepEqual(snapshot.embeddingInputs, expectedInputs);

  const storageCalls = { replaced: [], finalized: 0 };
  const storage = {
    readOnly: false,
    getFileByPath: () => null,
    listFilesByPathPrefix: () => [],
    listFilesByPathPrefixes: () => [],
    listFiles: () => [],
    listEntitiesByFile: () => [],
    getEntity: () => null,
    searchFts: () => [],
    searchVector: () => [],
    replaceFile: (storedFile, entries) => storageCalls.replaced.push({ storedFile, entries }),
    markFileFailed: () => {},
    deleteFile: () => {},
    async finalizeWrites() { storageCalls.finalized++; },
    close: () => {},
  };
  const result = await ingestPreparedSnapshots(storage, embeddingModel, {
    upserts: [{ file, content: { kind: "text", text: content } }],
  });
  assert.equal(storageCalls.finalized, 1);
  assert.equal(storageCalls.replaced.length, 1);
  assert.deepEqual(
    storageCalls.replaced[0].entries.map(({ fragment }) => fragment),
    snapshot.fragments,
  );
  assert.equal(result.fragmentsIndexed, snapshot.fragments.length);
  assert.deepEqual(embeddingCalls[0], snapshot.embeddingInputs.map((input) => input.text));
});
