import type { Expr, Segment } from './types.js';
import { any, expr as e, fieldName, lit, not } from './compose.js';
import { childPathName, dataExists, dataVal, eq, newDataVal } from './data.js';

function buildPath(builder: string, segments: Segment[]): string {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error(`${builder}: pass at least one segment.`);
  return segments.map(s => {
    if (typeof s === 'string') return `child(${lit(fieldName(builder, s))})`;
    // Unquoted reference: path variable ($teamId) or runtime (auth.uid)
    if (typeof s?.$ !== 'string' || s.$.trim().length === 0) {
      throw new Error(`${builder}: segment expression '$' must be a non-empty string.`);
    }
    return `child(${s.$})`;
  }).join('.');
}

// --- Authentication ---

export const authenticated = (): Expr => e('auth != null');

// --- Ownership ---

/** Path-based ownership: auth.uid matches a URL path variable */
export function ownPath(pathVar: string): Expr {
  if (typeof pathVar !== 'string' || !/^\$[A-Za-z_]\w*$/.test(pathVar)) {
    throw new Error(`ownPath: '${String(pathVar)}' is not a path variable such as '$uid'.`);
  }
  return e(`auth.uid == ${pathVar}`);
}

/** Field-based ownership: auth.uid matches a value stored in a data field */
export const ownField = (field: string): Expr => e(`auth.uid == ${dataVal(field)}`);

// --- Existence ---

/** Data at this path doesn't exist yet (creation check) */
export const isNew = (): Expr => not(dataExists());

// --- Schema ---

/** Incoming data must be an object with at least one child */
export const hasChildren = (): Expr => e('newData.hasChildren()');

/** Incoming data must have a specific child field */
export const hasChild = (field: string): Expr => e(`newData.hasChild(${lit(childPathName('hasChild', field))})`);

/** Field must be a string */
export const fieldIsString = (field: string): Expr => e(`newData.child(${lit(childPathName('fieldIsString', field))}).isString()`);

/** Field must be a number */
export const fieldIsNumber = (field: string): Expr => e(`newData.child(${lit(childPathName('fieldIsNumber', field))}).isNumber()`);

/** Field must be a boolean */
export const fieldIsBoolean = (field: string): Expr => e(`newData.child(${lit(childPathName('fieldIsBoolean', field))}).isBoolean()`);

/** Field must be one of the allowed string values */
export const fieldEnum = (field: string, values: string[]): Expr =>
  any(...values.map(v => eq(newDataVal(field), v)));

// --- Immutability ---

/** Field can be set on creation but never changed after */
export const immutable = (field: string): Expr =>
  any(isNew(), eq(newDataVal(field), { $: dataVal(field) }));

/** This node's own value can be set on creation but never changed */
export const immutableSelf = (): Expr =>
  any(isNew(), eq(newDataVal(), { $: dataVal() }));

// --- Cross-path lookups ---

/** Check if a path exists in the database (via root) */
export const rootExists = (segments: Segment[]): Expr =>
  e(`root.${buildPath('rootExists', segments)}.exists()`);

/** Check if a path's value equals a specific string (via root) */
export const rootEquals = (segments: Segment[], value: string): Expr =>
  e(`root.${buildPath('rootEquals', segments)}.val() == ${lit(value)}`);
