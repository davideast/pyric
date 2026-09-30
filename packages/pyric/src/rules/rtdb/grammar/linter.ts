import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleLint } from '../types.js';

interface LintContext {
  warnings: RuleLint[];
  hasData: boolean;
  hasNewData: boolean;
  hasDataChildAccess: boolean;
}

let linterSemantics: Semantics | undefined;

function isLiteralSource(src: string): boolean {
  const trimmed = src.trim();
  const isString = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const isNumber = /^-?\d+(\.\d+)?$/.test(trimmed);
  return isString || isNumber;
}

function checkTautologicalComparison(
  left: any,
  right: any,
  ctx: LintContext,
  warningCode: 'HARDCODED_TRUE' | 'HARDCODED_FALSE',
): void {
  const isTautological = left.sourceString === right.sourceString && isLiteralSource(left.sourceString);
  if (isTautological) {
    const message = warningCode === 'HARDCODED_TRUE'
      ? 'Rule expression is hardcoded to true'
      : 'Rule expression is hardcoded to false';
    ctx.warnings.push({ code: warningCode, message });
  }
  left.lint(ctx);
  right.lint(ctx);
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

    Comparison_looseEq(left, _op, right) {
      checkTautologicalComparison(left, right, this.args.ctx as LintContext, 'HARDCODED_TRUE');
    },

    Comparison_looseNeq(left, _op, right) {
      checkTautologicalComparison(left, right, this.args.ctx as LintContext, 'HARDCODED_FALSE');
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
  }

  if (context === 'write' && ctx.hasData && !ctx.hasNewData && !ctx.hasDataChildAccess) {
    ctx.warnings.push({
      code: 'DATA_IN_WRITE',
      message: "Write rule references 'data' but not 'newData'; consider using 'newData' to check incoming data",
    });
  }

  return ctx.warnings;
}
