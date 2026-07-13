import type { Expr } from './types.js';

/** Create an Expr from a raw expression string. */
export const expr = (raw: string): Expr => raw as Expr;

/** All conditions must be true (AND). */
export const all = (...exprs: Expr[]): Expr =>
  expr(exprs.map(e => `(${e})`).join(' && '));

/** At least one condition must be true (OR). */
export const any = (...exprs: Expr[]): Expr =>
  expr(exprs.map(e => `(${e})`).join(' || '));

/** Negate a condition. */
export const not = (e: Expr): Expr => expr(`!(${e})`);

/** Always deny (false). */
export const deny = (): Expr => expr('false');

/** Always allow (true). */
export const always = (): Expr => expr('true');

/** Always allow (true). Readable alias for always(). */
export const allow = always;
