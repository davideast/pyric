import type { Expr, Segment } from './types.js';

const e = (raw: string): Expr => raw as Expr;

function buildPath(segments: Segment[]): string {
  return segments.map(s => {
    if (typeof s === 'string') return `child("${s}")`;
    // Unquoted reference: path variable ($teamId) or runtime (auth.uid)
    return `child(${s.$})`;
  }).join('.');
}

// --- Authentication ---

export const authenticated = (): Expr => e('auth !== null');

// --- Ownership ---

/** Path-based ownership: auth.uid matches a URL path variable */
export const ownPath = (pathVar: string): Expr => e(`auth.uid === ${pathVar}`);

/** Field-based ownership: auth.uid matches a value stored in a data field */
export const ownField = (field: string): Expr => e(`auth.uid === data.child("${field}").val()`);

// --- Existence ---

/** Data at this path doesn't exist yet (creation check) */
export const isNew = (): Expr => e('!data.exists()');

// --- Schema ---

/** Incoming data must be an object with at least one child */
export const hasChildren = (): Expr => e('newData.hasChildren()');

/** Incoming data must have a specific child field */
export const hasChild = (field: string): Expr => e(`newData.hasChild("${field}")`);

/** Field must be a string */
export const fieldIsString = (field: string): Expr => e(`newData.child("${field}").isString()`);

/** Field must be a number */
export const fieldIsNumber = (field: string): Expr => e(`newData.child("${field}").isNumber()`);

/** Field must be a boolean */
export const fieldIsBoolean = (field: string): Expr => e(`newData.child("${field}").isBoolean()`);

/** Field must be one of the allowed string values */
export const fieldEnum = (field: string, values: string[]): Expr =>
  e(values.map(v => `newData.child("${field}").val() === "${v}"`).join(' || '));

// --- Immutability ---

/** Field can be set on creation but never changed after */
export const immutable = (field: string): Expr =>
  e(`!data.exists() || newData.child("${field}").val() === data.child("${field}").val()`);

/** This node's own value can be set on creation but never changed */
export const immutableSelf = (): Expr =>
  e('!data.exists() || newData.val() === data.val()');

// --- Cross-path lookups ---

/** Check if a path exists in the database (via root) */
export const rootExists = (segments: Segment[]): Expr =>
  e(`root.${buildPath(segments)}.exists()`);

/** Check if a path's value equals a specific string (via root) */
export const rootEquals = (segments: Segment[], value: string): Expr =>
  e(`root.${buildPath(segments)}.val() === "${value}"`);
