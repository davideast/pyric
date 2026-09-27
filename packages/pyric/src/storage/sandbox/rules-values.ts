import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { isRulesMap } from '../../rules/simulator/rules-type.js';

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
