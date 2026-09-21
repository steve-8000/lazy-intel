import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, routesOf } from "../src/plan.js";
import { route } from "../src/router.js";

test("diagnostics intent with a path does not need a symbol", () => {
  // BASE-02: the diagnostics check used to sit inside the `input.symbol` branch, so a
  // diagnostics question about a file was answered by semantic search instead.
  assert.deepEqual(route({ operation: "auto", query: "diagnostics", relativePath: "src/a.js" }), ["serena:diagnostics"]);
  assert.deepEqual(route({ operation: "auto", query: "컴파일 오류", relativePath: "src/a.js" }), ["serena:diagnostics"]);
});

test("an explicit primitive performs exactly one semantic read", () => {
  for (const operation of ["search", "architecture", "impact", "symbol", "references", "implementations", "diagnostics"]) {
    const plan = createPlan({ operation, symbol: "Foo", relativePath: "src/a.js" });
    assert.equal(plan.mode, "explicit_primitive");
    assert.equal(plan.maxLogicalCalls, 1, `${operation} must not fan out`);
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].reads[0].role, "required");
  }
});

test("auto stays within two logical reads and one dependent stage", () => {
  const inputs = [
    { query: "where is metadata normalized?" },
    { query: "trace call flow from index to UI" },
    { query: "find references", symbol: "Foo/bar" },
    { query: "find references", symbol: "Foo/bar", relativePath: "src/a.js" },
    { query: "blast radius", symbol: "commit" },
    { query: "implementations", symbol: "Store" },
  ];
  for (const input of inputs) {
    const plan = createPlan({ operation: "auto", ...input });
    assert.ok(plan.maxLogicalCalls <= 2, `${input.query} exceeded the auto read budget`);
    assert.ok(plan.stages.length <= 2);
    assert.ok(plan.stages.every((s) => s.reads.length <= 2));
    assert.equal(plan.stages.filter((s) => s.when !== "always").length <= 1, true);
    assert.equal(plan.maxPhysicalAttempts, plan.maxLogicalCalls + 1);
  }
});

test("a dependent reference lookup requires a validated unique subject", () => {
  const plan = createPlan({ operation: "auto", query: "usages", symbol: "Foo/bar" });
  const [first, second] = plan.stages;
  assert.equal(first.reads[0].operation, "symbol");
  assert.equal(second.when, "validated_unique_subject");
  assert.equal(second.reads[0].inputSource, "validated_unique_subject");
  assert.deepEqual(plan.requiredObligations, ["subject_definition", "references_of_subject"]);
});

test("a reference question with no subject degrades to discovery instead of an unmeetable obligation", () => {
  const plan = createPlan({ operation: "auto", query: "어디서 쓰이나" });
  assert.deepEqual(routesOf(plan), ["zvec:search"]);
  assert.deepEqual(plan.requiredObligations, ["semantic_discovery"]);
});

test("context is a declared composite with a gated second stage", () => {
  const plan = createPlan({ operation: "context", query: "photo indexing" });
  assert.equal(plan.mode, "declared_context");
  assert.deepEqual(routesOf(plan), ["codegraph:context", "zvec:search", "serena:symbol"]);
  assert.equal(plan.maxLogicalCalls, 3);
  assert.equal(plan.maxPhysicalAttempts, 4);
  assert.equal(plan.retryBudget, 1);
  // Only the graph overview is owed; discovery and the anchor lookup are enrichment.
  assert.deepEqual(plan.requiredObligations, ["context_overview"]);
  assert.equal(plan.stages[1].when, "validated_unique_subject");
});

test("control operations produce no plan", () => {
  for (const operation of ["status", "sync", "reindex", "repair"]) {
    assert.equal(createPlan({ operation }), null);
    assert.deepEqual(route({ operation, query: "" }), []);
  }
});
