import type { Semantics } from 'ohm-js';
import {
  CHAINED_TERMS_MESSAGE,
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleLint } from '../types.js';
import { RtdbRuleRuntimeError, evaluateRtdbExpression, type EvalContext } from './simulator.js';

interface LintContext {
  warnings: RuleLint[];
  hasData: boolean;
  hasNewData: boolean;
  hasDataChildAccess: boolean;
  /** Each comparison whose operands are both literals, with the value it always has. */
  constantComparisons: Array<{ source: string; value: boolean }>;
}

let linterSemantics: Semantics | undefined;

const PATH_VARIABLE_RE = /^\$[A-Za-z_]\w*$/;
const RULE_EXPRESSION_ROOT_RE = /^(?:auth|data|newData|root|query)(?:\.|\[)/;

export function looksLikeRuleReference(value: string): boolean {
  return (
    value === 'now' ||
    PATH_VARIABLE_RE.test(value) ||
    RULE_EXPRESSION_ROOT_RE.test(value)
  );
}

function unquotedStringLiteral(node: any): string | undefined {
  if (!node.isLiteral()) return undefined;
  try {
    const evaluated = evaluateRtdbExpression(node.sourceString, {} as EvalContext);
    if (typeof evaluated === 'string') return evaluated;
    return undefined;
  } catch (error) {
    if (error instanceof RtdbRuleRuntimeError) return undefined;
    throw error;
  }
}

/**
 * The value of a comparison whose operands are both literals, evaluated as
 * the rules engine evaluates it (`==` does not convert types); undefined for
 * any other comparison.
 */
function constantValue(node: any): boolean | undefined {
  const [left, , right] = node.children;
  if (!left.isLiteral() || !right.isLiteral()) return undefined;
  try {
    const l = evaluateRtdbExpression(left.sourceString, {} as EvalContext);
    const r = evaluateRtdbExpression(right.sourceString, {} as EvalContext);
    if ((typeof l === 'number' && !Number.isFinite(l)) || (typeof r === 'number' && !Number.isFinite(r))) {
      return undefined;
    }
    return evaluateRtdbExpression(node.sourceString, {} as EvalContext) === true;
  } catch (error) {
    // A comparison that fails the rule when it runs, such as `null > 1`, has no constant value.
    if (error instanceof RtdbRuleRuntimeError) return undefined;
    throw error;
  }
}

function lintComparison(action: any, left: any, right: any): void {
  const ctx = action.args.ctx as LintContext;
  left.lint(ctx);
  right.lint(ctx);
  const value = constantValue(action);
  if (value !== undefined) {
    ctx.constantComparisons.push({ source: action.sourceString, value });
    return;
  }
  const leftIsLiteral = left.isLiteral() as boolean;
  const rightIsLiteral = right.isLiteral() as boolean;
  if (leftIsLiteral === rightIsLiteral) return;
  let literalNode = right;
  if (leftIsLiteral) {
    literalNode = left;
  }
  const unquoted = unquotedStringLiteral(literalNode);
  if (unquoted !== undefined && looksLikeRuleReference(unquoted)) {
    ctx.warnings.push({
      code: 'QUOTED_REFERENCE',
      message: `Comparison ${action.sourceString} quotes '${unquoted}' as a string literal; it compares against the literal text '${unquoted}' rather than evaluating ${unquoted}.`,
    });
  }
}

function getLinterSemantics(): Semantics {
  if (linterSemantics) return linterSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation('lint(ctx)', {
    _nonterminal(...children) {
      children.forEach(c => (c as any).lint(this.args.ctx));
    },
    _iter(...children) {
      children.forEach(c => (c as any).lint(this.args.ctx));
    },
    _terminal() {},

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const ctx = this.args.ctx as LintContext;
      (receiver as any).lint(ctx);
      args.asIteration().children.forEach((a: any) => (a as any).lint(ctx));
      // Detect data.child() / data.parent()...child() / (data).child() pattern
      if (methodName.sourceString === 'child' && (receiver as any).isDataSnapshot()) {
        ctx.hasDataChildAccess = true;
      }
    },

    CallExpr_memberAccess(receiver, _dot, _memberName) {
      // Skip _memberName — it is a property name, not a root identifier.
      (receiver as any).lint(this.args.ctx);
    },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as LintContext;
      const name = this.sourceString;
      if (name === 'data') ctx.hasData = true;
      if (name === 'newData') ctx.hasNewData = true;
    },

    Equality_strictEq(left, _op, right) { lintComparison(this, left, right); },
    Equality_strictNeq(left, _op, right) { lintComparison(this, left, right); },
    Comparison_gte(left, _op, right) { lintComparison(this, left, right); },
    Comparison_lte(left, _op, right) { lintComparison(this, left, right); },
    Comparison_gt(left, _op, right) { lintComparison(this, left, right); },
    Comparison_lt(left, _op, right) { lintComparison(this, left, right); },
    Equality_looseEq(left, _op, right) { lintComparison(this, left, right); },
    Equality_looseNeq(left, _op, right) { lintComparison(this, left, right); },
  });
  // Whether a receiver expression resolves a snapshot rooted at `data` (through
  // parentheses, `.parent()`, and `.child()`).
  semantics.addOperation('isDataSnapshot', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).isDataSnapshot() : false;
    },
    _iter() { return false; },
    _terminal() { return false; },
    Primary_paren(_open, inner, _close) {
      return (inner as any).isDataSnapshot();
    },
    ident(_dollar, _start, _rest) {
      return this.sourceString === 'data';
    },
    CallExpr_methodCall(receiver, _dot, methodName, _open, _args, _close) {
      const method = methodName.sourceString;
      if (method === 'parent' || method === 'child') {
        return (receiver as any).isDataSnapshot();
      }
      return false;
    },
  });
  // Whether an expression is a finite numeric literal (through parentheses, unary `-`, and arithmetic).
  semantics.addOperation('isNumberLiteral', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).isNumberLiteral() : false;
    },
    _iter() { return false; },
    _terminal() { return false; },
    Primary_paren(_open, inner, _close) { return (inner as any).isNumberLiteral(); },
    UnaryExpr_neg(_minus, operand) { return (operand as any).isNumberLiteral(); },
    Additive_add(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Additive_sub(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_mul(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_div(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_mod(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    number(_n) { return Number.isFinite(Number(this.sourceString)); },
  });
  // Whether an expression is a literal, through parentheses.
  semantics.addOperation('isLiteral', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).isLiteral() : false;
    },
    _iter() { return false; },
    _terminal() { return false; },
    Primary_paren(_open, inner, _close) { return (inner as any).isLiteral(); },
    UnaryExpr_neg(_minus, operand) { return (operand as any).isNumberLiteral(); },
    Additive_add(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Additive_sub(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_mul(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_div(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    Multiplicative_mod(left, _op, right) { return (left as any).isNumberLiteral() && (right as any).isNumberLiteral(); },
    // No capture pins how a regular expression literal compares, so one is never folded.
    literal(node) {
      if (node.ctorName === 'regex') return false;
      if (node.ctorName === 'number') return Number.isFinite(Number(node.sourceString));
      return true;
    },
  });
  // The boolean an expression is, when the whole expression is a `true` or
  // `false` literal (parentheses allowed); undefined otherwise. A literal that
  // is only an operand, such as `data.child('open').val() == false`, is not
  // the whole expression.
  semantics.addOperation('literalBoolean', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).literalBoolean() : undefined;
    },
    _iter() {
      return undefined;
    },
    _terminal() {
      return undefined;
    },
    Primary_paren(_open, inner, _close) {
      return (inner as any).literalBoolean();
    },
    bool_true(_true) {
      return true;
    },
    bool_false(_false) {
      return false;
    },
    Equality_strictEq(_l, _op, _r) { return constantValue(this); },
    Equality_strictNeq(_l, _op, _r) { return constantValue(this); },
    Comparison_gte(_l, _op, _r) { return constantValue(this); },
    Comparison_lte(_l, _op, _r) { return constantValue(this); },
    Comparison_gt(_l, _op, _r) { return constantValue(this); },
    Comparison_lt(_l, _op, _r) { return constantValue(this); },
    Equality_looseEq(_l, _op, _r) { return constantValue(this); },
    Equality_looseNeq(_l, _op, _r) { return constantValue(this); },
  });
  linterSemantics = semantics;
  return semantics;
}

export function lintExpression(
  raw: string,
  context: 'read' | 'write' | 'validate' = 'read',
): RuleLint[] {
  const matched = matchRtdbExpression(raw);
  if (!matched.ok) return [];
  const { match } = matched;

  const ctx: LintContext = {
    warnings: [],
    hasData: false,
    hasNewData: false,
    hasDataChildAccess: false,
    constantComparisons: [],
  };

  try {
    const node = getLinterSemantics()(match) as any;
    node.lint(ctx);

    // A `.read` or `.write` that is a literal grants or denies every request at
    // its path. A `.validate` literal is not reported: `true` checks nothing and
    // `false` is how a ruleset rejects children it does not name (`$other`).
    const literal = context === 'validate' ? undefined : node.literalBoolean() as boolean | undefined;
    if (literal === true) {
      ctx.warnings.push({ code: 'HARDCODED_TRUE', message: 'Rule expression is hardcoded to true' });
    } else if (literal === false) {
      ctx.warnings.push({ code: 'HARDCODED_FALSE', message: 'Rule expression is hardcoded to false' });
    } else {
      // A comparison between two literals has one value whatever the request.
      for (const { source, value } of ctx.constantComparisons) {
        ctx.warnings.push({ code: 'CONSTANT_COMPARISON', message: `Comparison ${source} is always ${value}.` });
      }
    }
  } catch (error) {
    if (error instanceof RangeError) {
      return [{ code: 'PARSE_ERROR', message: CHAINED_TERMS_MESSAGE }];
    }
    if (error instanceof SyntaxError) {
      return [{ code: 'PARSE_ERROR', message: error.message }];
    }
    throw error;
  }

  if (context === 'write' && ctx.hasData && !ctx.hasNewData && !ctx.hasDataChildAccess) {
    ctx.warnings.push({
      code: 'DATA_IN_WRITE',
      message: "Write rule references 'data' but not 'newData'; consider using 'newData' to check incoming data",
    });
  }

  return ctx.warnings;
}
