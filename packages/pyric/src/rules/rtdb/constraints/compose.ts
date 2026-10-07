import type { Expr } from './types.js';

/** Create an Expr from a raw expression string. */
export const expr = (raw: string): Expr => raw as Expr;

/** A literal value the rules language can write. */
export type Literal = string | number | boolean | null;

/**
 * A rules literal: a single-quoted string with `\` and `'` escaped, a finite
 * number, a boolean, or null. Every builder writes its literals through this,
 * so compiled rules use one quote style.
 *
 * The quote and backslash escapes match Pyric's rules simulator. A string
 * with a newline or another control character is refused: Pyric does not
 * model escapes for those, and production behavior for them is not captured.
 */
export function lit(value: Literal): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`lit: ${JSON.stringify(value)} holds a newline or another control character, which RTDB rules literals here cannot carry.`);
    }
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`RTDB rules have no literal for ${value}.`);
    return String(value);
  }
  return value ? 'true' : 'false';
}

/** A child key a builder reads: non-empty, with no characters RTDB keys reject. */
export function fieldName(builder: string, field: string): string {
  if (typeof field !== 'string' || field.length === 0 || /[.#$[\]]/.test(field)) {
    throw new Error(`${builder}: '${String(field)}' is not a field name; RTDB keys cannot be empty or contain . # $ [ ].`);
  }
  return field;
}

/** Whether `text` holds one of `operators` outside quotes, regex literals and brackets. */
function topLevel(text: string, operators: string[]): boolean {
  let depth = 0;
  let quote: string | null = null;
  let regex = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (regex) {
      if (ch === '\\') i++;
      else if (ch === '/') regex = false;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '/' && /\(\s*$/.test(text.slice(0, i))) regex = true;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && operators.some((op) => text.startsWith(op, i))) return true;
  }
  return false;
}

const group = (text: string, operators: string[]): string =>
  (topLevel(text, operators) ? `(${text})` : text);

/**
 * All conditions must be true (AND). An operand is parenthesized only when
 * it holds a top-level `||` or ternary, which binds looser than `&&`.
 * Empty operands are dropped; with none left it throws, since an empty
 * conjunction would allow everything. Use {@link always} for that.
 */
export function all(...exprs: Expr[]): Expr {
  const parts = exprs.filter((e) => e.length > 0);
  if (parts.length === 0) throw new Error('all: pass at least one condition; an empty all() would allow everything.');
  if (parts.length === 1) return parts[0]!;
  return expr(parts.map((e) => group(e, ['||', '?'])).join(' && '));
}

/**
 * At least one condition must be true (OR). An operand with a top-level `&&`
 * is parenthesized for the reader, and one with a ternary for the parser.
 * Empty operands are dropped; with none left it throws, since an empty
 * disjunction would deny everything. Use {@link deny} for that.
 */
export function any(...exprs: Expr[]): Expr {
  const parts = exprs.filter((e) => e.length > 0);
  if (parts.length === 0) throw new Error('any: pass at least one condition; an empty any() would deny everything.');
  if (parts.length === 1) return parts[0]!;
  return expr(parts.map((e) => group(e, ['&&', '?'])).join(' || '));
}

/** Negate a condition. A member chain such as `data.child('a').exists()` needs no parentheses. */
export function not(e: Expr): Expr {
  const chain = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*(\((?:'[^'\\]*'|[\w$.]*)\))?)*$/;
  return expr(chain.test(e) ? `!${e}` : `!(${e})`);
}

/** Always deny (false). */
export const deny = (): Expr => expr('false');

/** Always allow (true). */
export const always = (): Expr => expr('true');

/** Always allow (true). Readable alias for always(). */
export const allow = always;
