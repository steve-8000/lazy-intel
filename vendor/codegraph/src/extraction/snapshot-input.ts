// ADDED BY lazy-intel

import * as fs from "fs";

/** A decoded source snapshot captured before either projection reads it. */
export interface SnapshotInput {
  readonly relativePath: string;
  readonly content: string;
  /** Preserve capture metadata when the caller already has filesystem stats. */
  readonly stats?: fs.Stats;
  readonly modifiedAt?: number;
}

/**
 * Return metadata suitable for the existing incremental store path without
 * touching the source path. `indexFileWithContent` only consumes size and mtime.
 */
export function statsForSnapshot(snapshot: SnapshotInput): fs.Stats {
  if (snapshot.stats) {
    return snapshot.stats;
  }
  const size = Buffer.byteLength(snapshot.content, "utf8");
  return { size, mtimeMs: snapshot.modifiedAt ?? 0 } as fs.Stats;
}
