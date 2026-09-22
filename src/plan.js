import { CONTROL_OPERATIONS } from "./contracts.js";

// Intent detection stays deliberately lexical and deterministic: the same question always
// produces the same plan, and nothing here consults a model. Korean alternatives exist
// because the agent's questions arrive in both languages.
const ARCH = /\b(architecture|architectural|call\s*flow|call\s*path|dependency|dependencies|depends|blast\s*radius|data\s*flow|control\s*flow|trace|reach(?:es)?|caller|callee|impact)\b|아키텍처|호출\s*(흐름|경로)|의존|영향\s*범위|데이터\s*흐름|트레이스|콜러|콜리/iu;
const REFS = /\b(reference|references|referencing|usage|usages|used\s+by)\b|참조|사용처|어디서\s*쓰/iu;
const IMPL = /\b(implementation|implementations|implements|implementors|concrete)\b|구현체|구현\s*(찾|목록)/iu;
const DIAG = /\b(diagnostic|diagnostics|error|warning|lsp)\b|진단|컴파일\s*오류|경고/iu;
const IMPACT = /\b(impact|blast\s*radius|affected|what\s+breaks)\b|영향\s*범위|어디까지\s*영향|깨지는/iu;

export function detectIntent(query = "") {
  return {
    diagnostics: DIAG.test(query),
    references: REFS.test(query),
    implementations: IMPL.test(query),
    impact: IMPACT.test(query),
    architecture: ARCH.test(query),
  };
}

/**
 * Fixed execution plans.
 *
 * A plan is decided before any backend runs and never grows while executing: there is no
 * model in this loop deciding it needs one more call. An explicit primitive performs one
 * semantic operation and is never quietly satisfied by a different backend answering a
 * different question. `auto` is bounded at two logical reads with at most one dependent
 * stage, and `context` is the only composite, with its stages declared in the tool schema.
 */

/** Semantic obligations. A plan succeeds when its required obligations are met, not when some backend replied. */
export const OBLIGATIONS = {
  semantic_discovery: "semantic_discovery",
  architecture_overview: "architecture_overview",
  impact_of_subject: "impact_of_subject",
  subject_definition: "subject_definition",
  references_of_subject: "references_of_subject",
  implementations_of_subject: "implementations_of_subject",
  diagnostics_for_file: "diagnostics_for_file",
  context_overview: "context_overview",
};

const PRIMITIVE_READS = {
  search: { backend: "zvec", operation: "search", obligation: OBLIGATIONS.semantic_discovery },
  architecture: { backend: "codegraph", operation: "architecture", obligation: OBLIGATIONS.architecture_overview },
  impact: { backend: "codegraph", operation: "impact", obligation: OBLIGATIONS.impact_of_subject },
  subject: { backend: "codegraph", operation: "context", obligation: OBLIGATIONS.subject_definition },
  symbol: { backend: "serena", operation: "symbol", obligation: OBLIGATIONS.subject_definition },
  references: { backend: "serena", operation: "references", obligation: OBLIGATIONS.references_of_subject },
  implementations: { backend: "serena", operation: "implementations", obligation: OBLIGATIONS.implementations_of_subject },
  diagnostics: { backend: "serena", operation: "diagnostics", obligation: OBLIGATIONS.diagnostics_for_file },
};

function read(spec, { role = "required", inputSource = "request", id }) {
  return {
    id,
    backend: spec.backend,
    operation: spec.operation,
    role,
    obligation: spec.obligation,
    inputSource,
  };
}

function stage(id, reads, when = "always") {
  if (reads.length > 2) throw new Error(`plan stage ${id} exceeds the two-read fan-out limit`);
  return { id, reads, when };
}

function plan(mode, requestedOperation, stages) {
  const logical = stages.reduce((sum, s) => sum + s.reads.length, 0);
  const requiredObligations = [...new Set(
    stages.flatMap((s) => s.reads.filter((r) => r.role === "required").map((r) => r.obligation)),
  )];
  return {
    mode,
    requestedOperation,
    stages,
    maxLogicalCalls: logical,
    // One shared transport retry for the whole request, so physical attempts stay bounded
    // at logical + 1. Prepare, status probes and handshakes are counted separately but
    // still spend the same request deadline.
    maxPhysicalAttempts: logical + 1,
    retryBudget: 1,
    requiredObligations,
  };
}

/**
 * @returns {object|null} null for control operations, which keep their own path.
 */
export function createPlan(input) {
  const operation = input.operation ?? "auto";
  if (CONTROL_OPERATIONS.has(operation)) return null;
  if (operation === "context") return contextPlan();
  if (operation === "auto") return autoPlan(input);
  const spec = PRIMITIVE_READS[operation];
  if (!spec) throw new Error(`unsupported operation: ${operation}`);
  return plan("explicit_primitive", operation, [stage("s1", [read(spec, { id: "s1r1" })])]);
}

function contextPlan() {
  return plan("declared_context", "context", [
    // Both stage-1 reads carry the same obligation: context is a discovery composite, so
    // either source satisfies it and one backend failing degrades coverage rather than
    // failing the request. Neither read is allowed to answer a different question.
    stage("s1", [
      read({ backend: "codegraph", operation: "context", obligation: OBLIGATIONS.context_overview }, { id: "s1r1" }),
      read({ ...PRIMITIVE_READS.search, obligation: OBLIGATIONS.context_overview }, { id: "s1r2" }),
    ]),
    // Stage 2 exists only to anchor a subject the first stage already resolved uniquely and
    // typed. It is not a "pick the highest scoring candidate" step.
    stage("s2", [read(PRIMITIVE_READS.symbol, { id: "s2r1", role: "optional", inputSource: "validated_unique_subject" })], "validated_unique_subject"),
  ]);
}

function autoPlan(input) {
  const intent = detectIntent(input.query ?? "");
  const hasSymbol = Boolean(input.symbol);
  const hasPath = Boolean(input.relativePath);

  // Diagnostics are judged before any symbol condition: a file path is the whole subject,
  // and requiring a symbol here is what sent `auto + diagnostics + relativePath` to zvec.
  if (intent.diagnostics && hasPath) {
    return plan("auto", "auto", [stage("s1", [read(PRIMITIVE_READS.diagnostics, { id: "s1r1" })])]);
  }

  for (const kind of ["references", "implementations"]) {
    if (!intent[kind]) continue;
    if (hasSymbol && hasPath) {
      return plan("auto", "auto", [stage("s1", [read(PRIMITIVE_READS[kind], { id: "s1r1" })])]);
    }
    if (hasSymbol) {
      // Resolve the subject first, then ask the dependent question only if exactly one
      // typed candidate inside the root came back. A guessed path is never good enough.
      return plan("auto", "auto", [
        stage("s1", [read(PRIMITIVE_READS.subject, { id: "s1r1" })]),
        stage("s2", [read(PRIMITIVE_READS[kind], { id: "s2r1", inputSource: "validated_unique_subject" })], "validated_unique_subject"),
      ]);
    }
    // No subject was supplied at all, so there is no reference question to fulfil yet;
    // discovery is the honest plan rather than a required obligation that cannot be met.
    return discoveryPlan();
  }

  if (intent.impact) {
    if (hasSymbol) {
      if (!hasPath) return plan("auto", "auto", [stage("s1", [read(PRIMITIVE_READS.impact, { id: "s1r1" })])]);
      return plan("auto", "auto", [stage("s1", [
        read(PRIMITIVE_READS.impact, { id: "s1r1" }),
        read(PRIMITIVE_READS.symbol, { id: "s1r2", role: "optional" }),
      ])]);
    }
    return discoveryPlan();
  }

  if (intent.architecture) {
    return plan("auto", "auto", [stage("s1", hasSymbol && hasPath
      ? [read(PRIMITIVE_READS.architecture, { id: "s1r1" }), read(PRIMITIVE_READS.symbol, { id: "s1r2", role: "optional" })]
      : hasSymbol
        ? [read(PRIMITIVE_READS.architecture, { id: "s1r1" })]
        : [read(PRIMITIVE_READS.architecture, { id: "s1r1" }), read(PRIMITIVE_READS.search, { id: "s1r2", role: "optional" })])]);
  }

  if (hasSymbol && hasPath) return plan("auto", "auto", [stage("s1", [read(PRIMITIVE_READS.symbol, { id: "s1r1" })])]);
  if (hasSymbol) {
    return plan("auto", "auto", [
      stage("s1", [read(PRIMITIVE_READS.subject, { id: "s1r1" })]),
      stage("s2", [read(PRIMITIVE_READS.symbol, { id: "s2r1", role: "optional", inputSource: "validated_unique_subject" })], "validated_unique_subject"),
    ]);
  }
  return discoveryPlan();
}

function discoveryPlan() {
  return plan("auto", "auto", [stage("s1", [read(PRIMITIVE_READS.search, { id: "s1r1" })])]);
}

/** Legacy `meta.routes` view: `backend:operation` in execution order. */
export function routesOf(queryPlan) {
  if (!queryPlan) return [];
  return queryPlan.stages.flatMap((s) => s.reads.map((r) => `${r.backend}:${r.operation}`));
}

/** Reads of one stage, in fan-out order. */
export function stageReads(queryPlan, stageId) {
  return queryPlan.stages.find((s) => s.id === stageId)?.reads ?? [];
}
