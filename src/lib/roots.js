import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// Capture trusted process configuration once, before accepting any MCP request.
export const bootRoot = realpathSync(process.env.LAZY_INTEL_ROOT || process.cwd());
const allowedRoots = [...new Set([
  bootRoot,
  ...(process.env.LAZY_INTEL_ALLOWED_ROOTS ?? "").split(path.delimiter).filter(Boolean).map((root) => {
    if (!path.isAbsolute(root)) throw new Error("LAZY_INTEL_ALLOWED_ROOTS entries must be absolute paths");
    return realpathSync(root);
  }),
])];

export function containsPath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function canonicalDirectory(root) {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`root is not a directory: ${root}`);
  return canonical;
}

export async function requestRoot(root = bootRoot) {
  const canonical = await canonicalDirectory(root);
  if (!allowedRoots.some((allowed) => containsPath(allowed, canonical))) {
    throw new Error(`root is outside allowed workspaces: ${root}`);
  }
  return canonical;
}
