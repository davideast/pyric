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
import { and, childPath, climb, exists, fieldName, finite, lit, negate, or, raw, val } from './expr.js';

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
  const base = climb('stampedInSameWrite', 'newData', requireLevels('stampedInSameWrite', levelsUp));
  return raw(`${base}${childPath('stampedInSameWrite', segments)}.val() == now`);
}

function requireLevels(builder: string, levelsUp: number): number {
  if (typeof levelsUp !== 'number') throw new Error(`${builder}: pass levelsUp.`);
  return levelsUp;
}

/**
 * A quota node, such as `/quota/$uid`, that allows `max` counted writes per
 * window of `windowMs` milliseconds. It holds `{ windowStart, count }`. A
 * write either opens a new window, setting `windowStart` to the server
 * timestamp and `count` to 1, once nothing is stored or the stored window has
 * ended, or counts one more write in the open window, keeping `windowStart`
 * and adding 1 to `count`, up to `max`. Quota node `.validate`; give the
 * node's `.write` `lifecycle.noDelete()`, since a deleted quota would reset.
 *
 * The stored window is checked to be a number before the rule adds to it:
 * production fails a rule that adds to a missing value.
 */
export function windowedQuota(max: number, windowMs: number): Expr {
  finite('windowedQuota', 'max', max);
  finite('windowedQuota', 'windowMs', windowMs);
  if (!Number.isInteger(max) || max < 1) throw new Error(`windowedQuota: max must be an integer of at least 1, got ${max}.`);
  if (windowMs <= 0) throw new Error(`windowedQuota: windowMs must be positive, got ${windowMs}.`);
  const storedStart = "data.child('windowStart')";
  const ends = `${storedStart}.val() + ${lit(windowMs)}`;
  return and(
    raw("newData.child('count').isNumber()"),
    raw(`newData.child('count').val() <= ${lit(max)}`),
    or(
      and(
        raw("newData.child('windowStart').val() == now"),
        raw("newData.child('count').val() == 1"),
        or(negate(exists('data')), and(raw(`${storedStart}.isNumber()`), raw(`now >= ${ends}`))),
      ),
      and(
        raw(`${storedStart}.isNumber()`),
        raw("data.child('count').isNumber()"),
        raw(`newData.child('windowStart').val() == ${storedStart}.val()`),
        raw(`now < ${ends}`),
        raw("newData.child('count').val() == data.child('count').val() + 1"),
      ),
    ),
  );
}

/**
 * The same write moves the quota at `segments`, read `levelsUp` levels above
 * the node the rule is placed on: its `count` or `windowStart` differs after
 * the write. With `windowedQuota` on the quota node, any change is one
 * counted write. Like `stampedInSameWrite`, it limits writes, not items: one
 * multi-path update can carry several items and one count.
 */
export function countedInSameWrite(levelsUp: number, segments: Segment[]): Expr {
  const after = `${climb('countedInSameWrite', 'newData', requireLevels('countedInSameWrite', levelsUp))}${childPath('countedInSameWrite', segments)}`;
  const before = `${climb('countedInSameWrite', 'data', levelsUp)}${childPath('countedInSameWrite', segments)}`;
  return or(
    raw(`${after}.child('count').val() != ${before}.child('count').val()`),
    raw(`${after}.child('windowStart').val() != ${before}.child('windowStart').val()`),
  );
}
