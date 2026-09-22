import { execFile } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import ignore from "ignore";
import type { CapturedManifest, SourceSnapshot } from "../contracts.js";

const execFileAsync = promisify(execFile);
const DERIVED_DIRECTORIES = new Set([".git", ".lazy-intel", ".serena-lazy", ".codegraph", ".zvec", "node_modules", "dist", "build", "target", ".venv", "__pycache__"]);
export interface SnapshotExclusion { readonly relativePath: string; readonly reason: "missing" | "derived" | "invalid-utf8" | "too-large" | "not-file"; }
export interface SnapshotFileInput { readonly fileId?: string; readonly relativePath: string; readonly observedSeq?: string; }
export interface SnapshotCaptureOptions { readonly workspaceId: string; readonly sourceRoot: string; readonly files: readonly (string | SnapshotFileInput)[]; readonly observedSeq: string; readonly scopeDigest: string; readonly parserProfileDigest: string; readonly resolverProfileDigest: string; readonly maxAttempts?: number; readonly maxFileBytes?: number; }
export interface WorkspaceSnapshotOptions { readonly workspaceId: string; readonly sourceRoot: string; readonly observedSeq: string; readonly parserProfileDigest: string; readonly resolverProfileDigest: string; readonly scopeDigest?: string; readonly buildContextDigest?: string | null; readonly maxAttempts?: number; readonly maxFileBytes?: number; }
export interface SnapshotSet { readonly sources: readonly SourceSnapshot[]; readonly manifest: CapturedManifest; readonly excluded: readonly SnapshotExclusion[]; }
function hashBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function normaliseInput(input: string | SnapshotFileInput): SnapshotFileInput { return typeof input === "string" ? { relativePath: input } : input; }
function ensureInside(root: string, candidate: string): void { const relative = path.relative(root, candidate); if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`source file is outside workspace: ${candidate}`); }
async function readStableFile(sourceRoot: string, relativePath: string, maxAttempts: number): Promise<{ bytes: Buffer; canonicalPath: string }> {
  const candidate = path.resolve(sourceRoot, relativePath); ensureInside(sourceRoot, candidate);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const canonicalPath = await realpath(candidate); ensureInside(sourceRoot, canonicalPath); const handle = await open(canonicalPath, "r");
    try { const before = await handle.stat(); if (!before.isFile()) throw new Error(`source path is not a file: ${relativePath}`); const bytes = await handle.readFile(); const after = await handle.stat(); const nowPath = await realpath(candidate); if (nowPath === canonicalPath && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino) return { bytes, canonicalPath }; }
    finally { await handle.close(); }
  }
  throw new Error(`source_changed: ${relativePath}`);
}
async function captureSources(options: SnapshotCaptureOptions): Promise<{ sources: readonly SourceSnapshot[]; excluded: readonly SnapshotExclusion[] }> {
  const sourceRoot = await realpath(options.sourceRoot); const maxAttempts = options.maxAttempts ?? 2; const sources: SourceSnapshot[] = []; const excluded: SnapshotExclusion[] = [];
  for (const rawInput of options.files) {
    const input = normaliseInput(rawInput); const relativePath = path.relative(sourceRoot, path.resolve(sourceRoot, input.relativePath));
    if (relativePath.split(path.sep).some((part) => DERIVED_DIRECTORIES.has(part))) { excluded.push({ relativePath, reason: "derived" }); continue; }
    let read: { bytes: Buffer; canonicalPath: string };
    try { read = await readStableFile(sourceRoot, relativePath, maxAttempts); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { excluded.push({ relativePath, reason: "missing" }); continue; } throw error; }
    if (options.maxFileBytes !== undefined && read.bytes.byteLength > options.maxFileBytes) { excluded.push({ relativePath, reason: "too-large" }); continue; }
    const content = read.bytes.toString("utf8"); if (!Buffer.from(content, "utf8").equals(read.bytes)) { excluded.push({ relativePath, reason: "invalid-utf8" }); continue; }
    sources.push({ fileId: input.fileId ?? digest({ workspaceId: options.workspaceId, relativePath }).slice(0, 32), relativePath, contentHash: hashBytes(read.bytes), byteLength: read.bytes.byteLength, encoding: "utf-8", content, observedSeq: input.observedSeq ?? options.observedSeq });
  }
  return { sources, excluded };
}
export async function captureSourceSnapshots(options: SnapshotCaptureOptions): Promise<readonly SourceSnapshot[]> { return (await captureSources(options)).sources; }
export function buildCapturedManifest(options: Omit<SnapshotCaptureOptions, "sourceRoot" | "files"> & { readonly sources: readonly SourceSnapshot[]; readonly excluded?: readonly SnapshotExclusion[] }): CapturedManifest {
  const files = [...options.sources].map((source) => ({ fileId: source.fileId, relativePath: source.relativePath, hash: source.contentHash })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const excluded = [...(options.excluded ?? [])].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const id = digest({ workspaceId: options.workspaceId, scopeDigest: options.scopeDigest, parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest, files, excluded });
  return { id, workspaceId: options.workspaceId, observedSeq: options.observedSeq, scopeDigest: options.scopeDigest, parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest, files, captureKind: "revision-set", ...(excluded.length > 0 ? { exclusions: excluded } : {}) };
}
export async function captureManifest(options: SnapshotCaptureOptions): Promise<CapturedManifest> { const captured = await captureSources(options); return buildCapturedManifest({ ...options, sources: captured.sources, excluded: captured.excluded }); }
export async function captureSnapshotSet(options: SnapshotCaptureOptions): Promise<SnapshotSet> { const captured = await captureSources(options); return { sources: captured.sources, excluded: captured.excluded, manifest: buildCapturedManifest({ ...options, sources: captured.sources, excluded: captured.excluded }) }; }
async function gitFiles(sourceRoot: string): Promise<readonly string[] | null> {
  try { const result = await execFileAsync("git", ["-C", sourceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBuffer: 8 * 1024 * 1024 }); return result.stdout.split("\0").filter(Boolean); } catch { return null; }
}
type IgnoreMatcher = ReturnType<typeof ignore>;
interface IgnoreRule { readonly base: string; readonly matcher: IgnoreMatcher; }
async function localIgnore(current: string): Promise<IgnoreMatcher | null> {
  try { const text = await readFile(path.join(current, ".gitignore"), "utf8"); return ignore().add(text); } catch { /* absent ignore file */ return null; }
}
function ignoredPath(candidate: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) { const relative = path.relative(rule.base, candidate).split(path.sep).join("/"); if (relative && rule.matcher.ignores(directory ? relative + "/" : relative)) ignored = true; }
  return ignored;
}
async function walkFiles(root: string, current: string, output: string[], inherited: readonly IgnoreRule[] = []): Promise<void> {
  const rules = [...inherited]; const matcher = await localIgnore(current); if (matcher) rules.push({ base: current, matcher });
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || (entry.isDirectory() && DERIVED_DIRECTORIES.has(entry.name))) continue;
    const candidate = path.join(current, entry.name); if (entry.isDirectory()) await walkFiles(root, candidate, output, rules); else if (entry.isFile() && !ignoredPath(candidate, false, rules)) output.push(path.relative(root, candidate));
  }
}
async function collectPolicyFiles(root: string, current: string, files: Array<{ path: string; hash: string }>): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && DERIVED_DIRECTORIES.has(entry.name)) continue;
    const candidate = path.join(current, entry.name); const relative = path.relative(root, candidate);
    if (entry.isDirectory()) await collectPolicyFiles(root, candidate, files);
    else if (entry.isFile() && (entry.name === ".gitignore" || /^(?:ts|js)config(?:[.][^.]+)*[.]json$/.test(entry.name))) files.push({ path: relative, hash: hashBytes(await readFile(candidate)) });
  }
}
async function policyDigest(root: string, buildContextDigest: string | null | undefined): Promise<string> {
  const files: Array<{ path: string; hash: string }> = []; await collectPolicyFiles(root, root, files);
  for (const relative of ["package.json", "pyproject.toml", "Cargo.toml"]) { try { files.push({ path: relative, hash: hashBytes(await readFile(path.join(root, relative))) }); } catch { /* absent policy */ } }
  files.sort((left, right) => left.path.localeCompare(right.path)); return digest({ buildContextDigest: buildContextDigest ?? null, files });
}
export async function discoverWorkspaceFiles(sourceRoot: string): Promise<readonly string[]> {
  const root = await realpath(sourceRoot); const tracked = await gitFiles(root); if (tracked) { const files: string[] = []; for (const relative of tracked) { if (relative.split("/").some((part) => DERIVED_DIRECTORIES.has(part))) continue; try { if ((await stat(path.join(root, relative))).isFile()) files.push(relative); } catch { /* tracked-but-deleted files are deletion observations */ } } return files.sort(); }
  const files: string[] = []; await walkFiles(root, root, files); return files.sort();
}
export async function captureWorkspaceSnapshot(options: WorkspaceSnapshotOptions): Promise<SnapshotSet> {
  const sourceRoot = await realpath(options.sourceRoot); const files = await discoverWorkspaceFiles(sourceRoot); const policy = await policyDigest(sourceRoot, options.buildContextDigest); const scopeDigest = options.scopeDigest ?? digest({ sourceRoot, policy, ignorePolicy: [...DERIVED_DIRECTORIES].sort(), parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest });
  return captureSnapshotSet({ workspaceId: options.workspaceId, sourceRoot, files, observedSeq: options.observedSeq, scopeDigest, parserProfileDigest: options.parserProfileDigest, resolverProfileDigest: options.resolverProfileDigest, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }), ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }) });
}
