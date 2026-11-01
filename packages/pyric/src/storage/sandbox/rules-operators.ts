import { NO_OP, RulesValue, ValueRangeError } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
import { describeRulesType as describeType, isRulesMap } from '../../rules/simulator/rules-type.js';
import { RuleError } from './rules-values.js';
import {
  IntFailure,
  type IntOperator,
  intArithmetic,
  isRulesInt,
  rulesFloatValue,
  rulesInt,
  rulesNumberAsDouble,
} from '../../rules/simulator/rules-int.js';

/** The value types whose `is` test reads the value's own type name. */
const VALUE_TYPE_NAMES = new Set(['timestamp', 'duration', 'bytes', 'latlng', 'path']);

/**
 * `value is <type>` check. Numbers use the RULES-B5 model: a `RulesFloat`
 * wrapper is a FLOAT, and a bigint or a bare integral number is an INT
 * (`rules-int.ts`), so `1.0 is float` and `!(1.0 is int)` type by literal
 * form exactly as production does. A bare NON-integral number (a fractional value that arrived from data rather than
 * a literal, e.g. a Firestore-lookup double) still reads as float. `number`
 * accepts either. Timestamps, durations, and bytes are wrapper values that
 * carry their type name.
 */
export function typeMatches(v: unknown, typeName: string): boolean | RuleError {
  switch (typeName) {
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'int': return isRulesInt(v);
    case 'float': return rulesFloatValue(v) !== undefined;
    case 'number': return rulesNumberAsDouble(v) !== undefined;
    case 'list': return Array.isArray(v);
    case 'set': return v instanceof FirestoreSet;
    case 'map': return isRulesMap(v);
    case 'null': return v === null;
  }
  if (VALUE_TYPE_NAMES.has(typeName)) {
    return v instanceof RulesValue && v.typeName === typeName;
  }
  // No capture pins `is` against path, latlng, or another type name, so
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
 * error" (captured for `timestamp < int`), an error value that denies. A
 * result past the timestamp or duration range is an error value too.
 */
export function evalValueOperator(op: string, left: unknown, right: unknown): unknown {
  try {
    return dispatchValueOperator(op, left, right);
  } catch (err) {
    // A result past the timestamp or duration range is production's
    // "Timestamp is not valid" or "Duration is not valid" error value.
    if (err instanceof ValueRangeError) return new RuleError(err.message);
    throw err;
  }
}

function dispatchValueOperator(op: string, left: unknown, right: unknown): unknown {
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

/** The arithmetic operators `evalArithmetic` answers. */
export type ArithmeticOperator = IntOperator;

/**
 * `+`, `-`, `*`, `/`, and `%` over operands that are not Timestamp, Duration,
 * or Bytes values. `+` concatenates two strings. Two ints compute in int64
 * (`rules-int.ts`): division truncates toward zero, a zero divisor is an
 * error, and a result past the range is production's "Integer value is out
 * of the range" error, except `MIN / -1`, which is `MIN`. An int and a float,
 * or two floats, compute as doubles into a float, and a float zero divisor
 * yields Infinity or NaN. Every other operand pair, including list + list,
 * is production's "Unsupported operation error". Each error is an error
 * value that `&&` and `||` absorb.
 */
export function evalArithmetic(op: ArithmeticOperator, left: unknown, right: unknown): unknown {
  if (op === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  const leftInt = rulesInt(left);
  const rightInt = rulesInt(right);
  if (leftInt !== undefined && rightInt !== undefined) {
    const result = intArithmetic(op, leftInt, rightInt);
    return result instanceof IntFailure ? new RuleError(result.message) : result;
  }
  const l = rulesNumberAsDouble(left);
  const r = rulesNumberAsDouble(right);
  if (l === undefined || r === undefined) return unsupportedOperation(op, left, right);
  return new RulesFloat(floatArithmetic(op, l, r));
}

function floatArithmetic(op: ArithmeticOperator, l: number, r: number): number {
  switch (op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return l / r;
    case '%': return l % r;
  }
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
  const l = orderingNumber(left);
  const r = orderingNumber(right);
  if (l !== undefined && r !== undefined) return orders(op, l, r);
  if (typeof left === 'string' && typeof right === 'string') return orders(op, left, right);
  return unsupportedOperation(op, left, right);
}

/**
 * A number as ordering reads it: an int exactly, as a bigint, and a float as
 * its double. JavaScript orders a bigint and a number by exact value.
 */
function orderingNumber(value: unknown): bigint | number | undefined {
  return rulesInt(value) ?? rulesFloatValue(value);
}

function orders<T extends bigint | number | string>(op: OrderingOperator, left: T, right: T): boolean {
  switch (op) {
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
  }
}
