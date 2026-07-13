import type { Expr, Segment } from './types.js';
import { all, any, expr } from './compose.js';
import { authenticated, ownPath, ownField, isNew, hasChild, rootExists, rootEquals } from './atoms.js';

/** Only the path owner (auth.uid === $pathVar) can access */
export const pathOwnerOnly = (pathVar: string): Expr =>
  all(authenticated(), ownPath(pathVar));

/** Only the field owner (auth.uid === data.child(field).val()) can access */
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
  expr(`root.child("${listName}").child($${pathVarName}).child(auth.uid).exists()`);

/** All specified fields must be present in the incoming data */
export const required = (...fields: string[]): Expr =>
  all(...fields.map(f => hasChild(f)));

/** State machine: only allowed transitions on a field */
export const transition = (field: string, allowed: Array<[string, string]>): Expr =>
  any(...allowed.map(([from, to]) =>
    all(
      expr(`data.child("${field}").val() === "${from}"`),
      expr(`newData.child("${field}").val() === "${to}"`),
    )
  ));
