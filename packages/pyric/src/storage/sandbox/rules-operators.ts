import { NO_OP, RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import {
  RuleError,
  describeRulesType as describeType,
  isRulesMap,
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
  return new RuleError(
    `Unsupported operation error. Received: ${describeType(left)} ${op} ${describeType(right)}.`,
  );
}

/** True for a float (RulesFloat); ints are bare numbers. */
export function isFloatNum(v: unknown): boolean {
  return v instanceof RulesFloat;
}

export function cmp(a: unknown, b: unknown): number {
  const an = numVal(a);
  const bn = numVal(b);
  // CEL compares int and float by numeric value (`1 < 1.5` is well-typed).
  if (an !== undefined && bn !== undefined) return an - bn;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN; // mismatched types → NaN → all comparisons return false
}

/** Arithmetic over ints and floats: unwraps, computes, and RE-TAGS the result
 *  as a float when either operand was one (int op float promotes to float). */
export function numOp(a: unknown, b: unknown, fn: (x: number, y: number) => number): unknown {
  const an = numVal(a);
  const bn = numVal(b);
  if (an === undefined || bn === undefined) return undefined;
  const result = fn(an, bn);
  return isFloatNum(a) || isFloatNum(b) ? new RulesFloat(result) : result;
}
