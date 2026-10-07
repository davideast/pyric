import type { Node, Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleError } from '../types.js';
import {
  BOOLEAN_OPERANDS,
  NUMERIC_OPERANDS,
  ROOT_VARIABLES,
  binaryResult,
  memberOf,
  operandsOf,
  typeError,
  type RtdbStaticType,
  type RtdbTypedValue,
} from './types.js';
import {
  REGEX_FLAGS,
  isSupportedRegexFlags,
  operandMessage,
  unknownVariableMessage,
  type TypedOperator,
} from './type-rules.js';

interface ValidateContext {
  errors: RuleError[];
  context: 'read' | 'write' | 'validate';
  /** Declared path variable names, without the leading `$`. */
  pathVars: Set<string>;
}

const ERROR: RtdbTypedValue = { type: 'Error' };
const typed = (type: RtdbStaticType): RtdbTypedValue => ({ type });

function report(ctx: ValidateContext, error: RuleError): RtdbTypedValue {
  ctx.errors.push(error);
  return ERROR;
}

/**
 * The type of an operand about to be consumed. An array literal is legal only
 * as the argument of `hasChildren()`; consumed anywhere else it is refused.
 */
function use(ctx: ValidateContext, value: RtdbTypedValue): RtdbStaticType {
  if (value.type !== 'Array') return value.type;
  report(ctx, typeError('UNEXPECTED_ARRAY', 'Unexpected array literal.'));
  return 'Error';
}

function typeOf(node: Node, ctx: ValidateContext): RtdbTypedValue {
  return (node as any).typeOf(ctx) as RtdbTypedValue;
}

function binary(this: Node, left: Node, op: Node, right: Node): RtdbTypedValue {
  const ctx = this.args.ctx as ValidateContext;
  const operator = op.sourceString as TypedOperator;
  const leftType = use(ctx, typeOf(left, ctx));
  const rightType = use(ctx, typeOf(right, ctx));
  const accepted = operandsOf(operator);
  if (!accepted.has(leftType)) return report(ctx, typeError('INVALID_OPERAND', operandMessage(operator, 'left')));
  if (!accepted.has(rightType)) return report(ctx, typeError('INVALID_OPERAND', operandMessage(operator, 'right')));
  return typed(binaryResult(operator, leftType, rightType));
}

function logical(this: Node, left: Node, op: Node, right: Node): RtdbTypedValue {
  const ctx = this.args.ctx as ValidateContext;
  const operator = op.sourceString;
  const leftType = use(ctx, typeOf(left, ctx));
  const rightType = use(ctx, typeOf(right, ctx));
  if (!BOOLEAN_OPERANDS.has(leftType)) {
    return report(ctx, typeError('INVALID_OPERAND', `Left operand of ${operator} must be boolean.`));
  }
  if (!BOOLEAN_OPERANDS.has(rightType)) {
    return report(ctx, typeError('INVALID_OPERAND', `Right operand of ${operator} must be boolean.`));
  }
  return typed(leftType === 'Error' || rightType === 'Error' ? 'Error' : 'Boolean');
}

/** Resolve `receiver.name` as a value: a method read without a call is a `SnapshotMethod`. */
function property(ctx: ValidateContext, receiver: RtdbTypedValue, name: string): RtdbTypedValue {
  const member = memberOf(use(ctx, receiver), name);
  if (member.kind === 'error') return member.error ? report(ctx, member.error) : ERROR;
  return typed(member.kind === 'method' ? 'SnapshotMethod' : member.type);
}

/** Unescape the text between a string literal's quotes. */
function stringValue(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

let validatorSemantics: Semantics | undefined;

function getValidatorSemantics(): Semantics {
  if (validatorSemantics) return validatorSemantics;
  const semantics = createRtdbExpressionSemantics();
  // The value of an expression that is only a string literal (parentheses
  // allowed); undefined otherwise. `x['name']` reads the member `name`.
  semantics.addOperation('literalString', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).literalString() : undefined;
    },
    _iter() {
      return undefined;
    },
    _terminal() {
      return undefined;
    },
    Primary_paren(_open, inner, _close) {
      return (inner as any).literalString();
    },
    string(_literal) {
      return stringValue(this.sourceString);
    },
  });
  semantics.addOperation('typeOf(ctx)', {
    _nonterminal(...children) {
      return children.length === 1 ? typeOf(children[0]!, this.args.ctx) : ERROR;
    },
    _iter() {
      return ERROR;
    },
    _terminal() {
      return ERROR;
    },

    Ternary_ternary(condition, _q, consequent, _c, alternate) {
      const ctx = this.args.ctx as ValidateContext;
      const conditionType = use(ctx, typeOf(condition, ctx));
      const consequentType = use(ctx, typeOf(consequent, ctx));
      const alternateType = use(ctx, typeOf(alternate, ctx));
      if (!BOOLEAN_OPERANDS.has(conditionType)) {
        return report(ctx, typeError('INVALID_OPERAND', 'condition of ? must be boolean.'));
      }
      if (consequentType === 'Error' || alternateType === 'Error') return ERROR;
      return typed(consequentType === alternateType ? consequentType : 'Mixed');
    },

    Logical_and: logical,
    Logical_or: logical,

    Comparison_strictEq: binary,
    Comparison_strictNeq: binary,
    Comparison_gte: binary,
    Comparison_lte: binary,
    Comparison_gt: binary,
    Comparison_lt: binary,
    Comparison_looseEq: binary,
    Comparison_looseNeq: binary,
    Additive_add: binary,
    Additive_sub: binary,
    Multiplicative_mul: binary,
    Multiplicative_div: binary,
    Multiplicative_mod: binary,

    UnaryExpr_not(_op, operand) {
      const ctx = this.args.ctx as ValidateContext;
      const type = use(ctx, typeOf(operand, ctx));
      if (!BOOLEAN_OPERANDS.has(type)) return report(ctx, typeError('INVALID_OPERAND', '! only operates on booleans.'));
      return typed(type === 'Error' ? 'Error' : 'Boolean');
    },

    UnaryExpr_neg(_op, operand) {
      const ctx = this.args.ctx as ValidateContext;
      const type = use(ctx, typeOf(operand, ctx));
      if (!NUMERIC_OPERANDS.has(type)) return report(ctx, typeError('INVALID_OPERAND', '- only operates on numbers.'));
      return typed(type === 'Error' ? 'Error' : 'Number');
    },

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const ctx = this.args.ctx as ValidateContext;
      const receiverType = use(ctx, typeOf(receiver, ctx));
      const argValues = args.asIteration().children.map((arg) => typeOf(arg, ctx));
      const name = methodName.sourceString;
      const member = memberOf(receiverType, name);
      if (member.kind === 'error') return member.error ? report(ctx, member.error) : ERROR;
      if (member.kind === 'property') {
        return report(
          ctx,
          typeError('NOT_A_FUNCTION', 'Type error: Function call on target that is not a function.'),
        );
      }
      const checked = argValues.map((value) => (name === 'hasChildren' ? value : typed(use(ctx, value))));
      if (checked.some((value) => value.type === 'Error')) return ERROR;
      const failure = member.method.check(name, checked);
      return failure ? report(ctx, failure) : typed(member.method.returns);
    },

    CallExpr_memberAccess(receiver, _dot, member) {
      const ctx = this.args.ctx as ValidateContext;
      return property(ctx, typeOf(receiver, ctx), member.sourceString);
    },

    CallExpr_indexAccess(receiver, _open, index, _close) {
      const ctx = this.args.ctx as ValidateContext;
      const receiverValue = typeOf(receiver, ctx);
      const name = (index as any).literalString() as string | undefined;
      if (name !== undefined) return property(ctx, receiverValue, name);
      const receiverType = use(ctx, receiverValue);
      const indexType = use(ctx, typeOf(index, ctx));
      if (receiverType === 'Error' || indexType === 'Error') return ERROR;
      if (receiverType === 'Auth') return typed('Auth');
      return report(ctx, typeError('INVALID_PROPERTY_ACCESS', 'Invalid property access.'));
    },

    Primary_paren(_open, inner, _close) {
      return typeOf(inner, this.args.ctx);
    },

    Array(_open, elements, _close) {
      const ctx = this.args.ctx as ValidateContext;
      const types = elements.asIteration().children.map((element) => use(ctx, typeOf(element, ctx)));
      const array: RtdbTypedValue = { type: 'Array', elements: types };
      return array;
    },

    number(_n) {
      return typed('Number');
    },
    string(_s) {
      return typed('String');
    },
    regex(_open, _body, _close, flags) {
      if (!isSupportedRegexFlags(flags.sourceString)) {
        return report(this.args.ctx as ValidateContext, typeError('INVALID_REGEX', REGEX_FLAGS));
      }
      return typed('Regex');
    },
    bool(_b) {
      return typed('Boolean');
    },
    null(_n) {
      return typed('Null');
    },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as ValidateContext;
      const name = this.sourceString;
      if (_dollar.sourceString === '$') {
        if (ctx.pathVars.has(name.slice(1))) return typed('String');
        return report(ctx, typeError('UNKNOWN_IDENTIFIER', unknownVariableMessage(name)));
      }
      if (name === 'newData' && ctx.context === 'read') {
        return report(ctx, typeError('NEWDATA_IN_READ', 'newData is invalid in .read expressions.'));
      }
      const type = ROOT_VARIABLES.get(name);
      if (!type) return report(ctx, typeError('UNKNOWN_IDENTIFIER', unknownVariableMessage(name)));
      return typed(type);
    },
  });
  validatorSemantics = semantics;
  return semantics;
}

/**
 * Type-check one rule expression as production's rules compiler does when a
 * ruleset is deployed. Returns every error, each with production's message;
 * an operand that fails is not reported again by the expressions around it.
 * A rule must evaluate to a boolean. Returns no errors for an expression that
 * does not parse: the parser reports those.
 */
export function validateExpression(
  raw: string,
  context: 'read' | 'write' | 'validate',
  pathVariables: string[] = [],
): RuleError[] {
  const matched = matchRtdbExpression(raw);
  if (!matched.ok) return [];
  const { match } = matched;

  const ctx: ValidateContext = {
    errors: [],
    context,
    pathVars: new Set(pathVariables.map(v => v.startsWith('$') ? v.slice(1) : v)),
  };

  const result = use(ctx, (getValidatorSemantics()(match) as any).typeOf(ctx) as RtdbTypedValue);
  if (!BOOLEAN_OPERANDS.has(result)) {
    report(ctx, typeError('NOT_BOOLEAN', 'Expression must evaluate to a boolean.'));
  }
  return ctx.errors;
}
