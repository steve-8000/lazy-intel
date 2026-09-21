import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "./log.js";

/**
 * A single bad entry in the configuration must never take the server down: a stdio server that
 * throws while loading closes stdout before answering `initialize`, and the client only sees
 * "MCP subprocess closed stdout before responding". Roots that are deleted, relative or otherwise
 * unresolvable are dropped with a warning, so every other workspace keeps working and a request
 * for the bad root fails with the explicit "outside allowed workspaces" error.
 */
function resolveConfiguredRoot(root) {
  if (!path.isAbsolute(root)) {
    log("warn", "ignoring non-absolute allowed root", { root });
    return undefined;
  }
  try {
    return realpathSync(root);
  } catch (error) {
    log("warn", "ignoring unresolvable allowed root", { root, error: error.message });
    return undefined;
  }
}

function resolveBootRoot() {
  const configured = process.env.LAZY_INTEL_ROOT;
  if (configured) {
    const resolved = resolveConfiguredRoot(configured);
    if (resolved) return resolved;
    log("warn", "falling back to process cwd for boot root", { root: configured });
  }
  return realpathSync(process.cwd());
}

// Capture trusted process configuration once, before accepting any MCP request.
export const bootRoot = resolveBootRoot();
const allowedRoots = [...new Set([
  bootRoot,
  ...(process.env.LAZY_INTEL_ALLOWED_ROOTS ?? "").split(path.delimiter).filter(Boolean)
    .map(resolveConfiguredRoot).filter(Boolean),
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
