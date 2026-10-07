import type { Node, Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleError } from '../types.js';
import {
  HAS_CHILDREN_ARGUMENT_COUNT,
  HAS_CHILDREN_ARRAY,
  HAS_CHILDREN_STRINGS,
  ONE_STRING_ARGUMENT_METHODS,
  argumentCountMessage,
  operandMessage,
  replaceArgumentMessage,
  stringArgumentMessage,
  unknownVariableMessage,
  type TypedOperator,
} from './type-rules.js';

const ALLOWED_IDENTIFIERS: Record<string, Set<string>> = {
  read: new Set(['auth', 'data', 'root', 'now', 'query']),
  write: new Set(['auth', 'data', 'newData', 'root', 'now']),
  validate: new Set(['auth', 'data', 'newData', 'root', 'now']),
};

const DATASNAPSHOT_METHODS = new Set([
  'val', 'exists', 'hasChild', 'hasChildren', 'isString', 'isNumber',
  'isBoolean', 'child', 'parent', 'getPriority',
]);

const STRING_METHODS = new Set([
  'matches', 'contains', 'beginsWith', 'endsWith', 'replace', 'toLowerCase',
  'toUpperCase', 'length',
]);

const ALL_KNOWN_METHODS = new Set([...DATASNAPSHOT_METHODS, ...STRING_METHODS]);

/**
 * The type an expression has before it runs, as far as its text shows it.
 * `any` is a value whose type is known only at evaluation, such as `val()`.
 */
type StaticType = 'snapshot' | 'string' | 'number' | 'boolean' | 'null' | 'regex' | 'array' | 'any';

const SNAPSHOT_IDENTIFIERS = new Set(['data', 'newData', 'root']);

const METHOD_RESULT_TYPES: Record<string, StaticType> = {
  child: 'snapshot',
  parent: 'snapshot',
  exists: 'boolean',
  hasChild: 'boolean',
  hasChildren: 'boolean',
  isString: 'boolean',
  isNumber: 'boolean',
  isBoolean: 'boolean',
  contains: 'boolean',
  beginsWith: 'boolean',
  endsWith: 'boolean',
  matches: 'boolean',
  replace: 'string',
  toLowerCase: 'string',
  toUpperCase: 'string',
};

/** Whether a value of `type` is known before evaluation not to be a string. */
const isKnownNonString = (type: StaticType): boolean => type !== 'string' && type !== 'any';

interface ValidateContext {
  errors: RuleError[];
  context: 'read' | 'write' | 'validate';
  pathVars: Set<string>;
}

let validatorSemantics: Semantics | undefined;

function staticTypeOf(node: Node): StaticType {
  return (node as unknown as { staticType: StaticType }).staticType;
}

function getValidatorSemantics(): Semantics {
  if (validatorSemantics) return validatorSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addAttribute<StaticType>('staticType', {
    _nonterminal(...children) {
      return children.length === 1 ? staticTypeOf(children[0]!) : 'any';
    },
    _iter() { return 'any'; },
    _terminal() { return 'any'; },
    Ternary_ternary(_c, _q, _t, _colon, _e) { return 'any'; },
    Logical_and(_l, _op, _r) { return 'boolean'; },
    Logical_or(_l, _op, _r) { return 'boolean'; },
    Comparison_strictEq(_l, _op, _r) { return 'boolean'; },
    Comparison_strictNeq(_l, _op, _r) { return 'boolean'; },
    Comparison_gte(_l, _op, _r) { return 'boolean'; },
    Comparison_lte(_l, _op, _r) { return 'boolean'; },
    Comparison_gt(_l, _op, _r) { return 'boolean'; },
    Comparison_lt(_l, _op, _r) { return 'boolean'; },
    Comparison_looseEq(_l, _op, _r) { return 'boolean'; },
    Comparison_looseNeq(_l, _op, _r) { return 'boolean'; },
    Additive_add(_l, _op, _r) { return 'any'; },
    Additive_sub(_l, _op, _r) { return 'number'; },
    Multiplicative_mul(_l, _op, _r) { return 'number'; },
    Multiplicative_div(_l, _op, _r) { return 'number'; },
    Multiplicative_mod(_l, _op, _r) { return 'number'; },
    UnaryExpr_not(_op, _e) { return 'boolean'; },
    UnaryExpr_neg(_op, _e) { return 'number'; },
    CallExpr_methodCall(_receiver, _dot, methodName, _open, _args, _close) {
      return METHOD_RESULT_TYPES[methodName.sourceString] ?? 'any';
    },
    CallExpr_memberAccess(receiver, _dot, member) {
      return member.sourceString === 'length' && staticTypeOf(receiver) === 'string' ? 'number' : 'any';
    },
    CallExpr_indexAccess(_receiver, _open, _index, _close) { return 'any'; },
    Primary_paren(_open, expr, _close) { return staticTypeOf(expr); },
    Array(_open, _elems, _close) { return 'array'; },
    number(_node) { return 'number'; },
    string(_node) { return 'string'; },
    regex(_open, _body, _close, _flags) { return 'regex'; },
    bool(_node) { return 'boolean'; },
    null(_lit) { return 'null'; },
    ident(_dollar, _start, _rest) {
      const name = this.sourceString;
      if (name.startsWith('$')) return 'string';
      if (SNAPSHOT_IDENTIFIERS.has(name)) return 'snapshot';
      if (name === 'now') return 'number';
      return 'any';
    },
  });

  /**
   * Validate both operands of a typed operator, then report a snapshot
   * operand. Production names the left one when both are snapshots.
   */
  function typedOperands(ctx: ValidateContext, operator: TypedOperator, left: Node, right: Node): void {
    (left as any).validate(ctx);
    (right as any).validate(ctx);
    const side = staticTypeOf(left) === 'snapshot' ? 'left' : staticTypeOf(right) === 'snapshot' ? 'right' : null;
    if (side !== null) ctx.errors.push({ code: 'INVALID_OPERAND', message: operandMessage(operator, side) });
  }

  semantics.addOperation('validate(ctx)', {
    _nonterminal(...children) {
      children.forEach(c => (c as any).validate(this.args.ctx));
    },
    _iter(...children) {
      children.forEach(c => (c as any).validate(this.args.ctx));
    },
    _terminal() {},

    Comparison_strictEq(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '===', left, right); },
    Comparison_strictNeq(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '!==', left, right); },
    Comparison_gte(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '>=', left, right); },
    Comparison_lte(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '<=', left, right); },
    Comparison_gt(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '>', left, right); },
    Comparison_lt(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '<', left, right); },
    Comparison_looseEq(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '==', left, right); },
    Comparison_looseNeq(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '!=', left, right); },
    Additive_add(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '+', left, right); },
    Additive_sub(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '-', left, right); },
    Multiplicative_mul(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '*', left, right); },
    Multiplicative_div(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '/', left, right); },
    Multiplicative_mod(left, _op, right) { typedOperands(this.args.ctx as ValidateContext, '%', left, right); },

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const ctx = this.args.ctx as ValidateContext;
      (receiver as any).validate(ctx);
      // Validate method name
      const method = methodName.sourceString;
      if (!ALL_KNOWN_METHODS.has(method)) {
        ctx.errors.push({
          code: 'UNKNOWN_METHOD',
          message: `Unknown method '${method}'`,
        });
      }
      // Recurse into args but NOT methodName (it's not an identifier in this context)
      const argNodes = args.asIteration().children as Node[];
      argNodes.forEach((a) => (a as any).validate(ctx));
      const argumentError = (message: string) => ctx.errors.push({ code: 'INVALID_ARGUMENT', message });

      if (ONE_STRING_ARGUMENT_METHODS.has(method)) {
        if (argNodes.length !== 1) argumentError(argumentCountMessage(method, 1));
        else if (isKnownNonString(staticTypeOf(argNodes[0]!))) argumentError(stringArgumentMessage(method));
      } else if (method === 'replace') {
        if (argNodes.length !== 2) argumentError(argumentCountMessage(method, 2));
        else {
          if (isKnownNonString(staticTypeOf(argNodes[0]!))) argumentError(replaceArgumentMessage(1));
          if (isKnownNonString(staticTypeOf(argNodes[1]!))) argumentError(replaceArgumentMessage(2));
        }
      } else if (method === 'hasChildren' && argNodes.length > 0) {
        // Production takes the child names only as an array literal.
        const names = argNodes[0]!;
        if (argNodes.length > 1) argumentError(HAS_CHILDREN_ARGUMENT_COUNT);
        else if (staticTypeOf(names) !== 'array') argumentError(HAS_CHILDREN_ARRAY);
        else if (arrayElements(names).some((element) => isKnownNonString(staticTypeOf(element)))) {
          argumentError(HAS_CHILDREN_STRINGS);
        }
      }
    },

    CallExpr_memberAccess(receiver, _dot, _member) {
      (receiver as any).validate(this.args.ctx);
      // Skip validation of member name - it's a property, not a root identifier
    },

    CallExpr_indexAccess(receiver, _open, index, _close) {
      (receiver as any).validate(this.args.ctx);
      (index as any).validate(this.args.ctx);
    },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as ValidateContext;
      const name = this.sourceString;
      const dollar = _dollar.sourceString;

      // A $variable is one a wildcard key on this rule's path declares.
      if (dollar === '$') {
        if (!ctx.pathVars.has(name.slice(1))) {
          ctx.errors.push({ code: 'UNKNOWN_IDENTIFIER', message: unknownVariableMessage(name) });
        }
        return;
      }

      const allowed = ALLOWED_IDENTIFIERS[ctx.context];
      if (!allowed) return;

      if (!allowed.has(name) && !ctx.pathVars.has(name)) {
        ctx.errors.push({
          code: 'UNKNOWN_IDENTIFIER',
          message: `Identifier '${name}' is not allowed in '${ctx.context}' context`,
        });
      }

      if (name === 'newData' && ctx.context === 'read') {
        ctx.errors.push({
          code: 'NEWDATA_IN_READ',
          message: `'newData' is not available in 'read' context`,
        });
      }
    },
  });
  validatorSemantics = semantics;
  return semantics;
}

/** The element expressions of an array literal, through any parentheses around it. */
function arrayElements(node: Node): Node[] {
  let current = node;
  while (current.ctorName !== 'Array') {
    current = current.ctorName === 'Primary_paren' ? current.child(1) : current.child(0);
  }
  return current.child(1).asIteration().children;
}

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

  (getValidatorSemantics()(match) as any).validate(ctx);
  return ctx.errors;
}
