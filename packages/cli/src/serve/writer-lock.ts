/**
 * Single-writer lock and optimistic state version counter for `--persist`
 * (pre-mortem #3, #2051).
 *
 * Two in-page tabs hold separate sandboxes, each flushing its whole world view,
 * so an outdated tab's flush would erase buckets another tab already saved.
 *
 * The server pairs a liveness lease (`x-pyric-writer`) with an optimistic
 * concurrency version (`x-pyric-state-version`):
 * - Every accepted `POST /__pyric/state` write advances `version()`.
 * - A claim or write that carries `x-pyric-state-version` is granted only when
 *   that version matches `version()`, refusing both a long-hidden writer whose
 *   lease expired while another tab saved and a tab that makes its first
 *   service call after another tab already saved and closed.
 */

export const STATE_VERSION_HEADER = 'x-pyric-state-version';

/**
 * Parse an optional `x-pyric-state-version` header value.
 * Returns `undefined` when absent, the non-negative safe integer when valid,
 * or `'invalid'` when malformed.
 */
export function parseStateVersionHeader(
  raw: string | null | undefined,
): number | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return 'invalid';
  return parsed;
}

export interface WriterLock {
  /**
   * Claim/refresh for `id`. Granted when `expectedVersion` (if supplied)
   * matches `version()` and the lock is free, already held by `id`, or stale.
   */
  claim(id: string, now: number, expectedVersion?: number): boolean;
  /** Record a committed state write and return the new saved version. */
  advanceVersion(): number;
  /** Current saved state version (0 before any write in this session). */
  version(): number;
  /** Release if `id` is the holder (no-op otherwise). */
  release(id: string): void;
  /** Current holder, or null. */
  holder(): string | null;
}

export function createWriterLock(staleMs = 60_000): WriterLock {
  let holder: string | null = null;
  let lastSeen = 0;
  let currentVersion = 0;
  return {
    claim(id, now, expectedVersion) {
      const hasOutdatedVersion =
        expectedVersion !== undefined && expectedVersion !== currentVersion;
      if (hasOutdatedVersion) {
        return false;
      }
      const isFree = holder === null;
      const isCurrentHolder = holder === id;
      const isStale = now - lastSeen > staleMs;
      if (isFree || isCurrentHolder || isStale) {
        holder = id;
        lastSeen = now;
        return true;
      }
      return false;
    },
    advanceVersion() {
      currentVersion += 1;
      return currentVersion;
    },
    version: () => currentVersion,
    release(id) {
      if (holder === id) {
        holder = null;
        lastSeen = 0;
      }
    },
    holder: () => holder,
  };
}
