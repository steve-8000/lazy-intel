import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSemanticAdapter } from "../packages/core/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const workerPath = join(root, "workers/semantic/main.mjs");
const context = {
  requestId: "semantic-negative-proof",
  workspaceId: "semantic-negative-proof",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 30_000,
  maxEvidence: 20,
  maxOutputChars: 100_000,
  maxWireBytes: 1_000_000,
};
async function makeProducer(directory) {
  const producer = join(directory, "controlled-semantic-producer.mjs");
  await writeFile(producer, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createHash } from "node:crypto";
const mode = process.env.LAZY_INTEL_SEMANTIC_MODE;
const root = process.env.LAZY_INTEL_SEMANTIC_ROOT;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const bytes = readFileSync(join(root, "clean.py"));
  const own = { sessionEpoch: "controlled", positionEncoding: "utf-16", ...(mode === "missing-scope" ? {} : { scope: mode === "invalid-scope" ? "bogus" : mode === "unknown-scope" ? "unknown" : "own-buffer" }), documentVersion: 1, fileHash: hash(bytes), bufferHash: hash(bytes), relativePath: "clean.py" };
  let items = [];
  if (mode !== "unknown-scope-empty") {
    const item = { name: "controlled", body: "SECRET_EXTERNAL_BODY", relative_path: "clean.py", file_hash: hash(bytes), location: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } };
    if (mode === "valid") item.body = bytes.subarray(0, 1).toString("utf8");
    if (mode === "missing-path") delete item.relative_path;
    if (mode === "missing-location") delete item.location;
    if (mode === "out-of-range") item.location.range = { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } };
    if (mode === "utf16-surrogate") item.location.range = { start: { line: 1, character: 20 }, end: { line: 1, character: 21 } };
    if (mode === "path-escape") item.relative_path = "../semantic-secret.txt";
    if (mode === "absolute-path") item.relative_path = process.env.LAZY_INTEL_SEMANTIC_ABSOLUTE;
    if (mode === "absolute-uri") item.relative_path = "file://" + process.env.LAZY_INTEL_SEMANTIC_ABSOLUTE;
    if (mode === "outside-symlink") item.relative_path = "escape.py";
    items = [item];
  }
  process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, payload: { items, observation: mode.startsWith("unknown-scope") ? { ...own, scope: "unknown" } : own } }) + "\\n");
}
`, "utf8");
  await chmod(producer, 0o755);
  return producer;
}

async function runCase({ mode, producer, workspace, absolute }) {
  const adapter = createSemanticAdapter({
    workspaceId: "semantic-negative-proof",
    sourceRoot: workspace,
    scopeDigest: "negative-proof",
    language: "python",
    languageServerPath: producer,
    trustedForLanguageTools: true,
    workerPath,
    workerEnv: { LAZY_INTEL_PYTHON: producer, LAZY_INTEL_SEMANTIC_MODE: mode, LAZY_INTEL_SEMANTIC_ROOT: workspace, ...(absolute ? { LAZY_INTEL_SEMANTIC_ABSOLUTE: absolute } : {}) },
  });
  try {
    const request = mode === "missing-path"
      ? { operation: "symbol", subject: { namePath: "controlled", relativePath: null }, relativePath: null, includeBody: true }
      : { operation: "symbol", subject: { namePath: "controlled", relativePath: "clean.py" }, relativePath: "clean.py", includeBody: true };
    return await adapter.read(request, context);
  } finally {
    await adapter.close();
  }
}

test("semantic adapter refuses malformed, unknown-scope, and escaping anchors", async () => {
  const base = await mkdtemp(join(tmpdir(), "lazy-semantic-negative-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "semantic-secret.txt");
  await mkdir(workspace);
  try {
    const source = Buffer.from("def ok(value: str):\r\n    return value  # 😀\r\n", "utf8");
    await writeFile(join(workspace, "clean.py"), source);
    await writeFile(outside, Buffer.from("SECRET_OUTSIDE", "utf8"));
    await symlink(outside, join(workspace, "escape.py"));
    const producer = await makeProducer(workspace);
    const valid = await runCase({ mode: "valid", producer, workspace });
    assert.equal(valid.outcome, "ok", JSON.stringify(valid));
    assert.equal(valid.coverage.completeWithinScope, true);
    assert.equal(valid.evidence[0].text, "d");
    assert.deepEqual(valid.evidence[0].anchor.span, { coordinateSystem: "utf8-bytes", startByte: 0, endByte: 1 });
    for (const mode of ["missing-path", "missing-location", "out-of-range", "utf16-surrogate", "missing-scope", "invalid-scope", "path-escape", "absolute-path", "absolute-uri", "outside-symlink"]) {
      const result = await runCase({ mode, producer, workspace, absolute: outside });
      assert.equal(result.outcome, "partial", `${mode}: ${JSON.stringify(result)}`);
      assert.equal(result.coverage.completeWithinScope, false, mode);
      assert.ok(result.issues.length > 0, `${mode}: missing honest issue`);
      assert.ok(result.evidence.every((entry) => entry.anchor === null), `${mode}: malformed result was anchored`);
      assert.ok(result.evidence.every((entry) => !String(entry.text ?? "").includes("SECRET")), `${mode}: external body leaked`);
    }
    const unknown = await runCase({ mode: "unknown-scope-empty", producer, workspace });
    assert.equal(unknown.outcome, "partial");
    assert.equal(unknown.coverage.completeWithinScope, false);
    assert.equal(unknown.evidence.length, 0);
    assert.ok(unknown.issues.length > 0);
    assert.equal(unknown.semanticObservations[0].scope, "unknown");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
