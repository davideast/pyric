import type { Expr, Segment } from './types.js';
import { expr as e, lit } from './compose.js';
import { looksLikeRuleReference } from '../grammar/linter.js';

type CompareValue = string | number | boolean | null | Segment;

function formatReferenceSuggestion(value: string): string {
  if (value === 'auth.uid') {
    return `AUTH_UID (or ref(${JSON.stringify(value)}))`;
  }
  return `ref(${JSON.stringify(value)})`;
}

function formatRight(value: CompareValue): string {
  if (value !== null && typeof value === 'object' && '$' in value) return value.$;
  if (typeof value === 'string' && looksLikeRuleReference(value)) {
    throw new Error(
      `Comparison value ${JSON.stringify(value)} looks like a rule reference and would be quoted as a string literal; pass ${formatReferenceSuggestion(value)} to compare against the reference.`,
    );
  }
  return lit(value as string | number | boolean | null);
}

// ---- Value access ----

/** Read data value at current node or a child path (pre-write state) */
export const dataVal = (path?: string): Expr =>
  path ? e(`data.child(${lit(path)}).val()`) : e('data.val()');

/** Read incoming data value at current node or a child path (post-write state) */
export const newDataVal = (path?: string): Expr =>
  path ? e(`newData.child(${lit(path)}).val()`) : e('newData.val()');

// ---- Existence ----

/** Check if data exists at current node or a child path */
export const dataExists = (path?: string): Expr =>
  path ? e(`data.child(${lit(path)}).exists()`) : e('data.exists()');

/** Check if incoming data exists at current node or a child path */
export const newDataExists = (path?: string): Expr =>
  path ? e(`newData.child(${lit(path)}).exists()`) : e('newData.exists()');

// ---- Type checks ----

/** Check incoming data type at current node */
export const newDataIs = (type: 'String' | 'Number' | 'Boolean'): Expr =>
  e(`newData.is${type}()`);

// ---- Parent navigation ----

function parentChain(base: string, depth: number): string {
  return base + '.parent()'.repeat(depth);
}

/** Navigate up from data snapshot, then read a child field's value */
export const dataParentVal = (depth: number, field: string): Expr =>
  e(`${parentChain('data', depth)}.child(${lit(field)}).val()`);

/** Navigate up from newData snapshot, then read a child field's value */
export const newDataParentVal = (depth: number, field: string): Expr =>
  e(`${parentChain('newData', depth)}.child(${lit(field)}).val()`);

/** Navigate up from newData snapshot, then check if a child field exists */
export const newDataParentExists = (depth: number, field: string): Expr =>
  e(`${parentChain('newData', depth)}.child(${lit(field)}).exists()`);

// ---- Comparisons ----

/** Equality: left == right (right is a literal value or runtime ref) */
export const eq = (left: Expr, right: CompareValue): Expr =>
  e(`${left} == ${formatRight(right)}`);

/** Inequality: left != right */
export const neq = (left: Expr, right: CompareValue): Expr =>
  e(`${left} != ${formatRight(right)}`);

/** Greater than: left > right */
export const gt = (left: Expr, right: number): Expr =>
  e(`${left} > ${lit(right)}`);

/** Less than or equal: left <= right */
export const lte = (left: Expr, right: number): Expr =>
  e(`${left} <= ${lit(right)}`);

// ---- Constants & reference helpers ----

/** Wrap a runtime rule expression so comparisons emit it unquoted */
export const ref = (expression: string): Segment => ({ $: expression });

/** auth.uid as a comparison value (unquoted in expressions) */
export const AUTH_UID: Segment = { $: 'auth.uid' };
