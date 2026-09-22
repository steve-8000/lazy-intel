import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceScope } from "../contracts.js";

export interface WorkspaceRuntimeOptions { readonly sourceRoot: string; readonly stateRoot?: string; readonly lockRetryMs?: number; readonly lockTimeoutMs?: number; readonly signal?: AbortSignal; readonly trustedForLanguageTools?: boolean; }
export interface WorkspaceRuntimeHandle extends WorkspaceScope { readonly sourceRoot: string; readonly stateRoot: string; readonly release: () => Promise<void>; }
interface LockContents { readonly pid: number; readonly token: string; readonly sourceRoot: string; readonly sourceIdentity: string; }
interface PersistentIdentity { readonly version: 1; readonly workspaceId: string; readonly sourceRoot: string; readonly stateRoot: string; readonly sourceIdentity: string; }
const LOCK_NAME = "workspace.lock"; const RUNTIME_DIR = "runtime"; const LOCK_GRACE_MS = 5_000;
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function canonicalExistingDirectory(input: string): Promise<string> { const resolved = await realpath(input); const information = await stat(resolved); if (!information.isDirectory()) throw new Error(`workspace root is not a directory: ${input}`); return resolved; }
async function canonicalStateDirectory(sourceRoot: string, requested?: string): Promise<string> {
  const target = requested ?? path.join(sourceRoot, ".lazy-intel");
  await mkdir(target, { recursive: true });
  const canonical = await realpath(target);
  if (canonical === sourceRoot) throw new Error("state directory must be separate from source root");
  if (!requested && canonical !== target) throw new Error("default state directory symlink is outside owned state");
  return canonical;
}
async function sourceIdentity(sourceRoot: string): Promise<string> { const information = await stat(sourceRoot); return digest(`${information.dev}:${information.ino}:${information.birthtimeMs}`); }
async function processIsAlive(pid: number): Promise<boolean> { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
async function readLock(lockPath: string): Promise<LockContents | null> { try { return JSON.parse(await readFile(path.join(lockPath, "holder.json"), "utf8")) as LockContents; } catch { return null; } }
async function durableJson(filePath: string, value: unknown): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.${process.pid}.${randomUUID()}`; const handle = await open(temporary, "w", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } await rename(temporary, filePath); const directory = await open(path.dirname(filePath), "r"); try { await directory.sync(); } finally { await directory.close(); } }
function abortLock(signal: AbortSignal | undefined, deadline: number): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("workspace lock acquisition cancelled"); if (Date.now() >= deadline) throw new Error("workspace lock acquisition timed out"); }
async function acquireLock(stateRoot: string, sourceRoot: string, sourceKey: string, retryMs: number, timeoutMs: number, signal?: AbortSignal): Promise<{ release: () => Promise<void> }> {
  const lockPath = path.join(stateRoot, RUNTIME_DIR, LOCK_NAME);
  await mkdir(path.dirname(lockPath), { recursive: true });
  if (await realpath(path.dirname(lockPath)) !== path.dirname(lockPath)) throw new Error("runtime directory symlink is outside owned state");
  const token = randomUUID(); const deadline = Date.now() + timeoutMs;
  for (;;) {
    abortLock(signal, deadline);
    try { await mkdir(lockPath); await durableJson(path.join(lockPath, "holder.json"), { pid: process.pid, token, sourceRoot, sourceIdentity: sourceKey }); let released = false; return { release: async () => { if (released) return; released = true; const holder = await readLock(lockPath); if (holder?.token === token && holder.pid === process.pid) await rm(lockPath, { recursive: true, force: true }); } }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readLock(lockPath);
      if (holder?.pid === process.pid) throw new Error("workspace already owned by this process");
      if (holder && !(await processIsAlive(holder.pid))) { await rm(lockPath, { recursive: true, force: true }); continue; }
      if (holder) { await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, retryMs)))); if (!(await processIsAlive(holder.pid))) { await rm(lockPath, { recursive: true, force: true }); continue; } throw new Error("workspace already owned by another process"); }
      if (!holder) { try { const information = await stat(lockPath); if (Date.now() - information.mtimeMs > LOCK_GRACE_MS) await rm(lockPath, { recursive: true, force: true }); } catch { /* owner won the race */ } }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, retryMs)));
    }
  }
}
async function readIdentity(filePath: string): Promise<PersistentIdentity | null> { try { return JSON.parse(await readFile(filePath, "utf8")) as PersistentIdentity; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }

export async function openWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntimeHandle> {
  const sourceRoot = await canonicalExistingDirectory(options.sourceRoot); const stateRoot = await canonicalStateDirectory(sourceRoot, options.stateRoot); const sourceKey = await sourceIdentity(sourceRoot); const workspaceId = `workspace-${digest(sourceRoot).slice(0, 32)}`; const identityPath = path.join(stateRoot, RUNTIME_DIR, "workspace-identity.json");
  const lock = await acquireLock(stateRoot, sourceRoot, sourceKey, options.lockRetryMs ?? 10, options.lockTimeoutMs ?? 30_000, options.signal);
  try {
    const existing = await readIdentity(identityPath); if (existing && (existing.sourceRoot !== sourceRoot || existing.stateRoot !== stateRoot || existing.sourceIdentity !== sourceKey)) throw new Error("workspace identity mismatch: source was recreated or state belongs to another workspace");
    await durableJson(identityPath, { version: 1, workspaceId, sourceRoot, stateRoot, sourceIdentity: sourceKey } satisfies PersistentIdentity);
  } catch (error) { await lock.release(); throw error; }
  const scopeDigest = digest(JSON.stringify({ sourceRoot, stateRoot })); const trustedForLanguageTools = options.trustedForLanguageTools ?? false; const scope: WorkspaceScope = { workspaceId, canonicalSourceRoot: sourceRoot, canonicalStateRoot: stateRoot, scopeDigest, buildContextDigest: null, trustedForLanguageTools };
  return { ...scope, sourceRoot, stateRoot, release: lock.release };
}
export class WorkspaceRuntime { readonly scope: WorkspaceRuntimeHandle; private constructor(scope: WorkspaceRuntimeHandle) { this.scope = scope; } static async open(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> { return new WorkspaceRuntime(await openWorkspaceRuntime(options)); } get workspaceId(): string { return this.scope.workspaceId; } get sourceRoot(): string { return this.scope.canonicalSourceRoot; } get stateRoot(): string { return this.scope.canonicalStateRoot; } get canonicalSourceRoot(): string { return this.scope.canonicalSourceRoot; } get canonicalStateRoot(): string { return this.scope.canonicalStateRoot; } get scopeDigest(): string { return this.scope.scopeDigest; } async release(): Promise<void> { await this.scope.release(); } }
export async function canonicalWorkspaceRoot(root: string): Promise<string> { return canonicalExistingDirectory(root); }
export async function canonicalStateRoot(sourceRoot: string, stateRoot?: string): Promise<string> { return canonicalStateDirectory(await canonicalExistingDirectory(sourceRoot), stateRoot); }
