import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  return {
    query,
    mode,
    limit,
    view: null,
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
  assert.equal(evidence.anchor.fileId, "zvec:retrieval-anchor:alpha.js");
  assert.equal(evidence.anchor.span.coordinateSystem, "utf8-bytes");
  assert.ok(evidence.anchor.span.endByte > evidence.anchor.span.startByte);
  assert.equal(evidence.aliases[0].engine, "zvec");
  assert.equal(evidence.method, "lexical");
  assert.match(found.coverage.scopeDescription, /source=rg/);

  const empty = await adapter.read(request(root, "retrieval-anchor", "not-present"), context("retrieval-anchor"));
  assert.equal(empty.outcome, "empty");
  assert.deepEqual(empty.evidence, []);

  // A direct worker crash is reported by the supervisor, and the next read starts
  // a fresh epoch instead of reusing the dead process.
  const crashPending = adapter.read(request(root, "retrieval-anchor", "needle"), context("retrieval-anchor"));
  await new Promise((resolve) => setImmediate(resolve));
  const [pid] = workerPids();
  assert.ok(pid, "retrieval worker should be running");
  process.kill(pid, "SIGKILL");
  const crashed = await crashPending;
  assert.equal(crashed.outcome, "unavailable");
  assert.equal(crashed.issues[0].code, "worker_failed");
  assert.equal(crashed.issues[0].retryable, true);
  const afterCrash = await adapter.read(request(root, "retrieval-anchor", "needle"), context("retrieval-anchor"));
  assert.ok(afterCrash.outcome === "ok" || afterCrash.outcome === "partial");
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
