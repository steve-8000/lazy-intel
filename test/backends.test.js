import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseZvecResponse } from "../src/backends/zvec.js";
import { parseCodegraphResponse } from "../src/backends/codegraph.js";
import { parseSerenaResponse, serenaPool } from "../src/backends/serena.js";

const fixture = async (backend, name) => JSON.parse(await readFile(new URL(`./fixtures/${backend}/${name}.json`, import.meta.url), "utf8"));

 test("real zvec success stays bounded opaque evidence", async () => {
  const f = await fixture("zvec", "success");
  const parsed = parseZvecResponse(f.stdout, { operation: "search" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outcome, "ok");
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.opaque.length, 1);
  assert.match(parsed.opaque[0].text, /src\/main\.js/);
 });

test("real zvec zero result is the versioned No matches response", async () => {
  const f = await fixture("zvec", "zero-result");
  const parsed = parseZvecResponse(f.stdout, { operation: "search" });
  assert.equal(parsed.outcome, "empty");
  assert.equal(parsed.returned, 0);
  assert.equal(parsed.opaque.length, 0);
});

test("blank zvec output is malformed, never empty", () => {
  const parsed = parseZvecResponse("", { operation: "search" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "MALFORMED_RESPONSE");
});

test("real CodeGraph architecture output remains opaque and zero output is empty", async () => {
  const success = await fixture("codegraph", "success");
  const zero = await fixture("codegraph", "zero-result");
  const parsedSuccess = parseCodegraphResponse(success.stdout, { operation: "architecture" });
  const parsedZero = parseCodegraphResponse(zero.stdout, { operation: "architecture" });
  assert.equal(parsedSuccess.outcome, "ok");
  assert.equal(parsedSuccess.items.length, 0);
  assert.equal(parsedSuccess.opaque[0].reason, "documented_text_format");
  assert.equal(parsedZero.outcome, "empty");
});

test("real CodeGraph limited explore preserves truncation", async () => {
  const f = await fixture("codegraph", "truncated-limited");
  const parsed = parseCodegraphResponse(f.stdout, { operation: "architecture" });
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.opaque.length, 1);
});

test("fixture-proven CodeGraph impact JSON yields indexed evidence", async () => {
  const f = await fixture("codegraph", "impact-json");
  const parsed = parseCodegraphResponse(f.stdout, { operation: "impact", root: "/fixture" });
  assert.equal(parsed.outcome, "ok");
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].locator.range.startLine, 0);
  assert.equal(parsed.items[0].method, "indexed_graph");
});

test("unknown CodeGraph impact JSON shape is opaque, not a graph claim", () => {
  const parsed = parseCodegraphResponse(JSON.stringify({ arbitrary: [{ path: "src/main.js", line: 1 }] }), { operation: "impact" });
  assert.equal(parsed.outcome, "ok");
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.opaque[0].reason, "unsupported_shape");
});

test("real Serena success and zero responses use the known JSON text body", async () => {
  const success = await fixture("serena", "success");
  const zero = await fixture("serena", "zero-result");
  const successMessages = JSON.parse(success.stdout);
  const zeroMessages = JSON.parse(zero.stdout);
  const parsedSuccess = parseSerenaResponse(successMessages.at(-1).result, { operation: "symbol", root: "/fixture" });
  const parsedZero = parseSerenaResponse(zeroMessages.at(-1).result, { operation: "symbol", root: "/fixture" });
  assert.equal(parsedSuccess.outcome, "ok");
  assert.equal(parsedSuccess.items.length, 1);
  assert.equal(parsedSuccess.items[0].locator.range.startLine, 0);
  assert.equal(parsedSuccess.items[0].locator.range.endLineExclusive, 1);
  assert.equal(parsedZero.outcome, "empty");
});

test("real Serena limited response is OUTPUT_LIMIT, not empty", async () => {
  const f = await fixture("serena", "truncated-limited");
  const messages = JSON.parse(f.stdout);
  const parsed = parseSerenaResponse(messages.at(-1).result, { operation: "symbol", root: "/fixture" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "OUTPUT_LIMIT");
  assert.equal(parsed.truncated, true);
});

test("Serena isError maps to TOOL_ERROR without invalidating the pool record", async () => {
  const f = await fixture("serena", "error");
  const messages = JSON.parse(f.stdout);
  const root = "/fixture-pool";
  const record = { generation: 77, client: { closed: false }, tools: new Map(), ready: true, waiters: 0, lastUsed: Date.now() };
  serenaPool.clients.set(root, record);
  try {
    const parsed = parseSerenaResponse(messages.at(-1).result, { operation: "symbol", root });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "TOOL_ERROR");
    assert.equal(serenaPool.clients.get(root), record);
    assert.equal(serenaPool.clients.get(root).generation, 77);
  } finally { serenaPool.clients.delete(root); }
});
