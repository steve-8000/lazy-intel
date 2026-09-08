import test from "node:test";
import assert from "node:assert/strict";
import { fuse } from "../src/fusion.js";

test("truth order is Serena then CodeGraph then zvec", () => {
  const text = fuse([
    { backend: "zvec", ok: true, text: "z", latencyMs: 1 },
    { backend: "serena", ok: true, text: "s", latencyMs: 1 },
    { backend: "codegraph", ok: true, text: "c", latencyMs: 1 },
  ], { maxChars: 6000 });
  assert.ok(text.indexOf("Semantic evidence") < text.indexOf("Structural evidence"));
  assert.ok(text.indexOf("Structural evidence") < text.indexOf("Retrieval evidence"));
});

test("degraded backend is surfaced without failing good evidence", () => {
  const text = fuse([
    { backend: "codegraph", ok: true, text: "good", latencyMs: 2 },
    { backend: "zvec", ok: false, warning: "missing index", text: "" },
  ]);
  assert.match(text, /good/);
  assert.match(text, /missing index/);
});
