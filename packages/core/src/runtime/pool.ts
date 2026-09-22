import type { WorkspaceId } from "../contracts.js";
import { WorkerSupervisor, type SupervisorOptions } from "./supervisor.js";
import type { WorkerKind } from "./protocol.js";

export interface WorkerPoolOptions {
  readonly kind: WorkerKind;
  readonly modulePath: string;
  readonly size: number;
  readonly workspaceId?: WorkspaceId;
  readonly env?: Readonly<Record<string, string>>;
  readonly execArgv?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly abandonedJobLimit?: number;
  readonly onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

interface Slot {
  supervisor: WorkerSupervisor;
}

/** A bounded set of lazy workers with affinity-aware, load-shedding routing. */
export class WorkerPool {
  readonly #options: WorkerPoolOptions;
  readonly #slots: Slot[];
  #closed = false;

  constructor(options: WorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new RangeError("worker pool size must be at least one");
    this.#options = options;
    this.#slots = Array.from({ length: options.size }, () => ({ supervisor: this.#newSupervisor() }));
  }

  get size(): number {
    return this.#slots.length;
  }

  /** Pick a worker, preferring affinity unless it would block an idle worker. */
  acquire(affinityKey: string): WorkerSupervisor {
    if (this.#closed) throw new Error(`${this.#options.kind} worker pool is closed`);
    const sticky = this.#slotFor(affinityKey);
    const stickyLoad = sticky.supervisor.inFlight;
    const idle = this.#slots.find((slot) => slot.supervisor.inFlight === 0);
    if (stickyLoad > 0 && idle && idle !== sticky) return idle.supervisor;

    let selected = sticky;
    let selectedLoad = stickyLoad;
    for (const slot of this.#slots) {
      const load = slot.supervisor.inFlight;
      if (load < selectedLoad) {
        selected = slot;
        selectedLoad = load;
      }
    }
    return selected.supervisor;
  }

  /**
   * Replace exactly one slot; other workers and their epochs are untouched.
   *
   * A wedged worker is a property of the pool, not of whichever caller noticed,
   * so this always reclaims the process. Once the pool is closed there is nobody
   * left to serve, and installing a replacement would only leak an object.
   */
  async recycle(supervisor: WorkerSupervisor): Promise<void> {
    const slot = this.#slots.find((candidate) => candidate.supervisor === supervisor);
    if (!slot) throw new Error("supervisor does not belong to this worker pool");
    if (!this.#closed) slot.supervisor = this.#newSupervisor();
    await supervisor.close();
  }

  get upstreamCommit(): string | null {
    return this.#slots.find(({ supervisor }) => supervisor.running && supervisor.upstreamCommit !== null)?.supervisor.upstreamCommit ?? null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(this.#slots.map(({ supervisor }) => supervisor.close()));
  }

  #newSupervisor(): WorkerSupervisor {
    const options: SupervisorOptions = {
      kind: this.#options.kind,
      modulePath: this.#options.modulePath,
      workspaceId: this.#options.workspaceId ?? "shared",
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.execArgv === undefined ? {} : { execArgv: this.#options.execArgv }),
      ...(this.#options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.#options.startupTimeoutMs }),
      ...(this.#options.maxRestarts === undefined ? {} : { maxRestarts: this.#options.maxRestarts }),
      ...(this.#options.restartWindowMs === undefined ? {} : { restartWindowMs: this.#options.restartWindowMs }),
      ...(this.#options.abandonedJobLimit === undefined ? {} : { abandonedJobLimit: this.#options.abandonedJobLimit }),
      ...(this.#options.onLog === undefined ? {} : { onLog: this.#options.onLog }),
    };
    return new WorkerSupervisor(options);
  }

  #slotFor(key: string): Slot {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return this.#slots[(hash >>> 0) % this.#slots.length]!;
  }
}
