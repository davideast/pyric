import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleLint } from '../types.js';

interface LintContext {
  warnings: RuleLint[];
  context: 'read' | 'write' | 'validate';
  hasData: boolean;
  hasNewData: boolean;
  hasDataChildAccess: boolean;
}

let linterSemantics: Semantics | undefined;

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

    bool_true(_true) {
      const ctx = this.args.ctx as LintContext;
      ctx.warnings.push({ code: 'HARDCODED_TRUE', message: 'Rule expression is hardcoded to true' });
    },

    bool_false(_false) {
      const ctx = this.args.ctx as LintContext;
      ctx.warnings.push({ code: 'HARDCODED_FALSE', message: 'Rule expression is hardcoded to false' });
    },

    Comparison_looseEq(left, _op, right) {
      (left as any).lint(this.args.ctx);
      (right as any).lint(this.args.ctx);
    },

    Comparison_looseNeq(left, _op, right) {
      (left as any).lint(this.args.ctx);
      (right as any).lint(this.args.ctx);
    },
  });
  linterSemantics = semantics;
  return semantics;
}

export function lintExpression(
  raw: string,
  context: 'read' | 'write' | 'validate' = 'read',
): RuleLint[] {
  const match = matchRtdbExpression(raw);
  if (match.failed()) return [];

  const ctx: LintContext = {
    warnings: [],
    context,
    hasData: false,
    hasNewData: false,
    hasDataChildAccess: false,
  };

  (getLinterSemantics()(match) as any).lint(ctx);

  if (context === 'write' && ctx.hasData && !ctx.hasNewData && !ctx.hasDataChildAccess) {
    ctx.warnings.push({
      code: 'DATA_IN_WRITE',
      message: "Write rule references 'data' but not 'newData'; consider using 'newData' to check incoming data",
    });
  }

  return ctx.warnings;
}
