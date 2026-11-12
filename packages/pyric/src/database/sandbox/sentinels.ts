/**
 * RTDB-side write sentinels.
 *
 * Production `firebase/database` ships exactly one server-side sentinel
 * for ordinary writes: `serverTimestamp()` returns the shape
 * `{ ".sv": "timestamp" }`. The wire serializer recognises that marker
 * and the server stamps `Date.now()` (epoch ms) into the field. On
 * read-back the client never sees the marker — only the resolved
 * number. Oracle observation
 * `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json`
 * confirms the shape.
 *
 * Sandbox match: we recognise the same `{ ".sv": "timestamp" }` marker
 * and resolve it at write time. The marker shape is the cross-target
 * contract — agent code that writes a value built by
 * `import { serverTimestamp } from 'pyric/database'` produces the same
 * literal on either backend.
 */
import type { IncrementSentinel, ServerTimestampSentinel } from '@pyric/rules/internal/rtdb';

export { isServerTimestampSentinel, isIncrementSentinel, resolveSentinels } from '@pyric/rules/internal/rtdb';
export type { ServerTimestampSentinel, IncrementSentinel } from '@pyric/rules/internal/rtdb';

const SERVER_TIMESTAMP_MARKER = '{".sv":"timestamp"}';

/**
 * Factory used by the modular SDK's `serverTimestamp()` export. Returns
 * the same `{ ".sv": "timestamp" }` shape `firebase/database` emits so
 * the upstream SDK's wire encoder accepts the same shape unchanged.
 */
export function serverTimestampSentinel(): ServerTimestampSentinel {
  return { '.sv': 'timestamp' };
}

/**
 * Factory used by the modular SDK's `increment(delta)` export. Returns
 * the same `{ ".sv": { increment: delta } }` shape `firebase/database`
 * emits so the upstream SDK's wire encoder accepts the same shape unchanged.
 */
export function incrementSentinel(delta: number): IncrementSentinel {
  return { '.sv': { increment: delta } };
}

/** Debug-only — for assertions/tests. */
export const SENTINEL_DEBUG = { SERVER_TIMESTAMP_MARKER };
