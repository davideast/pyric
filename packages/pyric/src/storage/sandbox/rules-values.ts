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

export function rulesEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => rulesEquals(value, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        rulesEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
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
