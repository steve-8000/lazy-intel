const ARCH = /\b(architecture|architectural|call\s*flow|call\s*path|dependency|dependencies|depends|blast\s*radius|data\s*flow|control\s*flow|trace|reach(?:es)?|caller|callee|impact)\b|아키텍처|호출\s*(흐름|경로)|의존|영향\s*범위|데이터\s*흐름|트레이스|콜러|콜리/iu;
const REFS = /\b(reference|references|referencing|usage|usages|used\s+by)\b|참조|사용처|어디서\s*쓰/iu;
const IMPL = /\b(implementation|implementations|implements|implementors|concrete)\b|구현체|구현\s*(찾|목록)/iu;
const DIAG = /\b(diagnostic|diagnostics|error|warning|lsp)\b|진단|컴파일\s*오류|경고/iu;
const IMPACT = /\b(impact|blast\s*radius|affected|what\s+breaks)\b|영향\s*범위|어디까지\s*영향|깨지는/iu;

export const OPERATIONS = ["auto", "search", "architecture", "symbol", "references", "implementations", "diagnostics", "impact", "status", "sync", "reindex", "repair"];

export function route(input) {
  const operation = input.operation ?? "auto";
  if (!OPERATIONS.includes(operation)) throw new Error(`unsupported operation: ${operation}`);
  if (["status", "sync", "reindex", "repair"].includes(operation)) return [];
  if (operation !== "auto") return explicitRoute(operation, input);

  const query = input.query ?? "";
  if (input.symbol) {
    if (DIAG.test(query) && input.relativePath) return ["serena:diagnostics"];
    if (REFS.test(query)) return input.relativePath ? ["serena:references"] : ["serena:symbol", "codegraph:architecture"];
    if (IMPL.test(query)) return input.relativePath ? ["serena:implementations"] : ["serena:symbol", "codegraph:architecture"];
    if (IMPACT.test(query)) return ["codegraph:impact", "serena:symbol"];
    if (ARCH.test(query)) return ["codegraph:architecture", "serena:symbol"];
    return ["serena:symbol"];
  }

  if (ARCH.test(query) || REFS.test(query) || IMPL.test(query) || IMPACT.test(query)) return ["codegraph:architecture", "zvec:search"];
  return ["zvec:search"];
}

function explicitRoute(operation) {
  switch (operation) {
    case "search": return ["zvec:search"];
    case "architecture": return ["codegraph:architecture"];
    case "impact": return ["codegraph:impact"];
    case "symbol": return ["serena:symbol"];
    case "references": return ["serena:references"];
    case "implementations": return ["serena:implementations"];
    case "diagnostics": return ["serena:diagnostics"];
    default: return [];
  }
}
