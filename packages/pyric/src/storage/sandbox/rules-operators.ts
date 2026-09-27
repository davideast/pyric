import { NO_OP, RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { describeRulesType as describeType, isRulesMap } from '../../rules/simulator/rules-type.js';
import {
  RuleError,
  numericValue as numVal,
} from './rules-values.js';

/** The value types whose `is` test reads the value's own type name. */
const VALUE_TYPE_NAMES = new Set(['timestamp', 'duration', 'bytes', 'latlng', 'path']);

/**
 * `value is <type>` check. Numbers use the RULES-B5 model: a `RulesFloat`
 * wrapper is a FLOAT, a bare number is an INT — so `1.0 is float` and
 * `!(1.0 is int)` type by literal form exactly as production does. A bare
 * NON-integral number (a fractional value that arrived from data rather than
 * a literal, e.g. a Firestore-lookup double) still reads as float. `number`
 * accepts either. Timestamps, durations, and bytes are wrapper values that
 * carry their type name.
 */
export function typeMatches(v: unknown, typeName: string): boolean | RuleError {
  switch (typeName) {
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'int': return typeof v === 'number' && Number.isInteger(v);
    case 'float': return v instanceof RulesFloat || (typeof v === 'number' && !Number.isInteger(v));
    case 'number': return v instanceof RulesFloat || typeof v === 'number';
    case 'list': return Array.isArray(v);
    case 'map': return isRulesMap(v);
    case 'null': return v === null;
  }
  if (VALUE_TYPE_NAMES.has(typeName)) {
    return v instanceof RulesValue && v.typeName === typeName;
  }
  // No capture pins `is` against path, latlng, set, or another type name, so
  // the test cannot answer honestly: deny with a reason rather than
  // false-allow.
  return new RuleError(`'is ${typeName}' is not supported by the storage evaluator.`);
}

/**
 * True for a Timestamp, Duration, or Bytes value. These own their operators
 * through `binaryOp`; floats are wrapper values too but take the numeric
 * path with ints.
 */
export function isValueTypeOperand(v: unknown): boolean {
  return v instanceof RulesValue && !(v instanceof RulesFloat);
}

/**
 * A comparison or arithmetic operator with a Timestamp, Duration, or Bytes
 * operand, dispatched to the left value's `binaryOp`. `+` also tries the
 * right value, so `duration + timestamp` adds like `timestamp + duration`.
 * An operand pair no value accepts is production's "Unsupported operation
 * error" (captured for `timestamp < int`), an error value that denies.
 */
export function evalValueOperator(op: string, left: unknown, right: unknown): unknown {
  if (left instanceof RulesValue) {
    const result = left.binaryOp(op, right);
    if (result !== NO_OP) return result;
  }
  if (op === '+' && right instanceof RulesValue) {
    const result = right.binaryOp(op, left);
    if (result !== NO_OP) return result;
  }
  return unsupportedOperation(op, left, right);
}

/** Production's error value for an operand pair an operator does not accept. */
function unsupportedOperation(op: string, left: unknown, right: unknown): RuleError {
  return new RuleError(
    `Unsupported operation error. Received: ${describeType(left)} ${op} ${describeType(right)}.`,
  );
}

/** True for a float (RulesFloat); ints are bare numbers. */
function isFloatNum(v: unknown): boolean {
  return v instanceof RulesFloat;
}

/** The arithmetic operators `evalArithmetic` answers. */
export type ArithmeticOperator = '+' | '-' | '*' | '/' | '%';

/**
 * `+`, `-`, `*`, `/`, and `%` over operands that are not Timestamp, Duration,
 * or Bytes values. `+` concatenates two strings. Ints and floats compute
 * numerically, and the result is a float when either operand is one. Int
 * division truncates toward zero, and an int zero divisor for `/` or `%` is
 * an error. A float zero divisor yields Infinity or NaN. Every other operand
 * pair, including list + list, is production's "Unsupported operation error",
 * an error value that `&&` and `||` absorb.
 */
export function evalArithmetic(op: ArithmeticOperator, left: unknown, right: unknown): unknown {
  if (op === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  const l = numVal(left);
  const r = numVal(right);
  if (l === undefined || r === undefined) return unsupportedOperation(op, left, right);
  const float = isFloatNum(left) || isFloatNum(right);
  let result: number;
  switch (op) {
    case '+': result = l + r; break;
    case '-': result = l - r; break;
    case '*': result = l * r; break;
    case '/':
      if (!float && r === 0) return new RuleError('Division by zero.');
      result = float ? l / r : Math.trunc(l / r);
      break;
    case '%':
      if (!float && r === 0) return new RuleError('Modulo by zero.');
      result = l % r;
      break;
  }
  return float ? new RulesFloat(result) : result;
}

/** The ordering operators `evalOrdering` answers. */
export type OrderingOperator = '<' | '>' | '<=' | '>=';

/**
 * `<`, `>`, `<=`, and `>=` over operands that are not Timestamp, Duration, or
 * Bytes values. Ints and floats order by numeric value, and two strings order
 * lexicographically. Every other operand pair, including bool with bool,
 * list with list, map with map, and any pair with null, is production's
 * "Unsupported operation error", an error value that `!` keeps and that
 * `&&` and `||` absorb.
 */
export function evalOrdering(op: OrderingOperator, left: unknown, right: unknown): boolean | RuleError {
  const l = numVal(left);
  const r = numVal(right);
  if (l !== undefined && r !== undefined) return orders(op, l, r);
  if (typeof left === 'string' && typeof right === 'string') return orders(op, left, right);
  return unsupportedOperation(op, left, right);
}

function orders<T extends number | string>(op: OrderingOperator, left: T, right: T): boolean {
  switch (op) {
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
  }
}
