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

export interface PreparedSnapshot {
  readonly file: FileInfo;
  readonly content: Content;
}

export interface PreparedSnapshotBatch {
  readonly upserts: readonly PreparedSnapshot[];
  readonly deletedFileIds?: readonly string[];
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

export async function ingestPreparedSnapshots(
  storage: WorkspaceIndexStorage,
  embeddingModel: EmbeddingModel,
  batch: PreparedSnapshotBatch,
): Promise<PreparedSnapshotResult> {
  for (const fileId of batch.deletedFileIds ?? []) {
    storage.deleteFile(fileId);
  }

  const prepared: PreparedSnapshotFile[] = [];
  for (const snapshot of batch.upserts) {
    const file = await prepareSnapshot(snapshot, embeddingModel);
    const vectors: number[][] = [];
    for (
      let start = 0;
      start < file.embeddingInputs.length;
      start += embeddingModel.info.limits.maxBatchSize
    ) {
      const result = await embeddingModel.embed(
        file.embeddingInputs.slice(
          start,
          start + embeddingModel.info.limits.maxBatchSize,
        ),
      );
      vectors.push(...result.vectors);
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

  await storage.finalizeWrites();
  return {
    filesIndexed: prepared.length,
    fragmentsIndexed: prepared.reduce((total, file) => total + file.fragments.length, 0),
    filesDeleted: (batch.deletedFileIds ?? []).length,
    files: prepared,
  };
}
