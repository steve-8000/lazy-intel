import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm, rename, writeFile, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createZvecGrep } from "../../vendor/zvec-grep/dist/lazy-entry.js";
import { extractForIndexing, vectorContentForFragment } from "../../vendor/zvec-grep/dist/engine/extraction/index.js";
import { indexChunkOptions } from "../../vendor/zvec-grep/dist/engine/pipeline/indexing/input-budget.js";
import { prepareSnapshot } from "../../vendor/zvec-grep/dist/engine/pipeline/indexing/prepared.js";

function model(calls = [], lifecycle = { disposed: 0 }, dimension = 2) {
  return {
    info: {
      reference: "retrieval-parity-deterministic",
      provider: "test",
      name: "retrieval-parity-deterministic",
      dimension,
      metric: "cosine",
      inputKinds: ["text"],
      limits: { maxBatchSize: 8, maxInputTokens: 128 },
    },
    async embed(contents) {
      calls.push(contents.map((content) => content.text));
      return { vectors: contents.map((_, index) => Array.from({ length: dimension }, (_, valueIndex) => valueIndex + index + 1)), truncated: [] };
    },
    async dispose() {
      lifecycle.disposed += 1;
    },
  };
}

function fileInfo(root, relativePath, content, format) {
  return {
    id: relativePath,
    absolutePath: path.join(root, relativePath),
    relativePath,
    rootPath: root,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    lastModifiedTime: 1,
    contentHash: createHash("sha256").update(content).digest("hex"),
    kind: "text",
    format,
  };
}

function snapshot(root, relativePath, content, format) {
  return {
    file: fileInfo(root, relativePath, content, format),
    content: { kind: "text", text: content },
  };
}

// The embedding cache is shared across a workspace's stores, so it is named
// explicitly rather than derived from whichever store is being written.
function cachePath(stateRoot) {
  return path.join(stateRoot, "..", "embedding-cache.jsonl");
}

async function query(service, root, stateRoot, query) {
  return service.context({
    root,
    stateRoot,
    routes: [{ mode: "fts", query }, { mode: "vector", query }],
    fuse: true,
    limit: 20,
    autoUpdate: false,
  });
}

test("prepared snapshots preserve stock extraction and indexed results across formats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-formats-"));
  const stateRoot = path.join(root, ".lazy-intel", "state");
  const files = [
    ["README.md", "markdown", "# Retrieval Atlas\n\nmarkdown_marker describes the source snapshot.\n"],
    ["records.json", "json", '{"json_marker":"indexed JSON value","count":2}\n'],
    ["settings.yaml", "yaml", "config_marker: enabled\nmode: deterministic\n"],
    ["notes.txt", "text", "plaintext_marker is indexed as ordinary text.\n"],
  ].map(([relativePath, format, content]) => snapshot(root, relativePath, content, format));
  const embeddingCalls = [];
  const embeddingModel = model(embeddingCalls);
  const service = await createZvecGrep({ root, stateRoot, embeddingModel, embeddingModelOwnership: "borrowed" });
  try {
    for (const item of files) await writeFile(item.file.absolutePath, item.content.text, "utf8");
    for (const item of files) {
      const prepared = await prepareSnapshot(item, embeddingModel);
      const options = indexChunkOptions(embeddingModel.info.limits.maxInputTokens, item.content.text);
      const stock = await extractForIndexing({ kind: "text", file: item.file, text: item.content.text }, options);
      const selected = stock.filter(({ fragment }) => embeddingModel.info.inputKinds.includes(fragment.content.kind));
      assert.deepEqual(prepared.fragments, selected.map(({ fragment }) => fragment));
      assert.deepEqual(
        prepared.embeddingInputs,
        selected.map(({ fragment, embeddingSource }) => vectorContentForFragment(fragment, embeddingSource, options.maxChunkChars)),
      );
      assert.ok(prepared.fragments.length > 0, `${item.file.relativePath} must produce fragments`);
    }

    const indexed = await service.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: files } });
    assert.equal(indexed.filesIndexed, files.length);
    assert.ok(indexed.fragmentsIndexed > 0);
    for (const marker of ["markdown_marker", "json_marker", "config_marker", "plaintext_marker"]) {
      const result = await query(service, root, stateRoot, marker);
      assert.ok(result.items.length > 0, `${marker} must be observable through the indexed context query`);
    }
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two real stores sharing a borrowed model survive close order and retain caller ownership", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-b-"));
  const stateA = path.join(rootA, ".lazy-intel", "state");
  const stateB = path.join(rootB, ".lazy-intel", "state");
  const lifecycle = { disposed: 0 };
  const embeddingModel = model([], lifecycle);
  const contentA = "shared_model_alpha_marker\n";
  const contentB = "shared_model_beta_marker\n";
  const fileA = snapshot(rootA, "alpha.txt", contentA, "text");
  const fileB = snapshot(rootB, "beta.txt", contentB, "text");
  const serviceA = await createZvecGrep({ root: rootA, stateRoot: stateA, embeddingModel, embeddingModelOwnership: "borrowed" });
  const serviceB = await createZvecGrep({ root: rootB, stateRoot: stateB, embeddingModel, embeddingModelOwnership: "borrowed" });
  try {
    await writeFile(fileA.file.absolutePath, contentA, "utf8");
    await writeFile(fileB.file.absolutePath, contentB, "utf8");
    const indexedA = await serviceA.indexPrepared({ stateRoot: stateA, embeddingCachePath: cachePath(stateA), batch: { upserts: [fileA] } });
    assert.equal(indexedA.filesIndexed, 1);
    const resultA = await query(serviceA, rootA, stateA, "shared_model_alpha_marker");
    assert.ok(resultA.items.length > 0);

    await serviceA.close();
    assert.equal(lifecycle.disposed, 0, "closing store A must not dispose the borrowed model");

    const indexedB = await serviceB.indexPrepared({ stateRoot: stateB, embeddingCachePath: cachePath(stateB), batch: { upserts: [fileB] } });
    assert.equal(indexedB.filesIndexed, 1);
    const resultB = await query(serviceB, rootB, stateB, "shared_model_beta_marker");
    assert.ok(resultB.items.length > 0);
    await serviceB.close();
    assert.equal(lifecycle.disposed, 0, "closing store B must not dispose the borrowed model");

    const afterClose = await embeddingModel.embed([{ kind: "text", text: "caller-owned model remains usable" }]);
    assert.equal(afterClose.vectors.length, 1);
    await embeddingModel.dispose();
    assert.equal(lifecycle.disposed, 1);
  } finally {
    await serviceA.close();
    await serviceB.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("prepared apply rejects an embedding schema mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-schema-"));
  const stateRoot = path.join(root, ".lazy-intel", "state");
  const content = "schema_marker must not be indexed with a different vector schema.\n";
  const file = snapshot(root, "schema.txt", content, "text");
  let compatible;
  let incompatible;
  try {
    await writeFile(file.file.absolutePath, content, "utf8");
    compatible = await createZvecGrep({ root, stateRoot, embeddingModel: model(), embeddingModelOwnership: "borrowed" });
    await compatible.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: [file] } });
    await compatible.close();
    compatible = undefined;

    incompatible = await createZvecGrep({ root, stateRoot, embeddingModel: model([], { disposed: 0 }, 3), embeddingModelOwnership: "borrowed" });
    await assert.rejects(
      incompatible.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: [file] } }),
      (error) => error?.code === "ZVEC_GREP.ENGINE.SERVICE.EMBEDDING_SCHEMA_CHANGE_REQUIRES_REBUILD",
    );
  } finally {
    await compatible?.close();
    await incompatible?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared rename and delete remove stale vector metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-rename-"));
  const stateRoot = path.join(root, ".lazy-intel", "state");
  const oldPath = "before.txt";
  const newPath = "after.txt";
  const content = "rename_vector_marker remains searchable after rename.\n";
  const oldSnapshot = snapshot(root, oldPath, content, "text");
  const newSnapshot = snapshot(root, newPath, content, "text");
  const embeddingModel = model();
  const service = await createZvecGrep({ root, stateRoot, embeddingModel, embeddingModelOwnership: "borrowed" });
  try {
    await writeFile(oldSnapshot.file.absolutePath, content, "utf8");
    const initial = await service.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: [oldSnapshot] } });
    assert.equal(initial.filesIndexed, 1);
    assert.ok((await query(service, root, stateRoot, "rename_vector_marker")).items.some((item) => item.file.relativePath === oldPath));

    await rename(oldSnapshot.file.absolutePath, newSnapshot.file.absolutePath);
    const renamed = await service.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: [newSnapshot], deletedPaths: [oldSnapshot.file.absolutePath] } });
    assert.equal(renamed.filesDeleted, 1);
    const afterRename = await query(service, root, stateRoot, "rename_vector_marker");
    assert.ok(afterRename.items.some((item) => item.file.relativePath === newPath));
    assert.ok(afterRename.items.every((item) => item.file.relativePath !== oldPath));

    const deleted = await service.indexPrepared({ stateRoot, embeddingCachePath: cachePath(stateRoot), batch: { upserts: [], deletedPaths: [newSnapshot.file.absolutePath] } });
    assert.equal(deleted.filesDeleted, 1);
    const afterDelete = await query(service, root, stateRoot, "rename_vector_marker");
    assert.equal(afterDelete.items.length, 0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("oversized unicode code chunks preserve UTF16 native and UTF8 source boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-unicode-"));
  const content =
    "const prefix = 'é漢😀';\r\nexport function oversized() {\r\n" +
    Array.from({ length: 18 }, (_, index) =>
      "  const value" + index + " = 'é漢😀' + " + index + ";\r\n",
    ).join("") +
    "}\r\n";
  const file = fileInfo(root, "unicode.js", content, "javascript");
  try {
    const fragments = await extractForIndexing(
      { kind: "text", file, text: content },
      { maxChunkChars: 48, chunkOverlapChars: 0 },
    );
    const sourceFragments = fragments
      .map(({ fragment }) => fragment)
      .filter((fragment) => fragment.content.text === content.slice(fragment.range.startOffset, fragment.range.endOffset));
    assert.ok(sourceFragments.length >= 2, "fixture must produce later source chunks");
    for (const fragment of sourceFragments) {
      assert.equal(fragment.range.kind, "text");
      const range = fragment.range;
      const startByte = Buffer.byteLength(content.slice(0, range.startOffset), "utf8");
      const endByte = Buffer.byteLength(content.slice(0, range.endOffset), "utf8");
      assert.equal(Buffer.from(content, "utf8").subarray(startByte, endByte).toString("utf8"), fragment.content.text);
    }
    const later = sourceFragments.at(-1);
    assert.ok(later);
    assert.match(later.content.text, /é漢😀/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full prepared builds compact the shared embedding cache and incremental builds retain unrelated keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-cache-gc-"));
  const stateRoot = path.join(root, ".lazy-intel", "state");
  const cache = cachePath(stateRoot);
  const calls = [];
  const embeddingModel = model(calls);
  const alpha = snapshot(root, "alpha.txt", "cache_alpha_unique_marker\n", "text");
  const beta = snapshot(root, "beta.txt", "cache_beta_unique_marker\n", "text");
  const gamma = snapshot(root, "gamma.txt", "cache_gamma_unique_marker\n", "text");
  const service = await createZvecGrep({ root, stateRoot, embeddingModel, embeddingModelOwnership: "borrowed" });
  const keysFor = async (item) => {
    const prepared = await prepareSnapshot(item, embeddingModel);
    const identity = JSON.stringify({
      reference: embeddingModel.info.reference,
      provider: embeddingModel.info.provider,
      name: embeddingModel.info.name,
      dimension: embeddingModel.info.dimension,
      metric: embeddingModel.info.metric,
      inputKinds: embeddingModel.info.inputKinds,
      maxInputTokens: embeddingModel.info.limits.maxInputTokens,
    });
    return prepared.embeddingInputs.map(({ text }) => createHash("sha256").update(identity + "\n" + text.normalize("NFC").replace(/\r\n?/g, "\n")).digest("hex"));
  };
  const records = async () => (await readFile(cache, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const embeddedCount = () => calls.reduce((total, batch) => total + batch.length, 0);
  try {
    for (const item of [alpha, beta, gamma]) await writeFile(item.file.absolutePath, item.content.text, "utf8");
    await service.indexPrepared({ stateRoot, embeddingCachePath: cache, batch: { upserts: [alpha], full: true, batchId: "full-corpus", part: 0, final: false } });
    assert.deepEqual(new Set((await records()).map(({ key }) => key)), new Set(await keysFor(alpha)), "first part records keys without compacting");
    await service.indexPrepared({ stateRoot, embeddingCachePath: cache, batch: { upserts: [beta], full: true, batchId: "full-corpus", part: 1, final: true } });
    const originalKeys = new Set((await records()).map(({ key }) => key));
    const sizeWithAlphaAndBeta = (await stat(cache)).size;
    assert.deepEqual(originalKeys, new Set([...(await keysFor(alpha)), ...(await keysFor(beta))]));

    await service.indexPrepared({ stateRoot, embeddingCachePath: cache, batch: { upserts: [gamma] } });
    const afterIncremental = new Set((await records()).map(({ key }) => key));
    assert.ok([...originalKeys].every((key) => afterIncremental.has(key)), "incremental builds retain cached chunks outside the changed files");
    assert.ok((await keysFor(gamma)).every((key) => afterIncremental.has(key)));

    const cacheBeforeCancelledBuild = await readFile(cache);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(service.indexPrepared({
      stateRoot,
      embeddingCachePath: cache,
      batch: { upserts: [alpha], full: true, batchId: "cancelled-full", part: 0, final: true },
      signal: cancelled.signal,
    }));
    assert.deepEqual(await readFile(cache), cacheBeforeCancelledBuild, "cancelled full builds leave the cache unchanged");

    await service.indexPrepared({ stateRoot, embeddingCachePath: cache, batch: { upserts: [alpha], deletedFileIds: [beta.file.id, gamma.file.id], full: true } });
    const compacted = await records();
    const sizeWithAlphaOnly = (await stat(cache)).size;
    assert.deepEqual(new Set(compacted.map(({ key }) => key)), new Set(await keysFor(alpha)));
    assert.ok(sizeWithAlphaOnly < sizeWithAlphaAndBeta, "full rebuild reduces cache bytes to the active corpus");

    const embeddingsBeforeReuse = embeddedCount();
    await service.indexPrepared({ stateRoot, embeddingCachePath: cache, batch: { upserts: [alpha], full: true } });
    assert.equal(embeddedCount(), embeddingsBeforeReuse, "the next full build reuses every compacted embedding");
    console.log(`embedding cache bytes: ${sizeWithAlphaAndBeta} -> ${sizeWithAlphaOnly}; incremental retained ${afterIncremental.size} keys; reuse embeds=${embeddedCount() - embeddingsBeforeReuse}`);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
