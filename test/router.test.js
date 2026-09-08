import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.js";

test("semantic discovery routes only to zvec", () => {
  assert.deepEqual(route({ operation: "auto", query: "where is photo metadata normalized?" }), ["zvec:search"]);
});

test("architecture routes graph plus retrieval", () => {
  assert.deepEqual(route({ operation: "auto", query: "trace call flow from index update to search UI" }), ["codegraph:architecture", "zvec:search"]);
});

test("known references use Serena", () => {
  assert.deepEqual(route({ operation: "auto", query: "find references", symbol: "PhotoIndex/update", relativePath: "Sources/PhotoIndex.swift" }), ["serena:references"]);
});

test("impact of known symbol is bounded to two backends", () => {
  assert.deepEqual(route({ operation: "auto", query: "blast radius", symbol: "commit" }), ["codegraph:impact", "serena:symbol"]);
});


test("control operations bypass intelligence routing", () => {
  assert.deepEqual(route({ operation: "reindex", query: "" }), []);
  assert.deepEqual(route({ operation: "repair", query: "" }), []);
});
