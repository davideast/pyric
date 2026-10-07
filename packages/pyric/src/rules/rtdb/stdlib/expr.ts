/**
 * Expression helpers shared by the RTDB rules standard library modules.
 *
 * RTDB rules have no functions and no `let`, so every builder returns the
 * whole expression it stands for. These helpers keep that text minimal and
 * correctly grouped: `and` parenthesizes an operand only when it holds a
 * top-level `||` or ternary, and `or` one that holds a top-level `&&` or
 * ternary. Literals
 * are single-quoted strings, numbers and booleans; `==` and `!=` compare
 * without converting types in production, so a literal of the wrong type
 * never matches.
 */
import type { Expr } from '../constraints/types.js';

export type Literal = string | number | boolean | null;

export const raw = (text: string): Expr => text as Expr;

/** A rules literal for a string, number, boolean or null. */
export function lit(value: Literal): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`RTDB rules have no literal for ${value}.`);
    return String(value);
  }
  return value ? 'true' : 'false';
}

/** A finite number argument, or a thrown error naming the builder. */
export function finite(builder: string, name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${builder}: ${name} must be a finite number, got ${String(value)}.`);
  }
  return value;
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
    else if (ch === '/' && text.slice(Math.max(0, i - 8), i).endsWith('matches(')) regex = true;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && operators.some((op) => text.startsWith(op, i))) return true;
  }
  return false;
}

const wrap = (text: string): string => `(${text})`;

/** Every operand holds (AND). */
export function and(...operands: Expr[]): Expr {
  const parts = operands.filter((op) => op.length > 0);
  if (parts.length === 0) return raw('true');
  if (parts.length === 1) return parts[0]!;
  return raw(parts.map((op) => (topLevel(op, ['||', '?']) ? wrap(op) : op)).join(' && '));
}

/** At least one operand holds (OR). */
export function or(...operands: Expr[]): Expr {
  const parts = operands.filter((op) => op.length > 0);
  if (parts.length === 0) return raw('false');
  if (parts.length === 1) return parts[0]!;
  // `&&` binds tighter than `||`, so grouping an AND operand is for the
  // reader, not the parser.
  return raw(parts.map((op) => (topLevel(op, ['&&', '?']) ? wrap(op) : op)).join(' || '));
}

/** The negation of `operand`. */
export function negate(operand: Expr): Expr {
  // A member chain of plain names and calls with at most a quoted or plain
  // argument, such as data.child('at').exists(), needs no parentheses.
  const chain = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*(\((?:'[^'\\]*'|[\w$.]*)\))?)*$/;
  return raw(chain.test(operand) ? `!${operand}` : `!(${operand})`);
}

/** `snapshot.child(path).val()`, or `snapshot.val()` for the node itself. */
export function val(snapshot: 'data' | 'newData' | string, path?: string): Expr {
  return raw(path ? `${snapshot}.child(${lit(path)}).val()` : `${snapshot}.val()`);
}

/** `snapshot.child(path).exists()`, or `snapshot.exists()` for the node itself. */
export function exists(snapshot: 'data' | 'newData' | string, path?: string): Expr {
  return raw(path ? `${snapshot}.child(${lit(path)}).exists()` : `${snapshot}.exists()`);
}

export const eq = (left: string, right: string): Expr => raw(`${left} == ${right}`);
export const ne = (left: string, right: string): Expr => raw(`${left} != ${right}`);

/** `newData.child(field).val() == data.child(field).val()`. */
export const sameAsBefore = (field: string): Expr => eq(val('newData', field), val('data', field));

/** A child key a builder reads: non-empty, with no characters RTDB keys reject. */
export function fieldName(builder: string, field: string): string {
  if (typeof field !== 'string' || field.length === 0 || /[.#$[\]]/.test(field)) {
    throw new Error(`${builder}: '${String(field)}' is not a field name; RTDB keys cannot be empty or contain . # $ [ ].`);
  }
  return field;
}

/** A path variable name such as `$uid`, or a thrown error naming the builder. */
export function pathVariable(builder: string, name: string): string {
  if (!/^\$[A-Za-z_][\w]*$/.test(name)) {
    throw new Error(`${builder}: '${name}' is not a path variable such as '$uid'.`);
  }
  return name;
}
