import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CODE_ROOTS = ["src", "workers", "packages/core/dist", "vendor/zvec-grep/dist", "vendor/codegraph/dist"];
export const CODE_OUTDATED_MESSAGE = "lazy-intel code changed on disk; this server restarts itself when idle";
let codeVersionStale = false;

export function codeIsStale() {
  return codeVersionStale;
}

async function fingerprint(roots) {
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push(`${path.relative(ROOT_DIR, absolute)}\0${info.size}\0${info.mtimeMs}`);
      }
    }
  }
  for (const relative of roots) await visit(path.resolve(ROOT_DIR, relative));
  return files.sort().join("\n");
}

function quietWindow(value) {
  if (value == null || value === "") return 30_000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 30_000;
}

/** Watch loaded-code roots and request an idle restart after a stable, changed build. */
export async function startCodeVersionMonitor({ roots = DEFAULT_CODE_ROOTS, quietMs = quietWindow(process.env.LAZY_INTEL_RESTART_QUIET_MS),
  restartEnabled = process.env.LAZY_INTEL_RESTART_ON_CODE_CHANGE !== "false", getBusy = () => false, shutdown = async () => {}, onStale = () => {}, onFresh = () => {}, onRestart = () => {}, now = Date.now, debounceMs = 40 } = {}) {
  const initial = await fingerprint(roots);
  const startedAt = now();
  const watchers = [];
  let stale = false;
  let stopped = false;
  let lastEventAt = startedAt;
  let changeTimer;
  let restartTimer;
  let checking = false;
  let restartStarted = false;

  const returnToStartVersion = () => {
    if (!stale) return;
    stale = false;
    codeVersionStale = false;
    onFresh();
  };
  const scheduleRestartCheck = () => {
    if (stopped || restartStarted || !restartEnabled || !stale || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = undefined; void checkRestart(); }, Math.max(1, Math.min(quietMs || 1, 100)));
    restartTimer.unref?.();
  };
  const checkRestart = async () => {
    if (stopped || restartStarted || !restartEnabled || checking || !stale) return;
    checking = true;
    try {
      const current = await fingerprint(roots);
      if (current === initial) { returnToStartVersion(); return; }
      if (now() - lastEventAt < quietMs || now() - startedAt < quietMs || await getBusy()) return;
      // A final metadata pass prevents exiting on a transient touch-and-revert.
      if (now() - lastEventAt < quietMs) return;
      if (await fingerprint(roots) === initial) { returnToStartVersion(); return; }
      if (await getBusy()) return;
      restartStarted = true;
      await shutdown();
      onRestart(0);
    } finally {
      checking = false;
      if (stale && !restartStarted && !stopped) scheduleRestartCheck();
    }
  };
  const onFileChange = () => {
    if (stopped) return;
    lastEventAt = now();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      changeTimer = undefined;
      try {
        if (await fingerprint(roots) === initial) returnToStartVersion();
        else if (!stale) {
          stale = true;
          codeVersionStale = true;
          onStale();
        }
      } catch { /* A transient build rename is retried on the next filesystem event. */ }
      scheduleRestartCheck();
    }, debounceMs);
    changeTimer.unref?.();
  };

  for (const relative of roots) {
    const absolute = path.resolve(ROOT_DIR, relative);
    try {
      const watcher = watch(absolute, { recursive: true }, onFileChange);
      watcher.unref?.();
      watchers.push(watcher);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return {
    get stale() { return stale; },
    stop() {
      stopped = true;
      clearTimeout(changeTimer);
      clearTimeout(restartTimer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
