import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceScope } from "../contracts.js";

export interface WorkspaceRuntimeOptions {
  readonly sourceRoot: string;
  readonly stateRoot?: string;
  readonly buildContextDigest?: string | null;
  readonly trustedForLanguageTools?: boolean;
  readonly lockRetryMs?: number;
}

export interface WorkspaceRuntimeHandle extends WorkspaceScope {
  readonly sourceRoot: string;
  readonly stateRoot: string;
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

interface LockContents {
  readonly pid: number;
  readonly token: string;
  readonly sourceRoot: string;
  readonly createdAt: string;
}

const LOCK_NAME = "workspace.lock";
const RUNTIME_DIR = "runtime";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function canonicalExistingDirectory(input: string): Promise<string> {
  const resolved = await realpath(input);
  const information = await stat(resolved);
  if (!information.isDirectory()) throw new Error(`workspace root is not a directory: ${input}`);
  // realpath resolves symlinks and macOS /var aliases. Matching each directory entry also
  // removes the spelling difference that a case-insensitive filesystem permits.
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    const entries = await readdir(current);
    const match = entries.find((entry) => entry === part) ?? entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (!match) throw new Error(`workspace root disappeared while canonicalising: ${input}`);
    current = path.join(current, match);
  }
  return current;
}

async function canonicalStateDirectory(sourceRoot: string, requested?: string): Promise<string> {
  const candidate = requested ?? path.join(sourceRoot, ".lazy-intel");
  const absolute = path.resolve(candidate);
  const relative = path.relative(sourceRoot, absolute);
  if (relative === "" || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || path.basename(absolute).toLowerCase() !== ".lazy-intel") {
    throw new Error("stateRoot must be a separate .lazy-intel directory under sourceRoot");
  }
  await mkdir(absolute, { recursive: true });
  return canonicalExistingDirectory(absolute);
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLock(lockPath: string): Promise<LockContents | null> {
  try {
    return JSON.parse(await readFile(path.join(lockPath, "holder.json"), "utf8")) as LockContents;
  } catch {
    return null;
  }
}

async function durableJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function acquireLock(stateRoot: string, sourceRoot: string, retryMs: number): Promise<{ lockPath: string; release: () => Promise<void> }> {
  const runtimePath = path.join(stateRoot, RUNTIME_DIR);
  const lockPath = path.join(runtimePath, LOCK_NAME);
  await mkdir(runtimePath, { recursive: true });
  const token = randomUUID();
  for (;;) {
    try {
      await mkdir(lockPath);
      const holder: LockContents = { pid: process.pid, token, sourceRoot, createdAt: new Date().toISOString() };
      await durableJson(path.join(lockPath, "holder.json"), holder);
      let released = false;
      return {
        lockPath,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLock(lockPath);
          if (current?.token === token && current.pid === process.pid) await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readLock(lockPath);
      if (current && await processIsAlive(current.pid)) throw new Error(`workspace is already owned by process ${current.pid}`);
      // Rename is the recovery operation: it is atomic with respect to another acquirer and
      // leaves a forensic name if a stale process races us.
      const stale = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try { await rename(lockPath, stale); await rm(stale, { recursive: true, force: true }); } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT" && (renameError as NodeJS.ErrnoException).code !== "EEXIST") throw renameError;
      }
      if (retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function openWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntimeHandle> {
  const sourceRoot = await canonicalExistingDirectory(options.sourceRoot);
  const stateRoot = await canonicalStateDirectory(sourceRoot, options.stateRoot);
  const lock = await acquireLock(stateRoot, sourceRoot, options.lockRetryMs ?? 10);
  const scopeDigest = digest(JSON.stringify({ sourceRoot, stateRoot }));
  const workspaceId = `workspace-${digest(sourceRoot).slice(0, 32)}`;
  const scope: WorkspaceScope = {
    workspaceId,
    canonicalSourceRoot: sourceRoot,
    canonicalStateRoot: stateRoot,
    scopeDigest,
    buildContextDigest: options.buildContextDigest ?? null,
    trustedForLanguageTools: options.trustedForLanguageTools ?? false,
  };
  return { ...scope, sourceRoot, stateRoot, lockPath: lock.lockPath, release: lock.release };
}

export class WorkspaceRuntime {
  readonly scope: WorkspaceRuntimeHandle;
  private constructor(scope: WorkspaceRuntimeHandle) { this.scope = scope; }

  static async open(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
    return new WorkspaceRuntime(await openWorkspaceRuntime(options));
  }

  get workspaceId(): string { return this.scope.workspaceId; }
  get sourceRoot(): string { return this.scope.canonicalSourceRoot; }
  get stateRoot(): string { return this.scope.canonicalStateRoot; }
  async close(): Promise<void> { await this.scope.release(); }
}

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  return canonicalExistingDirectory(root);
}

export async function canonicalStateRoot(sourceRoot: string, stateRoot?: string): Promise<string> {
  return canonicalStateDirectory(await canonicalExistingDirectory(sourceRoot), stateRoot);
}
