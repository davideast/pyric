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

const SERVER_TIMESTAMP_MARKER = '{".sv":"timestamp"}';

export interface ServerTimestampSentinel {
  '.sv': 'timestamp';
}

/**
 * The `increment(delta)` sentinel — `{ ".sv": { "increment": delta } }`.
 * Resolves to `current + delta` server-side, starting from `0` when the
 * field is absent or non-numeric. Mirrors upstream
 * `api/ServerValue.ts:38-44` + oracle
 * `rtdb-modular-increment-from-missing.json` (`startsFromZero: true`).
 */
export interface IncrementSentinel {
  '.sv': { increment: number };
}

/** True when `v` is the `{ ".sv": "timestamp" }` server-timestamp marker. */
export function isServerTimestampSentinel(v: unknown): v is ServerTimestampSentinel {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return obj['.sv'] === 'timestamp';
}

/** True when `v` is the `{ ".sv": { increment: n } }` increment marker. */
export function isIncrementSentinel(v: unknown): v is IncrementSentinel {
  if (v === null || typeof v !== 'object') return false;
  const sv = (v as Record<string, unknown>)['.sv'];
  return (
    sv !== null &&
    typeof sv === 'object' &&
    typeof (sv as Record<string, unknown>).increment === 'number'
  );
}

/**
 * Walk the value tree, replacing every server-side sentinel:
 *   - `serverTimestamp()` → `now` (epoch ms).
 *   - `increment(delta)` → `current + delta` at the corresponding path
 *     (`0` when the current value is absent / non-numeric — DB-GAP).
 *
 * Returns a fresh tree — input is left untouched. `current` is the value
 * presently stored at the SAME path as `value`; it's walked in parallel
 * so each nested `increment` resolves against its own field's prior
 * value. Pass `undefined`/`null` when there's nothing stored.
 *
 * Used by the sandbox backend at every write boundary (`set`, `update`,
 * `push`). Multi-path `update({ '/a': sentinel, '/b': { nested: sentinel } })`
 * is handled by the caller calling this per-path with that path's prior
 * value.
 */
export function resolveSentinels(value: unknown, now: number, current?: unknown): unknown {
  if (isServerTimestampSentinel(value)) return now;
  if (isIncrementSentinel(value)) {
    const delta = (value as IncrementSentinel)['.sv'].increment;
    const base = typeof current === 'number' ? current : 0;
    return base + delta;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      resolveSentinels(v, now, Array.isArray(current) ? current[i] : undefined),
    );
  }
  const curObj =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = resolveSentinels(v, now, curObj ? curObj[k] : undefined);
  }
  return out;
}

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
