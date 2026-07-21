import { RulesFloat } from '../../rules/simulator/wrappers/float.js';

/** Error value that propagates through an expression and denies at the allow boundary. */
export class RuleError {
  constructor(readonly message: string) {}
}

export function isRuleError(value: unknown): value is RuleError {
  return value instanceof RuleError;
}

export class RuleEvalError extends Error {}

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

export function rulesEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber;
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

export function describeRulesType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof RulesFloat) return 'float';
  return typeof value;
}
