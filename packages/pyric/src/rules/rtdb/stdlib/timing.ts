/**
 * `timing`: server timestamps, cooldowns and rate limits.
 *
 * `now` is the server's clock in milliseconds when it evaluates the rule. A
 * client writes the server timestamp with `serverTimestamp()` from
 * `firebase/database`, which the server replaces with `now` before it
 * evaluates the rules, so `newData.val() == now` holds only for that value.
 *
 * Placement: with no `field`, a builder reads the node it is placed on (a
 * field node's `.validate`); with a `field`, it reads that child of the
 * record it is placed on.
 *
 * Rate limiting: store the time of the last write at a node the writer owns,
 * such as `/lastPost/$uid`, give it `.validate: timing.throttled(ms)`, and
 * have the rate-limited write update both in one multi-path update. The
 * limited node's `.validate` then requires the stamp in the same write with
 * `timing.stampedInSameWrite(...)`, so a write without a fresh stamp, and a
 * fresh stamp before the cooldown ends, are both refused. A deleted stamp
 * would reset the cooldown, and `.validate` does not run on a delete, so the
 * stamp's `.write` refuses deletes with `lifecycle.noDelete()`.
 *
 * The limit is on writes, not posts: one multi-path update can carry several
 * posts and one stamp, and each post's `.validate` sees the same fresh stamp.
 */
import type { Expr, Segment } from '../constraints/types.js';
import { and, exists, fieldName, finite, lit, negate, or, raw, val } from './expr.js';

const at = (snapshot: 'data' | 'newData', field?: string) =>
  field === undefined ? val(snapshot) : val(snapshot, fieldName('timing', field));
const present = (field?: string) =>
  field === undefined ? exists('data') : exists('data', fieldName('timing', field));

/** The written value is the server timestamp. */
export const isServerTimestamp = (field?: string): Expr => raw(`${at('newData', field)} == now`);

/** The written value is a number no later than the server's clock. */
export function notInFuture(field?: string): Expr {
  const value = at('newData', field);
  const node = field === undefined ? 'newData' : `newData.child(${lit(field)})`;
  return and(raw(`${node}.isNumber()`), raw(`${value} <= now`));
}

/**
 * Nothing is stored yet, or the stored timestamp is more than `ms`
 * milliseconds before the server's clock.
 */
export function cooldownElapsed(ms: number, field?: string): Expr {
  finite('cooldownElapsed', 'ms', ms);
  return or(negate(present(field)), raw(`now > ${at('data', field)} + ${lit(ms)}`));
}

/**
 * The node holds the time of its writer's last rate-limited write: each
 * write sets it to the server timestamp, and only once `ms` milliseconds
 * have passed since the stored one. Field node `.validate`.
 */
export const throttled = (ms: number): Expr => and(isServerTimestamp(), cooldownElapsed(ms));

/**
 * The same write sets the stamp at `segments` to the server timestamp. The
 * segments are read from the node `levelsUp` levels above the one the rule
 * is placed on, in the database after the write. A string segment is a key;
 * `{ $: 'auth.uid' }` or `{ $: '$postId' }` is a value the rule reads. For
 * posts at `/posts/$postId` and stamps at `/lastPost/$uid`, the post's
 * `.validate` is `stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }])`.
 */
export function stampedInSameWrite(levelsUp: number, segments: Segment[]): Expr {
  if (!Number.isInteger(levelsUp) || levelsUp < 0) {
    throw new Error(`stampedInSameWrite: levelsUp must be an integer of at least 0, got ${String(levelsUp)}.`);
  }
  if (segments.length === 0) throw new Error('stampedInSameWrite: pass at least one segment.');
  const path = segments
    .map((s) => (typeof s === 'string' ? `.child(${lit(fieldName('stampedInSameWrite', s))})` : `.child(${s.$})`))
    .join('');
  return raw(`newData${'.parent()'.repeat(levelsUp)}${path}.val() == now`);
}
