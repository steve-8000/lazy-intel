import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceSnapshot } from "../contracts.js";

export interface PreparedBatchPart {
  readonly batchId: string;
  readonly part: number;
  readonly manifestId: string;
  readonly sources: readonly SourceSnapshot[];
  readonly deletedPaths: readonly string[];
  readonly full: boolean;
  readonly final: boolean;
}
export interface PreparedBatchReference {
  readonly batchId: string;
  readonly part: number;
  readonly manifestId: string;
  readonly path: string;
  readonly sha256: string;
}
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function preparedDirectory(stateRoot: string, create: boolean): Promise<string> {
  if (create) await mkdir(stateRoot, { recursive: true });
  const directory = path.join(await realpath(stateRoot), ".prepared");
  if (create) await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error("prepared directory symlink is outside owned state");
  return directory;
}

/** Reconstructible transport data, not a publication or backend durability boundary. */
export async function stagePreparedBatch(stateRoot: string, batch: PreparedBatchPart): Promise<{
  readonly reference: PreparedBatchReference;
  release(): Promise<void>;
}> {
  const directory = await preparedDirectory(stateRoot, true);
  const file = path.join(directory, `${randomUUID()}.json`);
  const bytes = JSON.stringify(batch);
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return {
    reference: { batchId: batch.batchId, part: batch.part, manifestId: batch.manifestId, path: file, sha256: hash(bytes) },
    release: async () => { await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); },
  };
}

/** A small IPC frame names immutable bytes owned by this generation's state directory. */
export async function readPreparedBatch(stateRoot: string, reference: PreparedBatchReference): Promise<PreparedBatchPart> {
  if (!reference || typeof reference.path !== "string" || typeof reference.sha256 !== "string") throw new Error("prepared batch reference is required");
  const [directory, file] = await Promise.all([preparedDirectory(stateRoot, false), realpath(reference.path)]);
  const relative = path.relative(directory, file);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("prepared batch is outside the owned state directory");
  const bytes = await readFile(file);
  if (hash(bytes) !== reference.sha256) throw new Error("prepared batch bytes changed before apply");
  const batch = JSON.parse(bytes.toString("utf8")) as PreparedBatchPart;
  if (batch.batchId !== reference.batchId || batch.part !== reference.part || batch.manifestId !== reference.manifestId || !Array.isArray(batch.sources) || !Array.isArray(batch.deletedPaths) || typeof batch.full !== "boolean" || typeof batch.final !== "boolean") throw new Error("prepared batch identity mismatch");
  return batch;
}
