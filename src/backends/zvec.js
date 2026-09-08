import { resolveBin, run } from "../lib/process.js";
import { ensureIndexes } from "../index-manager.js";

const MODE = process.env.LAZY_INTEL_ZVEC_MODE ?? "auto";
// Daemon-side refresh: the shared zvec-grep server keeps the index warm, so a query
// never needs an extra local index pass.
const REFRESH = { strict: "wait", auto: "background", fast: "off" };

export async function zvecSearch(input, signal) {
  const [ready] = await ensureIndexes(input.root, ["zvec"], {
    freshness: input.freshness,
    timeoutMs: input.indexTimeoutMs,
    signal,
  });
  if (!ready?.ok) return failed("zvec", `index unavailable: ${ready?.error ?? ready?.action ?? "unknown"}`);
  if (ready.action === "building") return failed("zvec", `index is still building: ${ready.detail ?? "indexing"}`);

  const args = [
    "query", input.query,
    "--mode", MODE,
    "--refresh", REFRESH[input.freshness] ?? "background",
    "--limit", String(input.limit),
    "--preview", input.includeBody ? "full" : "short",
  ];
  try {
    const zg = await resolveBin("zg");
    const result = await run(zg, args, { cwd: input.root, timeoutMs: input.timeoutMs, signal });
    return { backend: "zvec", ok: true, text: result.stdout, latencyMs: result.latencyMs };
  } catch (error) {
    return failed("zvec", error.message, error.result?.latencyMs);
  }
}

function failed(backend, warning, latencyMs) { return { backend, ok: false, warning, text: "", latencyMs }; }
