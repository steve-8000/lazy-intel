import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { createRetrievalAdapter } from "../../packages/core/dist/adapters/retrieval.js";

function context(workspaceId, signal = new AbortController().signal, budgetMs = 30_000) {
  return {
    requestId: `retrieval-test-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    signal,
    deadlineMonotonicMs: performance.now() + budgetMs,
    maxEvidence: 20,
    maxOutputChars: 100_000,
    maxWireBytes: 8 * 1024 * 1024,
  };
}
function request(root, workspaceId, query, mode = "exact", limit = 20) {
  const alpha = "const needle = 1;\nexport function alpha() { return needle; }\n";
  const beta = "export function beta() { return 'other'; }\n";
  const snapshot = (fileId, relativePath, content) => ({
    fileId,
    relativePath,
    content,
    encoding: "utf-8",
    byteLength: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content).digest("hex"),
  });
  return {
    query,
    mode,
    limit,
    view: null,
    sources: [snapshot("alpha-file", "alpha.js", alpha), snapshot("beta-file", "beta.js", beta)],
    scope: {
      workspaceId,
      canonicalSourceRoot: root,
      canonicalStateRoot: path.join(root, ".state"),
      scopeDigest: "scope",
      buildContextDigest: null,
      trustedForLanguageTools: true,
    },
  };
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-"));
  await writeFile(path.join(root, "alpha.js"), "const needle = 1;\nexport function alpha() { return needle; }\n", "utf8");
  await writeFile(path.join(root, "beta.js"), "export function beta() { return 'other'; }\n", "utf8");
  return root;
}

function workerPids() {
  const rows = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  return rows.flatMap((row) => {
    if (!row.includes("workers/retrieval/main.mjs")) return [];
    const pid = Number.parseInt(row.trim().split(/\s+/, 1)[0] ?? "", 10);
    return Number.isInteger(pid) ? [pid] : [];
  });
}

test("retrieval maps real zvec context items to anchored evidence and empty results", async (t) => {
  const root = await makeWorkspace();
  await writeFile(path.join(root, "slow.txt"), "needle\n".repeat(1_000_000), "utf8");
  const adapter = createRetrievalAdapter({ workspaceId: "retrieval-anchor" });
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });

  const found = await adapter.read(request(root, "retrieval-anchor", "needle"), context("retrieval-anchor"));
  assert.ok(found.outcome === "ok" || found.outcome === "partial");
  assert.ok(found.evidence.length >= 1);
  const evidence = found.evidence[0];
  assert.ok(evidence.anchor);
  assert.equal(evidence.anchor.fileId, "alpha-file");
  assert.equal(evidence.anchor.span.coordinateSystem, "utf8-bytes");
  assert.ok(evidence.anchor.span.endByte > evidence.anchor.span.startByte);
  assert.equal(evidence.aliases[0].engine, "zvec");
  assert.equal(evidence.method, "lexical");
  const alphaText = "const needle = 1;\nexport function alpha() { return needle; }\n";
  const captured = Buffer.from(alphaText, "utf8").subarray(evidence.anchor.span.startByte, evidence.anchor.span.endByte).toString("utf8");
  assert.equal(evidence.textKind, "source");
  assert.equal(evidence.text, captured);
  assert.equal(evidence.sourceCheck, "unchecked");
  assert.match(found.coverage.scopeDescription, /source=rg/);

  const empty = await adapter.read(request(root, "retrieval-anchor", "not-present"), context("retrieval-anchor"));
  assert.equal(empty.outcome, "empty");
  assert.deepEqual(empty.evidence, []);

});
test("indexed retrieval requires clean publication and captured sources", async (t) => {
  const root = await makeWorkspace();
  const adapter = createRetrievalAdapter({ workspaceId: "retrieval-gate" });
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = request(root, "retrieval-gate", "needle", "lexical");
  const missingSources = await adapter.read(
    { ...base, sources: undefined, view: { state: "clean", storeRoot: path.join(root, ".state") } },
    context("retrieval-gate"),
  );
  assert.equal(missingSources.outcome, "unavailable");
  assert.equal(missingSources.issues[0].code, "invalid_input");
  const unpublished = await adapter.read(
    { ...base, view: { state: "needs_recovery", storeRoot: path.join(root, ".state") } },
    context("retrieval-gate"),
  );
  assert.equal(unpublished.outcome, "unavailable");
  assert.equal(unpublished.issues[0].code, "needs_recovery");
});

test("aborting a retrieval caller rejects as cancelled without killing the worker", async (t) => {
  const root = await makeWorkspace();
  const large = "needle\n".repeat(250_000);
  for (let index = 0; index < 8; index += 1) await writeFile(path.join(root, `large-${index}.txt`), large, "utf8");
  const adapter = createRetrievalAdapter({ workspaceId: "retrieval-cancel" });
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });

  // Warm the worker so the abort is during the library read, not startup.
  await adapter.read(request(root, "retrieval-cancel", "needle"), context("retrieval-cancel"));
  const controller = new AbortController();
  const pending = adapter.read(request(root, "retrieval-cancel", "needle", "exact", 1), context("retrieval-cancel", controller.signal, 30_000));
  setImmediate(() => controller.abort());
  await assert.rejects(pending, (error) => error?.code === "cancelled");

  const next = await adapter.read(request(root, "retrieval-cancel", "needle", "exact", 1), context("retrieval-cancel"));
  assert.ok(next.outcome === "ok" || next.outcome === "partial");
});
test("retrieval anchors UTF8 bytes from multibyte CRLF lexical columns", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lazy-intel-retrieval-unicode-anchor-"));
  const content = "é漢😀needle();\r\n";
  await writeFile(path.join(root, "unicode.js"), content, "utf8");
  const adapter = createRetrievalAdapter({ workspaceId: "retrieval-unicode-anchor" });
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = {
    fileId: "unicode-file",
    relativePath: "unicode.js",
    content,
    encoding: "utf-8",
    byteLength: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
  const result = await adapter.read(
    {
      query: "needle",
      mode: "exact",
      limit: 20,
      view: null,
      sources: [source],
      scope: {
        workspaceId: "retrieval-unicode-anchor",
        canonicalSourceRoot: root,
        canonicalStateRoot: path.join(root, ".state"),
        scopeDigest: "scope",
        buildContextDigest: null,
        trustedForLanguageTools: true,
      },
    },
    context("retrieval-unicode-anchor"),
  );
  assert.ok(result.evidence.length >= 1);
  const evidence = result.evidence[0];
  assert.equal(evidence.textKind, "source");
  assert.equal(evidence.text, "needle");
  assert.equal(Buffer.from(content, "utf8").subarray(evidence.anchor.span.startByte, evidence.anchor.span.endByte).toString("utf8"), "needle");
  assert.equal(evidence.anchor.span.startByte, Buffer.byteLength("é漢😀", "utf8"));
});
