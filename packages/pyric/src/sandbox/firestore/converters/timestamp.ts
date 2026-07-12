/**
 * Item 1 — Timestamp + serverTimestamp converters.
 *
 * Two converters plug into the value-resolver registry:
 *
 * 1. `date-to-timestamp` — JS `Date` instances become {@link Timestamp}
 *    wrappers at the write boundary. Without this, a rule like
 *    `resource.data.createdAt is timestamp` returns false against seeded
 *    Date data because the evaluator detects timestamps via `instanceof
 *    Timestamp`, not Date.
 *
 * 2. `server-timestamp-sentinel` — the literal `{ __type:
 *    'serverTimestamp' }` sentinel becomes a {@link Timestamp} reflecting
 *    "now". When `ctx.serverTime` is provided, every sentinel in the
 *    tree resolves to that SAME Timestamp instance; this matters for
 *    rules that compare `data.createdAt == request.time`. Direct
 *    `LocalState.write` calls (no LocalEnvironment) get a fresh
 *    `Timestamp.fromMillis(Date.now())` per sentinel — small drift, but
 *    no rules are evaluated in that path so it doesn't matter.
 *
 * Both converters are idempotent on their own output:
 *   - `date-to-timestamp` checks `instanceof Date` only, so the
 *     {@link Timestamp} it emits is not re-claimed on a second pass.
 *   - `server-timestamp-sentinel` checks the `__type` discriminator;
 *     a Timestamp instance does not have it.
 *
 * Both converters preserve unrelated values via {@link KEEP}.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Timestamp } from 'pyric/rules/internal';

/**
 * Detect plain `{ __type: 'serverTimestamp' }` objects. Mirrors
 * `handler.ts:isServerTimestampSentinel` so the two layers agree on
 * sentinel shape — refactor either, refactor both.
 */
function isServerTimestampSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).__type === 'serverTimestamp'
  );
}

export const dateConverter: ValueConverter = {
  name: 'date-to-timestamp',
  convert(value) {
    if (value instanceof Date) {
      return Timestamp.fromMillis(value.getTime());
    }
    return KEEP;
  },
};

export const serverTimestampConverter: ValueConverter = {
  name: 'server-timestamp-sentinel',
  convert(value, ctx) {
    if (!isServerTimestampSentinel(value)) return KEEP;
    // Use the caller-supplied serverTime when present so every sentinel
    // in this write resolves to the same instance. Otherwise fall back
    // to a fresh wallclock read.
    if (ctx.serverTime instanceof Timestamp) return ctx.serverTime;
    return Timestamp.fromMillis(Date.now());
  },
};
