import type { Expr, Segment } from './types.js';
import { all, any, expr, fieldName, lit } from './compose.js';
import { dataVal, eq, newDataVal } from './data.js';
import { authenticated, ownPath, ownField, isNew, rootExists, rootEquals } from './atoms.js';

/** Only the path owner (auth.uid == $pathVar) can access */
export const pathOwnerOnly = (pathVar: string): Expr =>
  all(authenticated(), ownPath(pathVar));

/** Only the field owner (auth.uid == data.child(field).val()) can access */
export const fieldOwnerOnly = (field: string): Expr =>
  all(authenticated(), ownField(field));

/** Anyone authenticated can create; only the field owner can edit */
export const ownerOrNew = (field: string): Expr =>
  all(authenticated(), any(isNew(), ownField(field)));

/** Cross-path role check via root lookup */
export const hasRole = (segments: Segment[], role: string): Expr =>
  rootEquals(segments, role);

/** Cross-path membership check: root.child(list).child($var).child(auth.uid).exists() */
export const isMember = (listName: string, pathVarName: string): Expr =>
  expr(`root.child(${lit(listName)}).child($${pathVarName}).child(auth.uid).exists()`);

/**
 * All specified fields must be present in the incoming data. Single keys are
 * checked together with `newData.hasChildren([...])`; a nested path such as
 * 'puck/x' is checked with `newData.hasChild('puck/x')`, joined with `&&`.
 * Every segment of every field must be a valid RTDB key.
 */
export const required = (...fields: string[]): Expr => {
  if (fields.length === 0) throw new Error('required: pass at least one field.');
  for (const field of fields) {
    for (const segment of String(field).split('/')) fieldName('required', segment);
  }
  const keys = fields.filter((f) => !f.includes('/'));
  const paths = fields.filter((f) => f.includes('/'));
  return all(
    ...(keys.length > 0 ? [expr(`newData.hasChildren([${keys.map((f) => lit(f)).join(', ')}])`)] : []),
    ...paths.map((p) => expr(`newData.hasChild(${lit(p)})`)),
  );
};

/** State machine: only allowed transitions on a field */
export const transition = (field: string, allowed: Array<[string, string]>): Expr =>
  any(...allowed.map(([from, to]) =>
    all(
      eq(dataVal(field), from),
      eq(newDataVal(field), to),
    )
  ));
