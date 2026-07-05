/**
 * User-Timestamp write-boundary converter (FS-B4).
 *
 * Unifies Timestamp storage. The simulator stores resolved timestamps as
 * rules-internal {@link Timestamp} (`pyric/rules`, `{seconds, nanos}`,
 * carrying evaluator hooks). The `serverTimestamp()` sentinel and `Date`
 * inputs already resolve to that internal class (see `timestamp.ts`). But
 * a timestamp the user *writes directly* — via the modular SDK's
 * `Timestamp` (the admin-compat `{seconds, nanoseconds}` class re-exported
 * as `Timestamp` from `pyric/firestore`) or a raw `firebase/firestore`
 * `Timestamp` — has no converter, so it lands in storage as the compat
 * class instance. Two problems with that split storage:
 *
 *   1. The rules evaluator detects timestamps via `value instanceof
 *      RulesValue && typeName === 'timestamp'`. A compat `Timestamp` is
 *      neither, so `data.createdAt is timestamp` returns false — a user
 *      `Timestamp` is rejected by the very `is timestamp` rule that a
 *      `serverTimestamp()` write passes.
 *   2. Range filters / cursors / `orderBy` compare against stored values.
 *      The FS-B3 comparator was taught both timestamp shapes, so ordering
 *      mostly works — but the read-path translator only rewrites the
 *      internal class to compat shape, so a user-written compat Timestamp
 *      never gets the `nanos`→`nanoseconds` normalization round-trip and
 *      `serverTimestamp()`-written and user-written timestamps live as two
 *      different classes in the same collection. Normalizing both to the
 *      internal class at the write boundary collapses the split.
 *
 * Detection strategy — duck typing on the compat / `firebase/firestore`
 * Timestamp shape, exactly like {@link bytesConverter} /
 * {@link geoPointConverter}:
 *   - numeric `seconds`
 *   - numeric `nanoseconds`  (the compat / fb field name — distinct from
 *     the internal class's `nanos`, which is how we reject our own output)
 *   - method `toMillis`
 *
 * We deliberately don't `instanceof fb.Timestamp` — the simulator package
 * must not take a hard dependency on `firebase/firestore`, and multiple
 * `firebase` copies in a workspace would defeat `instanceof` anyway.
 *
 * Idempotency: the internal {@link Timestamp} has `nanos`, not
 * `nanoseconds`, and `value instanceof RulesTimestamp` short-circuits
 * first — so a second resolver pass over our own output is a no-op.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Timestamp as RulesTimestamp } from 'pyric/rules';

/** Minimal duck-type for a compat / `firebase/firestore` `Timestamp`. */
interface UserTimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}

function isUserTimestamp(v: unknown): v is UserTimestampLike {
  if (v === null || typeof v !== 'object') return false;
  // Our own output (the internal wrapper) is already normalized.
  if (v instanceof RulesTimestamp) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seconds === 'number' &&
    typeof o.nanoseconds === 'number' &&
    typeof o.toMillis === 'function'
  );
}

export const userTimestampConverter: ValueConverter = {
  name: 'user-timestamp-to-rules-timestamp',
  convert(value) {
    if (!isUserTimestamp(value)) return KEEP;
    return new RulesTimestamp(value.seconds, value.nanoseconds);
  },
};
