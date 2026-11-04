/**
 * A view's copy of its host's live status. The host keeps the status (the
 * `live` field of `/__pyric/health`), so a view reads it again while it runs:
 * on a schedule, sooner after traffic, and after a failed read until one
 * succeeds, so a live host never shows a view without its line. A host that
 * answers with no live status is a sandbox host, and the view stops reading.
 * The chip and Studio both read through this.
 */
import type { LiveHostStatus } from './live-status.js';

/** How often a live host's status is read again: its count moves with every call. */
export const LIVE_REFRESH_MS = 2_000;
/** How soon after traffic the status is read again. */
export const LIVE_TRAFFIC_REFRESH_MS = 150;
/** Retry delays after a failed read; the last repeats until a read succeeds. */
export const LIVE_RETRY_MS = [250, 500, 1_000, 2_000, 5_000] as const;

/**
 * Reads the host's live status. Resolves null when the host answered with
 * none (a sandbox host), and rejects when the host could not be read.
 */
export type ReadLiveStatus = () => Promise<LiveHostStatus | null>;

export interface LiveStatusTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface LiveStatusPoller {
  /** Starts reading; later calls do nothing. */
  start(): void;
  /** Reads again soon, on a live host: traffic may have moved the count. */
  refreshSoon(): void;
  current(): LiveHostStatus | null;
  dispose(): void;
}

const DEFAULT_TIMERS: LiveStatusTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};

/** `onChange` runs whenever a read returns a status that differs from the last one. */
export function createLiveStatusPoller(read: ReadLiveStatus, onChange: () => void, timers: LiveStatusTimers = DEFAULT_TIMERS): LiveStatusPoller {
  let status: LiveHostStatus | null = null;
  let shown = 'null';
  let started = false;
  let disposed = false;
  let isSandboxHost = false;
  let reading = false;
  let failures = 0;
  let timer: unknown;
  let dueAt = 0;

  /** Reads after `ms`, unless a read is already due sooner: steady traffic never holds a read back. */
  const schedule = (ms: number): void => {
    if (disposed || isSandboxHost) return;
    const at = timers.now() + ms;
    const isDueSooner = timer !== undefined && dueAt <= at;
    if (isDueSooner) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    dueAt = at;
    timer = timers.setTimeout(() => {
      timer = undefined;
      void readOnce();
    }, ms);
  };

  const settle = (next: LiveHostStatus | null): void => {
    failures = 0;
    isSandboxHost = next === null;
    const nextShown = JSON.stringify(next);
    const changed = nextShown !== shown;
    status = next;
    shown = nextShown;
    if (changed) onChange();
    schedule(LIVE_REFRESH_MS);
  };

  const fail = (): void => {
    const delay = LIVE_RETRY_MS[Math.min(failures, LIVE_RETRY_MS.length - 1)] ?? LIVE_RETRY_MS[0];
    failures += 1;
    schedule(delay);
  };

  const readOnce = async (): Promise<void> => {
    if (disposed || reading) return;
    reading = true;
    try {
      const next = await read();
      if (!disposed) settle(next);
    } catch {
      if (!disposed) fail();
    } finally {
      reading = false;
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      void readOnce();
    },
    refreshSoon() {
      const isLive = status !== null;
      if (isLive) schedule(LIVE_TRAFFIC_REFRESH_MS);
    },
    current: () => status,
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}
