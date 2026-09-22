import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const FILES_ZVEC = "files.zvec";
const ENTITIES_ZVEC = "index.zvec";

type WorkspaceIndexStoragePaths = {
  storagePath: string;
  filesPath: string;
  indexPath: string;
  embeddingCachePath: string;
};

export function resolveWorkspaceIndexStoragePaths(
  storagePath: string,
  embeddingCachePath: string,
): WorkspaceIndexStoragePaths {
  const resolvedStoragePath = resolve(storagePath);
  return {
    storagePath: resolvedStoragePath,
    filesPath: join(resolvedStoragePath, FILES_ZVEC),
    indexPath: join(resolvedStoragePath, ENTITIES_ZVEC),
    embeddingCachePath: resolve(embeddingCachePath),
  };
}

export function hasWorkspaceIndexStorage(storagePath: string): boolean {
  const resolvedStoragePath = resolve(storagePath);
  return (
    existsSync(join(resolvedStoragePath, FILES_ZVEC)) &&
    existsSync(join(resolvedStoragePath, ENTITIES_ZVEC))
  );
}

export function deleteWorkspaceIndexStorage(storagePath: string): void {
  const resolvedStoragePath = resolve(storagePath);
  for (const target of [
    join(resolvedStoragePath, FILES_ZVEC),
    join(resolvedStoragePath, ENTITIES_ZVEC),
  ]) {
    if (dirname(target) !== resolvedStoragePath) {
      throw new Error("Workspace index data must be inside its storage path");
    }
    rmSync(target, { recursive: true, force: true });
  }
}

export function workspaceIndexPath(storagePath: string): string {
  return join(resolve(storagePath), ENTITIES_ZVEC);
}
