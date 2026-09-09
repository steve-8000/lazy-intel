import { resolveBin, run } from "../lib/process.js";
import { ensureIndexes } from "../index-manager.js";

export async function codegraphQuery(kind, input, signal) {
  if (kind === "impact" && !input.symbol?.trim()) throw new Error("impact requires symbol");
  const [ready] = await ensureIndexes(input.root, ["codegraph"], {
    freshness: input.freshness,
    timeoutMs: input.indexTimeoutMs,
    signal,
  });
  if (!ready?.ok) return failed("codegraph", `index unavailable: ${ready?.error ?? ready?.action ?? "unknown"}`);

  const args = kind === "impact"
    ? ["impact", input.symbol, "--path", input.root, "--depth", String(input.depth ?? 2), "--json"]
    : ["explore", input.query, "--path", input.root, "--max-files", String(Math.max(1, Math.min(input.limit, 12)))];
  try {
    const bin = await resolveBin("codegraph");
    const result = await run(bin, args, {
      cwd: input.root,
      timeoutMs: input.timeoutMs,
      signal,
      env: { DO_NOT_TRACK: "1" },
    });
    return { backend: "codegraph", ok: true, text: result.stdout, latencyMs: result.latencyMs };
  } catch (error) {
    return failed("codegraph", error.message, error.result?.latencyMs);
  }
}

function failed(backend, warning, latencyMs) { return { backend, ok: false, warning, text: "", latencyMs }; }
