/**
 * Automatic restart policy for a ready Functions child that exits unexpectedly
 * (#1942). Restarts immediately on an isolated handler exit while bounding
 * rapid back-to-back startup crash loops so a broken module cannot fork-bomb
 * the host or leak pending timers after `close()`.
 */

/** A child that stays up this long resets the consecutive rapid-crash counter. */
const STABLE_UPTIME_MS = 2_000;

/** Maximum consecutive rapid post-ready exits that auto-restart before pausing. */
const MAX_RAPID_CRASH_RESTARTS = 5;

/** Backoff delays (ms) after the first immediate restart on consecutive rapid exits. */
const RAPID_CRASH_BACKOFF_MS = [0, 100, 250, 500, 1_000] as const;

export interface CrashRestartControllerOptions {
  isClosed(): boolean;
  reload(): Promise<void>;
  now?(): number;
}

export interface CrashRestartController {
  /** Record when the current ready child became ready. */
  markReady(): void;
  /** Reset crash backoff state on an explicit reload or clean shutdown. */
  reset(): void;
  /** Cancel any scheduled crash-restart timer without resetting history. */
  cancelPending(): void;
  /** Schedule a reload after an unexpected post-ready child exit; returns false when paused. */
  scheduleAfterUnexpectedExit(): boolean;
}

export function createCrashRestartController(
  options: CrashRestartControllerOptions,
): CrashRestartController {
  const now = options.now ?? Date.now;
  let lastReadyAt: number | null = null;
  let rapidCrashes = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPending = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  return {
    markReady(): void {
      lastReadyAt = now();
    },
    reset(): void {
      cancelPending();
      rapidCrashes = 0;
      lastReadyAt = null;
    },
    cancelPending,
    scheduleAfterUnexpectedExit(): boolean {
      if (options.isClosed()) {
        return false;
      }
      const readyAt = lastReadyAt;
      const survivedLongEnough = readyAt !== null && now() - readyAt >= STABLE_UPTIME_MS;
      if (survivedLongEnough) {
        rapidCrashes = 0;
      }
      rapidCrashes += 1;
      if (rapidCrashes > MAX_RAPID_CRASH_RESTARTS) {
        return false;
      }
      cancelPending();
      const delayIndex = Math.min(rapidCrashes - 1, RAPID_CRASH_BACKOFF_MS.length - 1);
      const delayMs = RAPID_CRASH_BACKOFF_MS[delayIndex] ?? 0;
      if (delayMs === 0) {
        void options.reload();
        return true;
      }
      const timer = setTimeout(() => {
        pendingTimer = null;
        if (!options.isClosed()) {
          void options.reload();
        }
      }, delayMs);
      timer.unref();
      pendingTimer = timer;
      return true;
    },
  };
}
