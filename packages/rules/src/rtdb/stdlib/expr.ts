/**
 * Argument checks and path helpers shared by the RTDB rules standard library
 * modules. Expressions are composed from the `constraints` primitives
 * (`all`, `any`, `not`, `lit`, `dataVal`, `eq`, ...); this file holds only
 * what the standard library adds on top of them.
 */
import type { Expr } from '../constraints/types.js';
import { fieldName, lit } from '../constraints/compose.js';
import { dataVal, eq, MAX_PARENT_DEPTH, newDataVal } from '../constraints/data.js';

/**
 * The most seats or slots a builder writes one comparison for. This is pyric's own
 * bound, not production's: production deploys much longer chains of terms.
 */
export const MAX_BUILT_COUNT = 1000;

/** An integer of at least `min` and at most `limit`, or a thrown error naming the builder and the argument. */
export function boundedCount(builder: string, name: string, value: number, min: number, limit: number): number {
  if (!Number.isInteger(value) || value < min || value > limit) {
    throw new Error(`${builder}: ${name} must be an integer from ${min} to ${limit}, got ${String(value)}.`);
  }
  return value;
}

/** A finite number argument, or a thrown error naming the builder. */
export function finite(builder: string, name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${builder}: ${name} must be a finite number, got ${String(value)}.`);
  }
  return value;
}

/** `newData.child(field).val() == data.child(field).val()`. */
export const sameAsBefore = (field: string): Expr => eq(newDataVal(field), { $: dataVal(field) });

/**
 * `.child(...)` calls for `segments`: a string is a key, `{ $: 'auth.uid' }`
 * or `{ $: '$roomId' }` a value the rule reads.
 */
// One key per segment (no slash), unlike buildPath in constraints/atoms.ts, which takes slash paths; do not merge them.
export function childPath(builder: string, segments: ReadonlyArray<string | { $: string }>): string {
  if (segments.length === 0) throw new Error(`${builder}: pass at least one segment.`);
  return segments
    .map((s) => {
      if (typeof s === 'string') {
        return `.child(${lit(fieldName(builder, s))})`;
      }
      if (typeof s?.$ !== 'string' || s.$.trim().length === 0) {
        throw new Error(`${builder}: segment expression '$' must be a non-empty string.`);
      }
      return `.child(${s.$})`;
    })
    .join('');
}

/** `snapshot` followed by `levelsUp` `.parent()` calls, or `root` when `levelsUp` is undefined. */
export function climb(builder: string, snapshot: 'data' | 'newData', levelsUp: number | undefined): string {
  if (levelsUp === undefined) return 'root';
  boundedCount(builder, 'levelsUp', levelsUp, 0, MAX_PARENT_DEPTH);
  return `${snapshot}${'.parent()'.repeat(levelsUp)}`;
}

/** A path variable name such as `$uid`, or a thrown error naming the builder. */
export function pathVariable(builder: string, name: string): string {
  if (!/^\$[A-Za-z_][\w]*$/.test(name)) {
    throw new Error(`${builder}: '${name}' is not a path variable such as '$uid'.`);
  }
  return name;
}
