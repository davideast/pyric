import { incrementSentinel, serverTimestampSentinel, type IncrementSentinel, type ServerTimestampSentinel } from './sandbox/sentinels.js';

// ─── Sentinels ───────────────────────────────────────────────────────

/**
 * `serverTimestamp()` — returns the `{ ".sv": "timestamp" }` sentinel
 * the wire encoder recognises. Resolves to `Date.now()` (epoch ms) on
 * write — locked by the prod SDK's resolved-as-number contract
 * (oracle: `rtdb-servertimestamp-resolves.json`).
 *
 * The sandbox backend recognises the marker.
 */
export function serverTimestamp(): ServerTimestampSentinel {
  return serverTimestampSentinel();
}

/**
 * `increment(delta)` — returns the `{ ".sv": { increment: delta } }`
 * sentinel that atomically adds `delta` to the current value at the
 * write's field. Starts from `0` when the field is absent or
 * non-numeric (oracle: `rtdb-modular-increment-from-missing.json`).
 *
 * The sandbox backend resolves it against the field's prior value at write
 * time. Mirrors `firebase/database`'s `increment` (`api/ServerValue.ts:38-44`).
 */
export function increment(delta: number): IncrementSentinel {
  return incrementSentinel(delta);
}

/** A client-owned queue of writes applied when its Database disconnects. */

