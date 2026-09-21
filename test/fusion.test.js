import test from "node:test";
import assert from "node:assert/strict";
import { fuse } from "../src/fusion.js";

test("truth order is Serena then CodeGraph then zvec", () => {
  const text = fuse([
    { backend: "zvec", ok: true, text: "zzz-retrieval", latencyMs: 1 },
    { backend: "serena", ok: true, text: "sss-semantic", latencyMs: 1 },
    { backend: "codegraph", ok: true, text: "ccc-structural", latencyMs: 1 },
  ], { maxChars: 6000 });
  assert.ok(text.indexOf("sss-semantic") < text.indexOf("ccc-structural"));
  assert.ok(text.indexOf("ccc-structural") < text.indexOf("zzz-retrieval"));
});

test("degraded backend is surfaced without failing good evidence", () => {
  const text = fuse([
    { backend: "codegraph", ok: true, text: "good", latencyMs: 2 },
    { backend: "zvec", ok: false, warning: "missing index", text: "" },
  ]);
  assert.match(text, /good/);
  assert.match(text, /missing index/);
});

test("the character budget covers the whole response, not each section", () => {
  // BASE-01: a 4,000-character cap used to emit 4,319 characters because headings,
  // per-section budgets and the footer were all accounted for separately.
  const body = "x".repeat(2_000);
  const text = fuse([
    { backend: "serena", ok: true, text: body, latencyMs: 1 },
    { backend: "zvec", ok: true, text: body, latencyMs: 1 },
  ], { maxChars: 4_000 });
  assert.ok(text.length <= 4_000 + 2, `response was ${text.length} characters`);
});
