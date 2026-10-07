/**
 * Argument checks and path helpers shared by the RTDB rules standard library
 * modules. Expressions are composed from the `constraints` primitives
 * (`all`, `any`, `not`, `lit`, `dataVal`, `eq`, ...); this file holds only
 * what the standard library adds on top of them.
 */
import type { Expr } from '../constraints/types.js';
import { lit } from '../constraints/compose.js';
import { dataVal, eq, newDataVal } from '../constraints/data.js';

/** A finite number argument, or a thrown error naming the builder. */
export function finite(builder: string, name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${builder}: ${name} must be a finite number, got ${String(value)}.`);
  }
  return value;
}

/** `newData.child(field).val() == data.child(field).val()`. */
export const sameAsBefore = (field: string): Expr => eq(newDataVal(field), { $: dataVal(field) });

/** A child key a builder reads: non-empty, with no characters RTDB keys reject. */
export function fieldName(builder: string, field: string): string {
  if (typeof field !== 'string' || field.length === 0 || /[.#$[\]]/.test(field)) {
    throw new Error(`${builder}: '${String(field)}' is not a field name; RTDB keys cannot be empty or contain . # $ [ ].`);
  }
  return field;
}

/**
 * `.child(...)` calls for `segments`: a string is a key, `{ $: 'auth.uid' }`
 * or `{ $: '$roomId' }` a value the rule reads.
 */
export function childPath(builder: string, segments: ReadonlyArray<string | { $: string }>): string {
  if (segments.length === 0) throw new Error(`${builder}: pass at least one segment.`);
  return segments
    .map((s) => (typeof s === 'string' ? `.child(${lit(fieldName(builder, s))})` : `.child(${s.$})`))
    .join('');
}

/** `snapshot` followed by `levelsUp` `.parent()` calls, or `root` when `levelsUp` is undefined. */
export function climb(builder: string, snapshot: 'data' | 'newData', levelsUp: number | undefined): string {
  if (levelsUp === undefined) return 'root';
  if (!Number.isInteger(levelsUp) || levelsUp < 0) {
    throw new Error(`${builder}: levelsUp must be an integer of at least 0, got ${String(levelsUp)}.`);
  }
  return `${snapshot}${'.parent()'.repeat(levelsUp)}`;
}

/** A path variable name such as `$uid`, or a thrown error naming the builder. */
export function pathVariable(builder: string, name: string): string {
  if (!/^\$[A-Za-z_][\w]*$/.test(name)) {
    throw new Error(`${builder}: '${name}' is not a path variable such as '$uid'.`);
  }
  return name;
}
