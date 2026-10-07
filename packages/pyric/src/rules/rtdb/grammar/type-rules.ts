/**
 * The argument and operand rules production's RTDB rules compiler enforces,
 * with the text it refuses a ruleset with (observation
 * rtdb-rules-deploy-refusals). The validator reports them for a rule whose
 * types it can see before deploy; the evaluator raises them as
 * `RtdbRuleRuntimeError` for a value whose type is known only when the rule
 * runs (corpus scenario r27-method-argument-types).
 */

/** A method that takes exactly one string argument. */
export const ONE_STRING_ARGUMENT_METHODS = new Set(['contains', 'beginsWith', 'endsWith', 'child', 'hasChild']);

export function argumentCountMessage(method: string, count: number): string {
  return `${method}() expects ${count} argument${count === 1 ? '' : 's'}.`;
}

export function stringArgumentMessage(method: string): string {
  return `${method}() expects a string argument.`;
}

export function replaceArgumentMessage(position: 1 | 2): string {
  return `Argument ${position} of replace() must be a string.`;
}

export const HAS_CHILDREN_ARGUMENT_COUNT = 'hasChildren() expects only a single argument (containing an array of child names).';
export const HAS_CHILDREN_ARRAY = 'hasChildren() expects an array of child names.';
export const HAS_CHILDREN_STRINGS = 'hasChildren() expects an array of strings.';

/** The operators whose operands production types, written as rules source. */
export type TypedOperator = '==' | '===' | '!=' | '!==' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

/**
 * The refusal for an operand of `operator` that is not a value, such as a
 * snapshot. Production names `===` as `==` and `!==` as `!=`.
 */
export function operandMessage(operator: TypedOperator, side: 'left' | 'right'): string {
  switch (operator) {
    case '==':
    case '===':
      return side === 'left'
        ? 'Invalid == expression: left operand is not a number, boolean, string, null.'
        : 'Invalid == expression: right operand is not a number, boolean, string, or null.';
    case '!=':
    case '!==':
      return `Invalid != expression: ${side} operand is not a number, boolean, string, or null.`;
    case '+':
      return `Invalid + expression: ${side} operand is not a number or string.`;
    case '-':
    case '*':
    case '/':
    case '%':
      return `Invalid ${operator} expression: ${side} operand is not a number.`;
    default:
      return `Invalid ${operator} expression: ${side} operand must be a number or string.`;
  }
}

export function unknownVariableMessage(name: string): string {
  return `Unknown variable '${name}'.`;
}
