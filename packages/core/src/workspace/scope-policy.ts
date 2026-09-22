import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export const DERIVED_SEGMENTS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", ".lazy-intel", ".zvec", ".zvec-grep", ".codegraph", ".serena", ".serena-lazy",
  "node_modules", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", "DerivedData", ".build", ".swiftpm",
  ".next", ".turbo", ".gradle", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache",
]);

export const IGNORE_FILE_NAME = ".lazy-intel-ignore";

export interface ScopeIgnore {
  readonly ignores: (relativePath: string, directory: boolean) => boolean;
  readonly patterns: readonly string[];
  readonly hash: string | null;
  readonly unreadable: boolean;
}

export function isDerivedSegment(name: string): boolean {
  return DERIVED_SEGMENTS.has(name);
}

export function isTransientFile(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return normalized.endsWith(".swp") || normalized.endsWith("~") || normalized.endsWith(".tmp") || basename === ".DS_Store";
}

export async function loadScopeIgnore(sourceRoot: string): Promise<ScopeIgnore> {
  const filename = path.join(sourceRoot, IGNORE_FILE_NAME);
  let bytes: Buffer;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ignores: () => false, patterns: [], hash: null, unreadable: false };
    return { ignores: () => false, patterns: [], hash: null, unreadable: true };
  }
  const text = bytes.toString("utf8");
  const patterns = text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const matcher: Ignore = ignore().add(text);
  return {
    patterns,
    hash: createHash("sha256").update(bytes).digest("hex"),
    unreadable: false,
    ignores(relativePath: string, directory: boolean): boolean {
      const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!normalized || normalized.split("/").includes("..")) return false;
      return matcher.ignores(directory ? `${normalized.replace(/\/$/, "")}/` : normalized);
    },
  };
}
