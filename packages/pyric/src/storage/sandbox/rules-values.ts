import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
import { MapDiff } from '../../rules/simulator/mapdiff.js';
import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';

/** Error value that propagates through an expression and denies at the allow boundary. */
export class RuleError {
  constructor(readonly message: string) {}
}

export function isRuleError(value: unknown): value is RuleError {
  return value instanceof RuleError;
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value instanceof RulesFloat) return value.value;
  return undefined;
}

/** A Rules map is a plain key/value record, never a boxed scalar/wrapper. */
export function isRulesMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Rules value equality. Numbers compare int-to-float by value, lists and maps
 * compare structurally over own keys, and Timestamp, Duration, Bytes, and Set
 * values own their equality.
 */
export function rulesEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber;
  // A wrapper equals only a value of its own type. With a wrapper on the
  // right alone, no branch below matches and the result is false.
  if (left instanceof RulesValue) return left.equals(right);
  if (left instanceof FirestoreSet) return left.equals(right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => rulesEquals(value, right[index]));
  }
  if (isRulesMap(left) && isRulesMap(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        rulesEquals(left[key], right[key]),
    );
  }
  return false;
}

/** The Rules type name of a value, as production's error messages spell it. */
export function describeRulesType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof RulesValue) return value.typeName;
  if (value instanceof FirestoreSet) return 'set';
  if (value instanceof MapDiff) return 'map_diff';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'list';
  if (isRulesMap(value)) return 'map';
  return typeof value;
}
