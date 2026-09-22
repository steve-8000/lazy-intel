import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { containsPath } from "./roots.js";

export const SOURCE_BUDGET = Object.freeze({ maxFiles: 8, maxBytes: 512 * 1024 });

function fail(message) {
  throw new Error(`invalid source locator: ${message}`);
}

/** Resolve an untrusted backend path before any source read is attempted. */
export async function resolveLocator(root, rawPath) {
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("root must be absolute");
  if (typeof rawPath !== "string" || rawPath.length === 0) fail("path must be a non-empty string");
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) fail("URI paths are not allowed");

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) fail("root is not a directory");
  } catch (error) {
    if (error.message.startsWith("invalid source locator:")) throw error;
    fail(`root cannot be resolved: ${error.message}`);
  }

  const candidate = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(canonicalRoot, rawPath);
  if (!containsPath(canonicalRoot, candidate)) fail("path escapes root");
  let canonicalPath;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    fail(`path cannot be resolved: ${error.message}`);
  }
  if (!containsPath(canonicalRoot, canonicalPath)) fail("resolved path escapes root");
  let fileStat;
  try {
    fileStat = await stat(canonicalPath);
  } catch (error) {
    fail(`path cannot be inspected: ${error.message}`);
  }
  if (!fileStat.isFile()) fail("path is not a regular file");
  return {
    rootKey: canonicalRoot,
    relativePath: path.relative(canonicalRoot, canonicalPath).split(path.sep).join("/"),
  };
}

function columnSlice(value, start, end, encoding) {
  if (encoding === "utf16") return value.slice(start, end);
  if (encoding === "unicode_codepoints") return Array.from(value).slice(start, end).join("");
  const bytes = Buffer.from(value, "utf8");
  return bytes.subarray(start, end).toString("utf8");
}

function rangeText(text, range) {
  if (!range) return text;
  const lines = text.split("\n").slice(range.startLine, range.endLineExclusive);
  if (!range.columns || lines.length === 0) return lines.join("\n");
  const { start, end, encoding } = range.columns;
  if (lines.length === 1) return columnSlice(lines[0], start, end, encoding);
  lines[0] = columnSlice(lines[0], start, Number.POSITIVE_INFINITY, encoding);
  lines[lines.length - 1] = columnSlice(lines.at(-1), 0, end, encoding);
  return lines.join("\n");
}

export function lineRangeForSpan(bytes, span) {
  const start = Math.max(0, Math.min(span.startByte, bytes.length));
  const end = Math.max(start, Math.min(span.endByte, bytes.length));
  let startLine = 0;
  for (let index = 0; index < start; index += 1) if (bytes[index] === 10) startLine += 1;
  let endLine = startLine;
  for (let index = start; index < end; index += 1) if (bytes[index] === 10) endLine += 1;
  if (end > start && bytes[end - 1] === 10) endLine -= 1;
  return { startLine, endLineExclusive: endLine + 1 };
}
function sameStat(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
}

export function createSourceVerifier(root, options = {}) {
  const budget = {
    maxFiles: Number.isInteger(options.maxFiles) ? options.maxFiles : SOURCE_BUDGET.maxFiles,
    maxBytes: Number.isInteger(options.maxBytes) ? options.maxBytes : SOURCE_BUDGET.maxBytes,
  };
  const cache = new Map();
  let filesRead = 0;
  let bytesRead = 0;

  async function verify(locator, expectedText, expectedHash, expectedSpan, textKind = "source") {
    if (!locator || typeof expectedText !== "string") return { status: "unchecked", reason: "invalid verification input" };
    const key = `${locator.rootKey}\0${locator.relativePath}`;
    const cached = cache.get(key);
    if (cached) return check(locator, expectedText, cached, expectedHash, expectedSpan, textKind);
    if (filesRead >= budget.maxFiles) return { status: "unchecked", reason: "source file budget exhausted" };
    let resolved;
    try {
      // Resolve the relative locator directly. Absolute aliases such as /var/... and /private/...
      // can name the same root on macOS, but must not fail lexical containment before realpath.
      resolved = await resolveLocator(root, locator.relativePath);
    } catch (error) {
      return { status: "unchecked", reason: error.message };
    }
    const resolvedKey = `${resolved.rootKey}\0${resolved.relativePath}`;
    const existing = cache.get(resolvedKey);
    if (existing) return check(locator, expectedText, existing, expectedHash, expectedSpan, textKind);
    let before;
    try {
      const absolute = path.join(resolved.rootKey, ...resolved.relativePath.split("/"));
      before = await stat(absolute);
      if (!before.isFile()) return { status: "unchecked", reason: "source path is not a file" };
      if (before.size > budget.maxBytes || bytesRead + before.size > budget.maxBytes) {
        return { status: "unchecked", reason: "source byte budget exhausted" };
      }
      const bytes = await readFile(absolute);
      const after = await stat(absolute);
      filesRead += 1;
      bytesRead += bytes.byteLength;
      if (!sameStat(before, after) || bytes.byteLength !== before.size) {
        return { status: "unchecked", reason: "source changed during read" };
      }
      const entry = { bytes, text: bytes.toString("utf8"), hash: createHash("sha256").update(bytes).digest("hex") };
      cache.set(resolvedKey, entry);
      return check(locator, expectedText, entry, expectedHash, expectedSpan, textKind);
    } catch (error) {
      return { status: "unchecked", reason: `source read failed: ${error.message}` };
    }
  }

  function check(locator, expectedText, entry, expectedHash, expectedSpan, textKind) {
    if (expectedHash && expectedHash !== "unknown" && entry.hash !== expectedHash) {
      return { status: "mismatch", reason: "source revision differs from the captured anchor" };
    }
    if (expectedSpan) {
      const { startByte, endByte, coordinateSystem } = expectedSpan;
      if (coordinateSystem !== "utf8-bytes" || !Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte < startByte || endByte > entry.bytes.length) return { status: "mismatch", reason: "invalid canonical byte span" };
      const range = lineRangeForSpan(entry.bytes, expectedSpan);
      if (locator.range && (locator.range.startLine !== range.startLine || locator.range.endLineExclusive !== range.endLineExclusive)) return { status: "mismatch", reason: "locator differs from canonical byte span" };
      // Descriptions are semantic claims, not quotations. Only their source anchor is checked.
      if (textKind === "description") return expectedHash && expectedHash !== "unknown"
        ? { status: "matched", sha256: entry.hash }
        : { status: "unchecked", reason: "description has no captured source revision" };
      return entry.bytes.subarray(startByte, endByte).toString("utf8") === expectedText
        ? { status: "matched", sha256: entry.hash }
        : { status: "mismatch", reason: "source excerpt differs from canonical byte span" };
    }
    if (textKind === "description") return { status: "unchecked", reason: "description has no canonical source span" };
    const actual = rangeText(entry.text, locator.range);
    if (actual !== expectedText) return { status: "mismatch", reason: "source text does not match locator" };
    return { status: "matched", sha256: entry.hash };
  }

  return Object.freeze({ verify });
}

export function observationSpan(before, after) {
  let consistency = "unverified";
  const generationChanged = before && after && before.generation !== undefined && after.generation !== undefined && before.generation !== after.generation;
  if (generationChanged) {
    consistency = "concurrent_change_observed";
  } else if (before && after && before.watcher === "active" && after.watcher === "active" &&
      before.baseline === "applied" && after.baseline === "applied" &&
      before.processEpoch !== undefined && after.processEpoch !== undefined &&
      before.generation !== undefined && after.generation !== undefined) {
    consistency = "observed_stable";
  }
  return Object.freeze({ before: before ?? null, after: after ?? null, consistency });
}
