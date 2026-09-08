const TRUTH_ORDER = { serena: 0, codegraph: 1, zvec: 2 };

export function fuse(results, options = {}) {
  const maxChars = options.maxChars ?? 24_000;
  const ok = results.filter((r) => r.ok && r.text).sort((a, b) => TRUTH_ORDER[a.backend] - TRUTH_ORDER[b.backend]);
  const warnings = results.filter((r) => !r.ok).map((r) => `${r.backend}: ${r.warning ?? "unavailable"}`);
  const per = Math.max(2_000, Math.floor(maxChars / Math.max(1, ok.length)));
  const sections = [];

  for (const result of ok) {
    const text = truncate(result.text, per);
    sections.push(`## ${label(result.backend)}\n${text}\n\n_latency: ${result.latencyMs ?? "?"}ms_`);
  }
  if (!sections.length) sections.push("No code-intelligence backend returned usable evidence.");
  if (warnings.length) sections.push(`## Degraded backends\n${warnings.map((w) => `- ${w}`).join("\n")}`);
  sections.push("## Evidence priority\ncurrent source/compiler > live LSP (Serena) > indexed graph (CodeGraph) > retrieval relevance (zvec). Verify correctness with OMP native source/build/tests before editing or claiming completion.");
  return sections.join("\n\n");
}

function label(name) {
  if (name === "serena") return "Semantic evidence · Serena/LSP";
  if (name === "codegraph") return "Structural evidence · CodeGraph";
  if (name === "zvec") return "Retrieval evidence · zvec-grep";
  return name;
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 100) / 2);
  return `${text.slice(0, half)}\n\n… [lazy-intel truncated ${text.length - maxChars} chars] …\n\n${text.slice(-half)}`;
}
