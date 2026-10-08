import type { Semantics } from 'ohm-js';
import {
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

/**
 * The value of a comparison whose operands are both literals, evaluated as
 * the rules engine evaluates it (`==` does not convert types); undefined for
 * any other comparison.
 */
function constantValue(node: any): boolean | undefined {
  const [left, , right] = node.children;
  if (!left.isLiteral() || !right.isLiteral()) return undefined;
  try {
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
  if (value !== undefined) ctx.constantComparisons.push({ source: action.sourceString, value });
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
      // Detect data.child() pattern — indicates intentional data comparison
      if (methodName.sourceString === 'child' && receiver.sourceString === 'data') {
        ctx.hasDataChildAccess = true;
      }
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
  // Whether an expression is a literal, through parentheses.
  semantics.addOperation('isLiteral', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).isLiteral() : false;
    },
    _iter() { return false; },
    _terminal() { return false; },
    Primary_paren(_open, inner, _close) { return (inner as any).isLiteral(); },
    // No capture pins how a regular expression literal compares, so one is never folded.
    literal(node) { return node.ctorName !== 'regex'; },
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

  if (context === 'write' && ctx.hasData && !ctx.hasNewData && !ctx.hasDataChildAccess) {
    ctx.warnings.push({
      code: 'DATA_IN_WRITE',
      message: "Write rule references 'data' but not 'newData'; consider using 'newData' to check incoming data",
    });
  }

  return ctx.warnings;
}
