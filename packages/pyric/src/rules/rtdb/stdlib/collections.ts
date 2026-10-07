/**
 * `collections`: which keys a collection may hold, so its size has a bound.
 *
 * RTDB rules cannot count a node's children: a snapshot has no child count,
 * and rules have no loops. A collection's size is bounded by bounding its
 * keys instead. `slotKey` limits a wildcard to the keys '0' to 'max - 1',
 * which is how a client stores an array, so the collection holds at most
 * `max` children; `keyIn` limits it to a fixed list.
 *
 * Placement: the wildcard node's `.validate`, such as
 * `'/seats/$slot': { validate: collections.slotKey('$slot', 4) }`. A child
 * with any other key is refused when it is written.
 *
 * The library has no builder for a collection whose keys must be free, such
 * as push IDs: bounding one needs a count that every add and delete moves in
 * the same write, and it is not provided here.
 */
import type { Expr } from '../constraints/types.js';
import { lit, or, pathVariable, raw } from './expr.js';

/** The wildcard's key is one of `keys`. */
export function keyIn(pathVar: string, keys: string[]): Expr {
  const v = pathVariable('keyIn', pathVar);
  if (keys.length === 0) throw new Error('keyIn: pass at least one key.');
  return or(...keys.map((key) => raw(`${v} == ${lit(key)}`)));
}

/** The wildcard's key is one of '0' to `max - 1`, so the collection holds at most `max` children. */
export function slotKey(pathVar: string, max: number): Expr {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`slotKey: max must be an integer of at least 1, got ${String(max)}.`);
  }
  return keyIn(pathVariable('slotKey', pathVar), Array.from({ length: max }, (_, i) => String(i)));
}
