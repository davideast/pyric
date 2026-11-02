import { DIVIDE_BY_ZERO_MESSAGE } from './eval-error.js';
import { RulesFloat } from './wrappers/float.js';

/**
 * Rules ints, shared by the Firestore simulator and the Storage evaluator.
 *
 * A rules int is a signed 64-bit integer. Every int the rules compute is a
 * JavaScript `bigint`: literals, `+ - * / %` and unary minus on ints, `int()`,
 * `math.abs()` and `math.round()`. An integral JavaScript number that a host
 * value carries, such as a document field, `request.resource.size` or a
 * `size()` count, is an int as well: it is exact, since a JavaScript number
 * holds every integer up to 2^53. The readers here accept both, so the two
 * never compare unequal for the same value.
 *
 * A result past the int64 range is production's "Integer value is out of the
 * range" error, except `MIN / -1`, which production returns as `MIN`.
 * Firestore corpus scenario `int64-and-duration-range` and Storage scenarios
 * `h1-int64-precision` and `xref-shared-language-semantics` record the
 * verdicts.
 */

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Production's error for an int result outside int64, in Firestore and Storage rules alike. */
export const INT_RANGE_MESSAGE = 'Integer value is out of the [-9223372036854775808, 9223372036854775807] range.';

/** An int operation production refuses, carrying its message; each evaluator makes it an error value. */
export class IntFailure {
  constructor(readonly message: string) {}
}

/** True for a rules int: a bigint, or an integral JavaScript number from a host value. */
export function isRulesInt(value: unknown): value is bigint | number {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value));
}

/** A rules int as a bigint, or undefined for any other value. */
export function rulesInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  return undefined;
}

/** A rules float as a double: a `RulesFloat`, or a JavaScript number with a fraction from a host value. */
export function rulesFloatValue(value: unknown): number | undefined {
  if (value instanceof RulesFloat) return value.value;
  if (typeof value === 'number' && !Number.isInteger(value)) return value;
  return undefined;
}

/** A rules int or float as a double, or undefined for any other value. */
export function rulesNumberAsDouble(value: unknown): number | undefined {
  const float = rulesFloatValue(value);
  if (float !== undefined) return float;
  const int = rulesInt(value);
  return int === undefined ? undefined : Number(int);
}

/** True when `value` fits int64. */
export function inInt64(value: bigint): boolean {
  return value >= INT64_MIN && value <= INT64_MAX;
}

function inRange(value: bigint): bigint | IntFailure {
  return inInt64(value) ? value : new IntFailure(INT_RANGE_MESSAGE);
}

/** The ordering operators. */
export type OrderingOperator = '<' | '>' | '<=' | '>=';

/**
 * `left op right` on two rules numbers, or undefined when either is not a
 * number. Two ints order exactly, above 2^53 too. When either side is a
 * float, the int converts to a double, as arithmetic and equality convert
 * it, so `9007199254740993 > 9007199254740992.0` is false and the two are
 * equal. Firestore and Storage both order numbers here.
 */
export function orderNumbers(op: OrderingOperator, left: unknown, right: unknown): boolean | undefined {
  const l = rulesInt(left);
  const r = rulesInt(right);
  if (l !== undefined && r !== undefined) return orders(op, l, r);
  const ld = rulesNumberAsDouble(left);
  const rd = rulesNumberAsDouble(right);
  if (ld === undefined || rd === undefined) return undefined;
  return orders(op, ld, rd);
}

function orders<T extends bigint | number>(op: OrderingOperator, left: T, right: T): boolean {
  switch (op) {
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
  }
}

/** True for `<`, `>`, `<=` and `>=`. */
export function isOrderingOperator(op: string): op is OrderingOperator {
  return op === '<' || op === '>' || op === '<=' || op === '>=';
}

/** The int arithmetic operators. */
export type IntOperator = '+' | '-' | '*' | '/' | '%';

/**
 * `left op right` on two ints. Division truncates toward zero and the
 * remainder takes the dividend's sign; a zero divisor is production's
 * "Divide by zero error.". `MIN / -1` is `MIN`, as production returns it;
 * every other result past int64 is the range error.
 */
export function intArithmetic(op: IntOperator, left: bigint, right: bigint): bigint | IntFailure {
  switch (op) {
    case '+': return inRange(left + right);
    case '-': return inRange(left - right);
    case '*': return inRange(left * right);
    case '/':
      if (right === 0n) return new IntFailure(DIVIDE_BY_ZERO_MESSAGE);
      if (left === INT64_MIN && right === -1n) return INT64_MIN;
      return left / right;
    case '%':
      if (right === 0n) return new IntFailure(DIVIDE_BY_ZERO_MESSAGE);
      return left % right;
  }
}

/** Unary minus on an int: `-MIN` is past int64, so it is the range error. */
export function negateInt(value: bigint): bigint | IntFailure {
  return inRange(-value);
}

/**
 * A float truncated toward zero to an int, as `int(float)` converts it: NaN
 * is 0 and a value past int64, an infinity included, saturates at the bound.
 */
export function truncateToInt(value: number): bigint {
  return saturate(value, Math.trunc);
}

/** A float rounded half up to an int, as `math.round()` returns it, with `truncateToInt`'s NaN and bounds. */
export function roundToInt(value: number): bigint {
  return saturate(value, Math.round);
}

function saturate(value: number, toWhole: (value: number) => number): bigint {
  if (Number.isNaN(value)) return 0n;
  if (value <= -(2 ** 63)) return INT64_MIN;
  if (value >= 2 ** 63) return INT64_MAX;
  return BigInt(toWhole(value));
}

/**
 * Production's compile error for an int literal outside int64, naming the
 * digits as written.
 */
export function invalidNumberLiteralMessage(digits: string): string {
  return `Invalid number literal ${digits}`;
}

/**
 * The value of a numeric literal node. A literal written with a decimal
 * point is a float, even when integral (`1.0`). A literal of digits is an
 * int, read from its source text so every bit survives; a literal that
 * names 2^63 is only valid under unary minus, which the compile check
 * enforces. A literal a proof synthesized from a number reads as that
 * number: an int when it is a safe integer, else a float, since a number
 * past 2^53 such as `1e+21` no longer names one exact int.
 */
export function numericLiteralValue(value: number, raw: string): bigint | RulesFloat {
  if (raw.includes('.')) return new RulesFloat(value);
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return Number.isSafeInteger(value) ? BigInt(value) : new RulesFloat(value);
}

/**
 * The digits of an int literal past int64, or undefined for a literal in
 * range. `negated` is true for a literal directly under unary minus, which
 * may name 2^63 (`-9223372036854775808`).
 */
export function outOfRangeLiteral(value: unknown, raw: string, negated: boolean): string | undefined {
  if (typeof value !== 'number' || !/^\d+$/.test(raw)) return undefined;
  const magnitude = BigInt(raw);
  const limit = negated ? -INT64_MIN : INT64_MAX;
  return magnitude > limit ? raw : undefined;
}
