/**
 * `counters`: numbers that move by a known step, only improve, or advance
 * one side of a score at a time.
 *
 * Placement: `incrementedBy`, `changedBy` and `improved` read the node they
 * are placed on, so they go in the counter node's `.validate`.
 * `oneIncremented` goes in the `.validate` of the node that holds the
 * counters, such as a score with `host` and `guest`.
 *
 * `.validate` runs for every node a write carries, even when the value did
 * not change. A set of a parent that carries an unchanged counter therefore
 * runs `incrementedBy` and is refused. Write a step-checked counter on its
 * own, in a set of the counter or an update that names it, or use
 * `changedBy` with a range that includes 0.
 *
 * `.validate` does not run on a delete, so a counter is reset by deleting it
 * unless a `.write` on its path refuses deletes, for example with
 * `lifecycle.noDelete()`.
 */
import type { Expr } from '../constraints/types.js';
import { and, exists, fieldName, finite, lit, negate, or, raw, sameAsBefore, val } from './expr.js';

/**
 * The written number is the stored one plus `n`. With `start`, a create
 * must write `start`; without it, a create is refused. The stored value is
 * required to exist before it is added to, so the rule never adds to null.
 */
export function incrementedBy(n: number, options: { start?: number } = {}): Expr {
  finite('incrementedBy', 'n', n);
  const step = and(exists('data'), raw(`newData.val() == data.val() + ${lit(n)}`));
  if (options.start === undefined) return step;
  finite('incrementedBy', 'start', options.start);
  return or(and(negate(exists('data')), raw(`newData.val() == ${lit(options.start)}`)), step);
}

/** The written number differs from the stored one by `min` to `max`, inclusive. A create is refused. */
export function changedBy(min: number, max: number): Expr {
  finite('changedBy', 'min', min);
  finite('changedBy', 'max', max);
  if (min > max) throw new Error(`changedBy: min ${min} is greater than max ${max}.`);
  return and(
    raw('newData.isNumber()'),
    exists('data'),
    raw(`newData.val() - data.val() >= ${lit(min)}`),
    raw(`newData.val() - data.val() <= ${lit(max)}`),
  );
}

/**
 * The written number is strictly greater ('up') or smaller ('down') than the
 * stored one. The first value written passes. Use it for a best score or a
 * fastest time.
 */
export function improved(direction: 'up' | 'down'): Expr {
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`improved: direction must be 'up' or 'down', got '${String(direction)}'.`);
  }
  const op = direction === 'up' ? '>' : '<';
  return and(raw('newData.isNumber()'), or(negate(exists('data')), raw(`newData.val() ${op} data.val()`)));
}

/**
 * Exactly one of the child counters `fields` grows by `n` and the others keep
 * their values. With `start`, a create writes every field as `start`.
 */
export function oneIncremented(fields: string[], n: number, options: { start?: number } = {}): Expr {
  if (fields.length === 0) throw new Error('oneIncremented: pass at least one field.');
  for (const f of fields) fieldName('oneIncremented', f);
  finite('oneIncremented', 'n', n);
  if (n === 0) throw new Error('oneIncremented: n must not be 0.');
  const steps = fields.map((f) =>
    and(
      exists('data', f),
      raw(`${val('newData', f)} == ${val('data', f)} + ${lit(n)}`),
      ...fields.filter((other) => other !== f).map((other) => sameAsBefore(other)),
    ));
  if (options.start === undefined) return or(...steps);
  const start = lit(finite('oneIncremented', 'start', options.start));
  return or(
    and(negate(exists('data')), ...fields.map((f) => raw(`${val('newData', f)} == ${start}`))),
    ...steps,
  );
}
