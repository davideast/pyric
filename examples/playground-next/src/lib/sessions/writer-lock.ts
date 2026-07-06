/**
 * Per-session single-writer election.
 *
 * Two tabs open on the SAME session used to silently revert each
 * other: each ran the 800 ms ambient autosave, and the sessions-store
 * persistence flushes a whole-snapshot blob — last writer wins. The
 * fix is an exclusive Web Lock per session:
 *
 *   lock name: `pyric:session-writer:{sessionId}`
 *
 * The holder is the WRITER — everything works as today. A non-holder
 * tab is READ-ONLY: the page shows a banner, agent turns are blocked,
 * the VFS write gate flips on, and the ambient autosave (plus every
 * sessions-store flush, via the writer-gated persistence backend in
 * `sandbox.ts`) stops.
 *
 * "Take over" is a graceful steal: the requester posts a
 * `steal-request` on a per-session BroadcastChannel; the holder runs
 * its `onYield` callback (final autosave flush) while still the
 * writer, flips itself read-only, releases the lock, and posts
 * `released`; the requester then acquires. If the holder tab is gone,
 * the browser has already auto-released the lock and plain
 * re-acquisition succeeds.
 *
 * Feature detection: with no Web Locks API (older browsers, jsdom,
 * bun) every tab behaves exactly as before this change — it is the
 * writer, nothing blocks. The election only ever REMOVES write races,
 * never adds a hard dependency.
 *
 * Module-global vs per-instance state: the playground page acquires
 * exactly one lock per page load and mirrors its status into the
 * module-global `sessionWriterStatus` (read by `useAgentLoop` and the
 * writer-gated persistence backend). Tests construct multiple lock
 * instances with injected mocks without touching the global.
 */

export type SessionWriterStatus = 'writer' | 'readonly';

// ─── Module-global status (what THIS tab currently is) ────────────────

let globalStatus: SessionWriterStatus = 'writer';
const globalSubs = new Set<(s: SessionWriterStatus) => void>();

/** Is this tab currently allowed to write (agent turns, autosave,
 *  sessions-store flushes)? Defaults to true — pages without an
 *  election (home page, headless) are always writers. */
export function isSessionWriter(): boolean {
  return globalStatus === 'writer';
}

/** Mirror a lock instance's status into the module-global gate.
 *  Called by the session routing layer, the one owner of the lock. */
export function markSessionWriterStatus(status: SessionWriterStatus): void {
  if (globalStatus === status) return;
  globalStatus = status;
  for (const cb of globalSubs) cb(status);
}

export function subscribeSessionWriter(
  cb: (status: SessionWriterStatus) => void,
): () => void {
  globalSubs.add(cb);
  return () => globalSubs.delete(cb);
}

/** Test hook — restore the default writer status between cases. */
export function resetSessionWriterStatusForTests(): void {
  globalStatus = 'writer';
  globalSubs.clear();
}

// ─── Lock instance ─────────────────────────────────────────────────────

/** Minimal structural slice of `navigator.locks` we depend on. */
export interface LocksApiLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown | null) => unknown | Promise<unknown>,
  ): Promise<unknown>;
}

/** Minimal structural slice of `BroadcastChannel`. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}

export interface WriterLockOptions {
  /** Called while this tab STILL holds writer status, right before
   *  yielding the lock to a take-over request. Flush pending saves
   *  here — once it resolves the tab flips read-only. */
  onYield?: () => void | Promise<void>;
  /** Test seams — default to the real browser APIs. */
  locksApi?: LocksApiLike | null;
  createChannel?: (name: string) => ChannelLike | null;
  /** Take-over tuning (ms). Exposed for fast tests. */
  yieldTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface SessionWriterLock {
  status(): SessionWriterStatus;
  subscribe(cb: (status: SessionWriterStatus) => void): () => void;
  /** True when the environment has no Web Locks API — the lock is a
   *  no-op and this tab is unconditionally the writer. */
  readonly unsupported: boolean;
  /** Request the writer role from whoever holds it. Resolves true
   *  when this tab became the writer. */
  takeOver(): Promise<boolean>;
  /** Release the lock + channel (page teardown). */
  release(): void;
}

const TAKEOVER_RETRIES = 5;

function defaultLocksApi(): LocksApiLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as { locks?: LocksApiLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function defaultCreateChannel(name: string): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(name) as unknown as ChannelLike;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function sessionWriterLockName(sessionId: string): string {
  return `pyric:session-writer:${sessionId}`;
}

/**
 * Run the election for `sessionId`. Resolves once this tab knows
 * whether it is the writer (non-blocking — `ifAvailable` acquisition,
 * never waits on another tab).
 */
export async function acquireSessionWriterLock(
  sessionId: string,
  options: WriterLockOptions = {},
): Promise<SessionWriterLock> {
  const locks = options.locksApi !== undefined ? options.locksApi : defaultLocksApi();
  const makeChannel = options.createChannel ?? defaultCreateChannel;
  const yieldTimeoutMs = options.yieldTimeoutMs ?? 1500;
  const retryDelayMs = options.retryDelayMs ?? 150;

  let status: SessionWriterStatus = 'writer';
  const subs = new Set<(s: SessionWriterStatus) => void>();
  const setStatus = (next: SessionWriterStatus): void => {
    if (status === next) return;
    status = next;
    for (const cb of subs) cb(next);
  };

  const base = {
    status: () => status,
    subscribe(cb: (s: SessionWriterStatus) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };

  // No Web Locks API → current single-writer behavior, never block.
  if (!locks) {
    return {
      ...base,
      unsupported: true,
      takeOver: async () => true,
      release: () => {},
    };
  }

  const lockName = sessionWriterLockName(sessionId);
  /** Resolving this releases the held lock (the lock callback keeps
   *  the lock for the lifetime of the promise it returns). */
  let releaseHeld: (() => void) | null = null;

  const tryAcquire = (): Promise<boolean> =>
    new Promise<boolean>((resolveAcquired) => {
      void locks
        .request(lockName, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolveAcquired(false);
            return;
          }
          resolveAcquired(true);
          return new Promise<void>((resolveHeld) => {
            releaseHeld = resolveHeld;
          });
        })
        .catch(() => resolveAcquired(false));
    });

  const channel = makeChannel(lockName);
  let releasedListeners: Array<() => void> = [];

  channel?.addEventListener('message', (ev) => {
    const data = ev.data as { type?: string } | null;
    if (data?.type === 'steal-request') {
      // Another tab wants the pen. Yield gracefully — final flush
      // happens while we are STILL the writer (the writer-gated
      // persistence backend checks status at write time), then we go
      // read-only and hand the lock back.
      if (status !== 'writer' || !releaseHeld) return;
      void (async () => {
        try {
          await options.onYield?.();
        } catch (e) {
          console.warn('[session-writer] onYield flush failed:', e);
        }
        setStatus('readonly');
        releaseHeld?.();
        releaseHeld = null;
        channel.postMessage({ type: 'released' });
      })();
      return;
    }
    if (data?.type === 'released') {
      const waiters = releasedListeners;
      releasedListeners = [];
      for (const w of waiters) w();
    }
  });

  const waitForRelease = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, yieldTimeoutMs);
      releasedListeners.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  // Election: non-blocking attempt. Holder = writer.
  const acquired = await tryAcquire();
  setStatus(acquired ? 'writer' : 'readonly');

  return {
    ...base,
    unsupported: false,
    async takeOver(): Promise<boolean> {
      if (status === 'writer') return true;
      if (channel) {
        channel.postMessage({ type: 'steal-request' });
        await waitForRelease();
      }
      // The holder either released gracefully (message), crashed (the
      // browser auto-released), or is unresponsive. Retry acquisition
      // briefly; never force-steal — a forced steal leaves the old
      // holder believing it is still the writer.
      for (let i = 0; i < TAKEOVER_RETRIES; i++) {
        if (await tryAcquire()) {
          setStatus('writer');
          return true;
        }
        await delay(retryDelayMs);
      }
      return false;
    },
    release(): void {
      releaseHeld?.();
      releaseHeld = null;
      channel?.close();
    },
  };
}
