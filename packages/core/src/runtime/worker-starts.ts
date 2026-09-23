let pauseReason: string | null = null;

/** Stop future worker process starts while the owning server is being replaced. */
export function pauseWorkerStarts(reason: string): void {
  pauseReason = reason;
}

export function workerStartsPaused(): boolean {
  return pauseReason !== null;
}

export function workerStartPauseReason(): string | null {
  return pauseReason;
}

export function resumeWorkerStarts(): void {
  pauseReason = null;
}
