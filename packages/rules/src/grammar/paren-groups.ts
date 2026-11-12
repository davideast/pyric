/**
 * Parenthesized groups around each expression node, keyed by node. The AST
 * drops parentheses, but production counts each group as one nesting level
 * toward its "Expression is too complex to evaluate safely." limit
 * (`compile-limits.ts`). A side table keeps the AST shape unchanged.
 */
import type { Expression } from './FirestoreAST.js';

const PAREN_GROUPS = new WeakMap<Expression, number>();

/** How many parenthesized groups directly enclose `expr` in the parsed source: 2 for `((a == b))`. */
export function parenthesizedGroups(expr: Expression): number {
  return PAREN_GROUPS.get(expr) ?? 0;
}

/** Records one more parenthesized group directly around `expr`. */
export function addParenthesizedGroup(expr: Expression): void {
  PAREN_GROUPS.set(expr, parenthesizedGroups(expr) + 1);
}
