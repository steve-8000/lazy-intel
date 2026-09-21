import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CapturedManifest, SourceSnapshot } from "../contracts.js";

export interface SnapshotFileInput {
  readonly fileId?: string;
  readonly relativePath: string;
  readonly observedSeq?: string;
}

export interface SnapshotCaptureOptions {
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly files: readonly (string | SnapshotFileInput)[];
  readonly observedSeq: string;
  readonly scopeDigest: string;
  readonly parserProfileDigest: string;
  readonly resolverProfileDigest: string;
  readonly maxAttempts?: number;
}

export interface SnapshotSet {
  readonly sources: readonly SourceSnapshot[];
  readonly manifest: CapturedManifest;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normaliseInput(input: string | SnapshotFileInput): SnapshotFileInput {
  if (typeof input === "string") return { relativePath: input };
  return input;
}

function ensureInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`source file is outside workspace: ${candidate}`);
}

async function readStableFile(sourceRoot: string, relativePath: string, maxAttempts: number): Promise<{ bytes: Buffer; canonicalPath: string }> {
  const candidate = path.resolve(sourceRoot, relativePath);
  ensureInside(sourceRoot, candidate);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await stat(candidate);
    if (!before.isFile()) throw new Error(`source path is not a file: ${relativePath}`);
    const canonicalPath = await realpath(candidate);
    ensureInside(sourceRoot, canonicalPath);
    const bytes = await readFile(canonicalPath);
    const after = await stat(canonicalPath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) return { bytes, canonicalPath };
  }
  throw new Error(`source_changed: ${relativePath}`);
}

export async function captureSourceSnapshots(options: SnapshotCaptureOptions): Promise<readonly SourceSnapshot[]> {
  const sourceRoot = await realpath(options.sourceRoot);
  const maxAttempts = options.maxAttempts ?? 2;
  const snapshots: SourceSnapshot[] = [];
  for (const rawInput of options.files) {
    const input = normaliseInput(rawInput);
    const relativePath = path.relative(sourceRoot, path.resolve(sourceRoot, input.relativePath));
    const read = await readStableFile(sourceRoot, relativePath, maxAttempts);
    const bytes = read.bytes;
    const contentHash = hashBytes(bytes);
    snapshots.push({
      fileId: input.fileId ?? digest({ workspaceId: options.workspaceId, relativePath }).slice(0, 32),
      relativePath,
      contentHash,
      byteLength: bytes.byteLength,
      encoding: "utf-8",
      content: bytes.toString("utf8"),
      observedSeq: input.observedSeq ?? options.observedSeq,
    });
  }
  return snapshots;
}

export function buildCapturedManifest(options: Omit<SnapshotCaptureOptions, "sourceRoot" | "files"> & { readonly sources: readonly SourceSnapshot[] }): CapturedManifest {
  const files = [...options.sources]
    .map((source) => ({ fileId: source.fileId, relativePath: source.relativePath, hash: source.contentHash }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const id = digest({ workspaceId: options.workspaceId, observedSeq: options.observedSeq, scopeDigest: options.scopeDigest, parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest, files });
  return { id, workspaceId: options.workspaceId, observedSeq: options.observedSeq, scopeDigest: options.scopeDigest, parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest, files, captureKind: "revision-set" };
}

export async function captureManifest(options: SnapshotCaptureOptions): Promise<CapturedManifest> {
  const sources = await captureSourceSnapshots(options);
  return buildCapturedManifest({ ...options, sources });
}

export async function captureSnapshotSet(options: SnapshotCaptureOptions): Promise<SnapshotSet> {
  const sources = await captureSourceSnapshots(options);
  return { sources, manifest: buildCapturedManifest({ ...options, sources }) };
}
