/**
 * Single-writer lock for `--persist` (pre-mortem #3).
 *
 * Two tabs = two sandboxes, each flushing its WHOLE world view — so the
 * second tab's flush doesn't merge, it ERASES everything the first wrote.
 * "last-writer-wins" undersold it: last-tab's-universe wins, visibly, on the
 * loser's next reload.
 *
 * The conflict only exists at WRITE time, so the lock is resolved there: the
 * first page to flush claims the writer role (carried in the
 * `x-pyric-writer` header); a different page's flush is refused (409) and
 * that page drops to read-only persistence + a loud console line. A reader
 * that never mutates never conflicts.
 *
 * Liveness: the holder refreshes `lastSeen` on every accepted write and via
 * a periodic heartbeat. A holder that goes quiet for `staleMs` (crash, or an
 * idle tab whose heartbeat also stopped) is considered gone, so a fresh page
 * can claim the role — no permanent wedge. The small overlap window where a
 * stale-but-alive holder and a new claimer both think they're the writer is
 * an accepted dev-tool race (documented), kept rare by a generous staleMs.
 */

export interface WriterLock {
  /** Claim/refresh for `id`. Granted when free, already held by `id`, or the
   *  current holder is stale. Returns whether `id` now holds the lock. */
  claim(id: string, now: number): boolean;
  /** Release if `id` is the holder (no-op otherwise). */
  release(id: string): void;
  /** Current holder, or null. */
  holder(): string | null;
}

export function createWriterLock(staleMs = 60_000): WriterLock {
  let holder: string | null = null;
  let lastSeen = 0;
  return {
    claim(id, now) {
      if (holder === null || holder === id || now - lastSeen > staleMs) {
        holder = id;
        lastSeen = now;
        return true;
      }
      return false;
    },
    release(id) {
      if (holder === id) {
        holder = null;
        lastSeen = 0;
      }
    },
    holder: () => holder,
  };
}
