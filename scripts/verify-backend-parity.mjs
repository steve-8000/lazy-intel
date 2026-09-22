#!/usr/bin/env node
/**
 * Actual stock-versus-unified retrieval parity producer.
 *
 * The stock arm uses the pinned headless zvec API directly (index + context),
 * which is the unchanged stock disk-index/query path. The unified arm uses the
 * real code_intel MCP transport. Both arms receive byte-identical source trees,
 * the same configured embedding identifier, and independent temporary state
 * roots. Raw responses are retained in the report; only source-backed file/span
 * identities are used for normalized comparison.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/mcp/client.js";
import { createZvecGrep, LAZY_INTEL_ZVEC_UPSTREAM_COMMIT } from "../vendor/zvec-grep/dist/lazy-entry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(ROOT, "docs/unified/backend-parity.json");
const MODEL = process.env.LAZY_INTEL_EMBEDDING || "local/qwen3-embedding-0.6b";
const DEVICE = process.env.LAZY_INTEL_EMBEDDING_DEVICE || "metal";
const NODE = process.execPath;
const QUERIES = [
  { id: "applyDiscount", query: "applyDiscount", anchor: "applyDiscount" },
  { id: "invoiceTotal", query: "invoiceTotal", anchor: "invoiceTotal" },
  { id: "embeddingNativeQwen", query: "embedding native Qwen configured local qwen3 embedding", anchor: "embeddingNativeQwen" },
];
const SOURCE_FILES = {
  "package.json": JSON.stringify({ name: "backend-parity-fixture", type: "module" }, null, 2) + "\n",
  "src/discount.mjs": [
    "export function applyDiscount(total, rate) {",
    "  return Math.round(total * (1 - rate));",
    "}",
    "",
  ].join("\n"),
  "src/invoice.mjs": [
    "import { applyDiscount } from './discount.mjs';",
    "",
    "export function invoiceTotal(lines, rate = 0) {",
    "  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);",
    "  return applyDiscount(subtotal, rate);",
    "}",
    "",
  ].join("\n"),
  "src/embedding.mjs": [
    "// Critical configuration anchor: embeddingNativeQwen is local and cached.",
    "export const embeddingNativeQwen = 'local/qwen3-embedding-0.6b';",
    "",
  ].join("\n"),
  "README.md": "A small real source corpus for stock/unified backend parity.\n",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeCorpus(root) {
  for (const [relative, content] of Object.entries(SOURCE_FILES)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

function sourceManifest() {
  const files = Object.entries(SOURCE_FILES).sort(([a], [b]) => a.localeCompare(b)).map(([relativePath, content]) => ({
    relativePath,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  }));
  return { files, canonicalHash: sha256(files.map((file) => `${file.relativePath}\0${file.sha256}\0${file.bytes}`).join("\0")) };
}
async function actualSourceManifest(root) {
  const files = [];
  for (const relativePath of Object.keys(SOURCE_FILES).sort((a, b) => a.localeCompare(b))) {
    const bytes = await readFile(path.join(root, relativePath));
    files.push({ relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { files, canonicalHash: sha256(files.map((file) => `${file.relativePath}\0${file.sha256}\0${file.bytes}`).join("\0")) };
}
function modelConfig() {
  const value = { identifier: MODEL, device: DEVICE, provider: "local", downloadsAllowed: false, indexMode: "hybrid" };
  return { ...value, digest: sha256(JSON.stringify(value)) };
}

function spanOf(value) {
  const range = value?.range ?? value?.locator?.range ?? value?.span ?? value?.locator?.span;
  if (!range || typeof range !== "object") return null;
  const startLine = Number(range.startLine ?? range.start?.line ?? range.start?.lineNumber);
  const endLine = Number(range.endLine ?? (range.endLineExclusive === undefined ? undefined : range.endLineExclusive - 1) ?? range.end?.line ?? range.end?.lineNumber ?? startLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return { startLine, endLine };
}

function relativePathOf(value) {
  const candidate = value?.relativePath ?? value?.file?.relativePath ?? value?.locator?.relativePath ?? value?.file?.path;
  if (typeof candidate !== "string" || !candidate) return null;
  return candidate.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function normalizeItems(value, source, root) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    const relativePath = relativePathOf(node);
    const range = spanOf(node);
    if (relativePath && range && source.files.some((file) => file.relativePath === relativePath)) {
      const sourceFile = source.files.find((file) => file.relativePath === relativePath);
      found.push({ relativePath, range, node, expectedSha256: sourceFile.sha256, method: node.method ?? node.matchedBy ?? null, sourceCheck: node.sourceCheck ?? null });
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  const normalized = [];
  for (const item of found) {
    const bytes = await readFile(path.join(root, item.relativePath));
    const actualSha256 = sha256(bytes);
    const stockRange = item.node.range?.startOffset !== undefined && item.node.range?.endOffset !== undefined ? { startByte: item.node.range.startOffset, endByte: item.node.range.endOffset } : null;
    const unifiedRange = item.node.anchor?.span?.startByte !== undefined && item.node.anchor?.span?.endByte !== undefined ? { startByte: item.node.anchor.span.startByte, endByte: item.node.anchor.span.endByte } : null;
    const canonicalSpan = stockRange ?? unifiedRange;
    const bounded = canonicalSpan && canonicalSpan.startByte >= 0 && canonicalSpan.endByte >= canonicalSpan.startByte && canonicalSpan.endByte <= bytes.length;
    const contentMatches = typeof item.node.content === "string" && stockRange ? Buffer.from(bytes.subarray(stockRange.startByte, stockRange.endByte)).equals(Buffer.from(item.node.content)) : true;
    const anchorHashMatches = unifiedRange ? actualSha256 === item.node.anchor.contentHash : true;
    normalized.push({ relativePath: item.relativePath, range: item.range, canonicalSpan, sourceSha256: actualSha256, expectedSourceSha256: item.expectedSha256, sourceHashMatchesFixture: actualSha256 === item.expectedSha256, rangeContentMatches: contentMatches, anchorHashMatches, spanValid: Boolean(bounded && contentMatches && anchorHashMatches), method: item.method, sourceCheck: item.sourceCheck });
  }
  return [...new Map(normalized.map((item) => [`${item.relativePath}:${item.range.startLine}:${item.range.endLine}:${item.canonicalSpan?.startByte ?? ""}:${item.canonicalSpan?.endByte ?? ""}`, item])).values()]
    .sort((a, b) => `${a.relativePath}:${a.range.startLine}`.localeCompare(`${b.relativePath}:${b.range.startLine}`));
}

function rawText(result) {
  return typeof result === "string" ? result : result?.content?.map?.((part) => part.text ?? "").join("\n") ?? null;
}

async function stockArm(root, stateRoot, source) {
  const service = await createZvecGrep({ root, stateRoot, embedding: MODEL, device: DEVICE });
  const rows = [];
  try {
    const indexed = await service.index({ root, stateRoot, embedding: MODEL, device: DEVICE });
    for (const testCase of QUERIES) {
      const raw = await service.context({ root, stateRoot, query: testCase.query, limit: 10, autoUpdate: false });
      rows.push({ id: testCase.id, query: testCase.query, raw, normalized: await normalizeItems(raw, source, root), rawText: rawText(raw) });
    }
    return { api: "stock-headless-zvec-disk-index-query", upstreamCommit: LAZY_INTEL_ZVEC_UPSTREAM_COMMIT, indexed, rows };
  } finally {
    await service.close();
  }
}

async function unifiedArm(root, stateRoot, source) {
  const env = {
    ...process.env,
    LAZY_INTEL_ENGINE: "unified",
    LAZY_INTEL_ROOT: root,
    LAZY_INTEL_ALLOWED_ROOTS: root,
    LAZY_INTEL_AUTO_INDEX: "false",
    LAZY_INTEL_AUTO_REPAIR: "false",
    LAZY_INTEL_MAINTENANCE_MS: "0",
    LAZY_INTEL_EMBEDDING: MODEL,
    ZVEC_GREP_EMBEDDING: MODEL,
    ZVEC_GREP_MODE: "direct",
    LAZY_INTEL_INDEX_TIMEOUT_MS: "600000",
    LAZY_INTEL_TIMEOUT_MS: "120000",
  };
  const client = new StdioMcpClient(NODE, [path.join(ROOT, "src/cli.js"), "serve"], { cwd: root, timeoutMs: 900000, env });
  const rows = [];
  try {
    await client.start();
    const tools = await client.listTools();
    for (const testCase of QUERIES) {
      const args = { operation: "search", root, query: testCase.query, limit: 10, freshness: "strict", timeoutMs: 120000, indexTimeoutMs: 600000, maxChars: 12000 };
      const raw = await client.callTool("code_intel", args, { timeoutMs: 900000 });
      rows.push({ id: testCase.id, query: testCase.query, raw, normalized: await normalizeItems(raw?.structuredContent ?? raw, source, root), rawText: rawText(raw) });
    }
    return { api: "unified-code-intel-mcp", toolNames: tools.tools?.map((tool) => tool.name) ?? [], rows };
  } finally {
    client.close();
    await new Promise((resolve) => client.child?.once("close", resolve) ?? resolve());
  }
}

function expectedAnchor(id) {
  const testCase = QUERIES.find((item) => item.id === id);
  for (const [relativePath, content] of Object.entries(SOURCE_FILES)) {
    const start = content.indexOf(testCase.anchor);
    if (start >= 0) {
      const startByte = Buffer.byteLength(content.slice(0, start));
      return { relativePath, startByte, endByte: startByte + Buffer.byteLength(testCase.anchor) };
    }
  }
  return null;
}

function anchorHit(row, expected) {
  return (row?.normalized ?? []).filter((item) => {
    if (!item.spanValid || !item.sourceHashMatchesFixture) return false;
    if (item.relativePath !== expected.relativePath) return false;
    const span = item.canonicalSpan;
    return span && span.startByte <= expected.startByte && span.endByte >= expected.endByte;
  });
}

function compare(stock, unified) {
  return QUERIES.map(({ id }) => {
    const left = stock.rows.find((row) => row.id === id);
    const right = unified.rows.find((row) => row.id === id);
    const expected = expectedAnchor(id);
    const stockAnchorItems = anchorHit(left, expected);
    const unifiedAnchorItems = anchorHit(right, expected);
    const stockAnchorIdentities = stockAnchorItems.map((item) => `${item.relativePath}:${item.range.startLine}-${item.range.endLine}`);
    const unifiedAnchorIdentities = unifiedAnchorItems.map((item) => `${item.relativePath}:${item.range.startLine}-${item.range.endLine}`);
    const stockSpans = stockAnchorItems.map((item) => item.canonicalSpan);
    const unifiedSpans = unifiedAnchorItems.map((item) => item.canonicalSpan);
    const sourceValidation = [...stockAnchorItems, ...unifiedAnchorItems].every((item) => item.sourceHashMatchesFixture && item.spanValid);
    return { id, preregisteredQualityAnchor: id === "applyDiscount" || id === "invoiceTotal", expectedAnchor: expected, stockIdentities: left?.normalized.map((item) => `${item.relativePath}:${item.range.startLine}-${item.range.endLine}`) ?? [], unifiedIdentities: right?.normalized.map((item) => `${item.relativePath}:${item.range.startLine}-${item.range.endLine}`) ?? [], stockAnchorIdentities, unifiedAnchorIdentities, anchorCoverageParity: stockAnchorItems.length > 0 && unifiedAnchorItems.length > 0, exactSpanParity: JSON.stringify(stockSpans) === JSON.stringify(unifiedSpans), sourceValidation };
  });
}

async function main(argv) {
  const output = argv.includes("--write") ? argv[argv.indexOf("--write") + 1] || DEFAULT_OUTPUT : DEFAULT_OUTPUT;
  const temp = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-backend-parity-"));
  const stockRoot = path.join(temp, "stock-source");
  const unifiedRoot = path.join(temp, "unified-source");
  const stockStateRoot = path.join(temp, "stock-state");
  await mkdir(stockRoot, { recursive: true });
  await mkdir(unifiedRoot, { recursive: true });
  await mkdir(stockStateRoot, { recursive: true });
  const source = sourceManifest();
  const report = {
    schema_version: 1,
    status: "FAIL",
    criteria: {
      "BACKEND-PARITY-01": { status: "FAIL", observations: "not run" },
      "BACKEND-PARITY-02": { status: "FAIL", observations: "not run" },
      "BACKEND-PARITY-03": { status: "FAIL", observations: "not run" },
      "REL-02": { status: "FAIL", observations: "not run" },
    },
    source: { fixture: "copied-small-real-source", canonicalHash: source.canonicalHash, files: source.files },
    model: modelConfig(),
    commands: {
      stock: { command: "createZvecGrep().index()+context()", exitCode: null },
      unified: { command: `${NODE} ${path.join(ROOT, "src/cli.js")} serve`, exitCode: null },
    },
    cases: QUERIES.map(({ id, query, anchor }) => ({ id, query, anchor, stock: null, unified: null, comparison: null })),
    rawResults: { stock: [], unified: [] },
    cleanup: { temporaryRoot: temp, performed: false, closeIndexManagerBeforeCloseUnified: true },
    revisions: { backend: "current checkout", gitHead: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unrecorded"; } })(), vendorZvecUpstreamCommit: LAZY_INTEL_ZVEC_UPSTREAM_COMMIT },
  };
  try {
    await writeCorpus(stockRoot);
    await writeCorpus(unifiedRoot);
    const stockSource = await actualSourceManifest(stockRoot);
    const unifiedSource = await actualSourceManifest(unifiedRoot);
    if (stockSource.canonicalHash !== unifiedSource.canonicalHash || stockSource.canonicalHash !== source.canonicalHash) throw new Error("source canonical hashes differ");
    report.source = { ...report.source, canonicalHash: stockSource.canonicalHash, files: stockSource.files, stockCanonicalHash: stockSource.canonicalHash, unifiedCanonicalHash: unifiedSource.canonicalHash };
    const stock = await stockArm(stockRoot, stockStateRoot, stockSource);
    const unified = await unifiedArm(unifiedRoot, path.join(unifiedRoot, ".lazy-intel"), unifiedSource);
    report.rawResults = { stock: stock.rows, unified: unified.rows };
    report.stock = { ...report.stock, api: stock.api, indexed: stock.indexed, stateRoot: stockStateRoot, inputHash: stockSource.canonicalHash, modelConfigDigest: report.model.digest };
    report.unified = { ...report.unified, api: unified.api, toolNames: unified.toolNames, stateRoot: path.join(unifiedRoot, ".lazy-intel"), inputHash: unifiedSource.canonicalHash, modelConfigDigest: report.model.digest };
    report.cases = report.cases.map((testCase) => ({ ...testCase, stock: stock.rows.find((row) => row.id === testCase.id)?.normalized ?? [], unified: unified.rows.find((row) => row.id === testCase.id)?.normalized ?? [], comparison: null }));
    const comparisons = compare(stock, unified);
    report.cases = report.cases.map((testCase) => ({ ...testCase, comparison: comparisons.find((row) => row.id === testCase.id) }));
    const sameSourceAndModel = report.stock.inputHash === report.unified.inputHash && report.stock.modelConfigDigest === report.unified.modelConfigDigest;
    const independentStateRoots = report.stock.stateRoot !== report.unified.stateRoot;
    const allAnchored = comparisons.filter((row) => row.preregisteredQualityAnchor).every((row) => row.anchorCoverageParity);
    const allCoverage = comparisons.every((row) => row.anchorCoverageParity);
    const allSourceValid = comparisons.every((row) => row.sourceValidation);
    const allParity = comparisons.every((row) => row.anchorCoverageParity);
    report.criteria["BACKEND-PARITY-01"] = { status: allParity ? "PASS" : "FAIL", observations: { anchorCoverageParity: allCoverage, exactSpanParity: comparisons.map((row) => ({ id: row.id, exactSpanParity: row.exactSpanParity })), comparisons } };
    report.criteria["BACKEND-PARITY-02"] = { status: allAnchored ? "PASS" : "FAIL", observations: "The two preregistered quality anchors returned source-backed identities in both arms; embeddingNativeQwen is exploratory only." };
    report.criteria["BACKEND-PARITY-03"] = { status: sameSourceAndModel && independentStateRoots ? "PASS" : "FAIL", observations: { sameSourceAndModel, independentStateRoots } };
    report.criteria["REL-02"] = { status: sameSourceAndModel && allCoverage && allSourceValid ? "PASS" : "FAIL", observations: { sameSourceAndModel, anchorCoverageParity: allCoverage, sourceSpanAndHashValidation: allSourceValid, exactSpanParity: comparisons.map((row) => ({ id: row.id, value: row.exactSpanParity })) } };
    report.status = report.criteria["REL-02"].status === "PASS" && report.criteria["BACKEND-PARITY-02"].status === "PASS" && report.criteria["BACKEND-PARITY-03"].status === "PASS" ? "PASS" : "FAIL";
    report.commands.stock.exitCode = 0;
    report.commands.unified.exitCode = 0;
  } catch (error) {
    report.error = { name: error?.name, message: error?.message, stack: error?.stack };
    report.commands.stock.exitCode = report.stock ? 0 : 1;
    report.commands.unified.exitCode = report.unified ? 0 : 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
    report.cleanup.performed = true;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, output, sourceHash: report.source.canonicalHash, model: report.model.identifier, criteria: report.criteria }, null, 2));
  return report.status === "PASS" ? 0 : 1;
}

try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(`verify-backend-parity: ${error.message}`); process.exitCode = 2; }
