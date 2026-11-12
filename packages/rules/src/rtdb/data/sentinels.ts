/**
 * RTDB server-value sentinels, `{ ".sv": "timestamp" }` and
 * `{ ".sv": { "increment": n } }`, and their resolution at a write. The
 * rules simulator and the sandbox's write boundary resolve them the same
 * way; the SDK-facing factories stay in `database/sandbox/sentinels.ts`.
 */

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
function unwrapNodeValue(node: unknown): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, '.value')) {
    return (node as Record<string, unknown>)['.value'];
  }
  return node;
}

function nodePriority(node: unknown): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, '.priority')) {
    return (node as Record<string, unknown>)['.priority'];
  }
  return undefined;
}

export function resolveSentinels(value: unknown, now: number, current?: unknown): unknown {
  const rawCurrent = unwrapNodeValue(current);
  if (isServerTimestampSentinel(value)) return now;
  if (isIncrementSentinel(value)) {
    const delta = (value as IncrementSentinel)['.sv'].increment;
    const base = typeof rawCurrent === 'number' ? rawCurrent : 0;
    return base + delta;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      resolveSentinels(v, now, Array.isArray(rawCurrent) ? rawCurrent[i] : undefined),
    );
  }
  let curObj: Record<string, unknown> | undefined;
  if (rawCurrent !== null && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)) {
    curObj = rawCurrent as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    let childCurrent: unknown;
    if (k === '.value') {
      childCurrent = rawCurrent;
    } else if (k === '.priority') {
      childCurrent = nodePriority(current);
    } else if (curObj !== undefined && Object.hasOwn(curObj, k)) {
      childCurrent = curObj[k];
    }
    Object.defineProperty(out, k, {
      value: resolveSentinels(v, now, childCurrent),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

