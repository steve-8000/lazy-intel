// ADDED BY lazy-intel

import type { EmbeddingModel } from "../../models/index.js";
import type { WorkspaceIndexStorage } from "../../storage/index.js";
import type {
  Content,
  EntityFragment,
  FileInfo,
  ImageFormat,
} from "../../types.js";
import {
  extractForIndexing,
  type Source,
  vectorContentForFragment,
} from "../../extraction/index.js";
import { indexChunkOptions } from "./input-budget.js";
import { sha256Text } from "../../utils/hash.js";
export interface PreparedSnapshot {
  readonly file: FileInfo;
  readonly content: Content;
}

export interface PreparedSnapshotBatch {
  readonly upserts: readonly PreparedSnapshot[];
  readonly deletedFileIds?: readonly string[];
  readonly deletedPaths?: readonly string[];
  readonly full?: boolean;
  readonly batchId?: string;
  readonly part?: number;
  readonly final?: boolean;
}

export interface PreparedSnapshotFile {
  readonly file: FileInfo;
  readonly fragments: readonly EntityFragment[];
  readonly embeddingInputs: readonly Content[];
}

export interface PreparedSnapshotResult {
  readonly filesIndexed: number;
  readonly fragmentsIndexed: number;
  readonly filesDeleted: number;
  readonly files: readonly PreparedSnapshotFile[];
}

function sourceForSnapshot(snapshot: PreparedSnapshot): Source {
  if (snapshot.content.kind === "image") {
    return {
      kind: "image",
      file: snapshot.file,
      data: snapshot.content.data,
      format: snapshot.content.format as ImageFormat,
    };
  }
  return { kind: "text", file: snapshot.file, text: snapshot.content.text };
}

export async function prepareSnapshot(
  snapshot: PreparedSnapshot,
  embeddingModel: EmbeddingModel,
): Promise<PreparedSnapshotFile> {
  const source = sourceForSnapshot(snapshot);
  const chunkOptions = indexChunkOptions(
    embeddingModel.info.limits.maxInputTokens,
    source.kind === "text" ? source.text : undefined,
  );
  const extracted = await extractForIndexing(source, chunkOptions);
  const selected = extracted.filter(({ fragment }) =>
    embeddingModel.info.inputKinds.includes(fragment.content.kind),
  );
  return {
    file: snapshot.file,
    fragments: selected.map(({ fragment }) => fragment),
    embeddingInputs: selected.map(({ fragment, embeddingSource }) =>
      vectorContentForFragment(
        fragment,
        embeddingSource,
        chunkOptions.maxChunkChars,
      ),
    ),
  };
}

function embeddingCacheKey(
  content: Content,
  model: EmbeddingModel,
): string | null {
  if (content.kind !== "text") return null;
  const identity = JSON.stringify({
    reference: model.info.reference,
    provider: model.info.provider,
    name: model.info.name,
    dimension: model.info.dimension,
    metric: model.info.metric,
    inputKinds: model.info.inputKinds,
    maxInputTokens: model.info.limits.maxInputTokens,
  });
  const normalized = content.text.normalize("NFC").replace(/\r\n?/g, "\n");
  return sha256Text(identity + "\n" + normalized);
}

export async function ingestPreparedSnapshots(
  storage: WorkspaceIndexStorage,
  embeddingModel: EmbeddingModel,
  batch: PreparedSnapshotBatch,
  signal?: AbortSignal,
): Promise<PreparedSnapshotResult> {
  storage.beginEmbeddingCacheBuild(
    batch.full === true ? batch.batchId : undefined,
    batch.part === 0,
  );
  try {
    signal?.throwIfAborted();
  let filesDeleted = 0;
  for (const fileId of batch.deletedFileIds ?? []) {
    storage.deleteFile(fileId);
    filesDeleted += 1;
  }
  for (const absolutePath of batch.deletedPaths ?? []) {
    const existing = storage.getFileByPath(absolutePath);
    if (existing) {
      storage.deleteFile(existing.id);
      filesDeleted += 1;
    }
  }
  const prepared: PreparedSnapshotFile[] = [];
  for (const snapshot of batch.upserts) {
    const file = await prepareSnapshot(snapshot, embeddingModel);
    const vectors: number[][] = Array.from(
      { length: file.embeddingInputs.length },
      () => [],
    );
    const keys = file.embeddingInputs.map((content) =>
      embeddingCacheKey(content, embeddingModel),
    );
    const cached = storage.getCachedEmbeddings(
      keys.filter((key): key is string => key !== null),
    );
    const pending = new Map<string, { index: number; content: Content }[]>();
    for (const [index, content] of file.embeddingInputs.entries()) {
      const key = keys[index];
      const cachedVector = key === null ? undefined : cached.get(key);
      if (cachedVector) {
        vectors[index] = [...cachedVector];
        continue;
      }
      const pendingKey = key ?? "uncached:" + index;
      const indexes = pending.get(pendingKey) ?? [];
      indexes.push({ index, content });
      pending.set(pendingKey, indexes);
    }
    const pendingContents = [...pending.values()].map(([entry]) => entry);
    for (
      let start = 0;
      start < pendingContents.length;
      start += embeddingModel.info.limits.maxBatchSize
    ) {
      const embedBatch = pendingContents.slice(
        start,
        start + embeddingModel.info.limits.maxBatchSize,
      );
      const result = await embeddingModel.embed(
        embedBatch.map(({ content }) => content),
      );
      signal?.throwIfAborted();
      const cacheEntries: { key: string; vector: readonly number[] }[] = [];
      for (const [batchIndex, entry] of embedBatch.entries()) {
        const vector = result.vectors[batchIndex] ?? [];
        for (const duplicate of pending.get(keys[entry.index] ?? "uncached:" + entry.index) ?? []) {
          vectors[duplicate.index] = vector;
        }
        const key = keys[entry.index];
        if (key !== null) cacheEntries.push({ key, vector });
      }
      storage.putCachedEmbeddings(cacheEntries);
    }
    storage.replaceFile(
      file.file,
      file.fragments.map((fragment, index) => ({
        fragment,
        vector: vectors[index] ?? [],
      })),
    );
    prepared.push(file);
  }

  signal?.throwIfAborted();

  await storage.finalizeWrites();
  signal?.throwIfAborted();
  if (batch.full === true && batch.final !== false) {
    storage.compactEmbeddingCache(batch.batchId);
  }
  return {
    filesIndexed: prepared.length,
    fragmentsIndexed: prepared.reduce((total, file) => total + file.fragments.length, 0),
    filesDeleted,
    files: prepared,
  };
  } catch (error) {
    if (batch.full === true) storage.discardEmbeddingCacheBuild(batch.batchId);
    throw error;
  }
}
