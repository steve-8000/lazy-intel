import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// The shared zvec-grep configuration is the single source of truth for the vector space.
export async function configuredEmbedding() {
  if (process.env.ZVEC_GREP_EMBEDDING) return process.env.ZVEC_GREP_EMBEDDING;
  const home = process.env.ZVEC_GREP_HOME || path.join(homedir(), ".zvec-grep");
  try {
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    return config?.defaults?.embedding ?? null;
  } catch {
    return null;
  }
}

