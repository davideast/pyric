import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleLint } from '../types.js';

let _warnings: RuleLint[] = [];
let _lintContext: 'read' | 'write' | 'validate' = 'read';
let _hasData = false;
let _hasNewData = false;
let _hasDataChildAccess = false;

let linterSemantics: Semantics | undefined;

function getLinterSemantics(): Semantics {
  if (linterSemantics) return linterSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation('lint', {
    _nonterminal(...children) {
      children.forEach(c => (c as any).lint());
    },
    _iter(...children) {
      children.forEach(c => (c as any).lint());
    },
    _terminal() {},

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      (receiver as any).lint();
      args.asIteration().children.forEach((a: any) => (a as any).lint());
      // Detect data.child() pattern — indicates intentional data comparison
      if (methodName.sourceString === 'child' && receiver.sourceString === 'data') {
        _hasDataChildAccess = true;
      }
    },

    ident(_dollar, _start, _rest) {
      const name = this.sourceString;
      if (name === 'data') _hasData = true;
      if (name === 'newData') _hasNewData = true;
    },

    bool_true(_true) {
      _warnings.push({ code: 'HARDCODED_TRUE', message: 'Rule expression is hardcoded to true' });
    },

    bool_false(_false) {
      _warnings.push({ code: 'HARDCODED_FALSE', message: 'Rule expression is hardcoded to false' });
    },

    Comparison_looseEq(left, _op, right) {
      _warnings.push({ code: 'LOOSE_EQUALITY', message: "Use '===' instead of '=='" });
      (left as any).lint();
      (right as any).lint();
    },

    Comparison_looseNeq(left, _op, right) {
      _warnings.push({ code: 'LOOSE_INEQUALITY', message: "Use '!==' instead of '!='" });
      (left as any).lint();
      (right as any).lint();
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

  _warnings = [];
  _lintContext = context;
  _hasData = false;
  _hasNewData = false;
  _hasDataChildAccess = false;

  (getLinterSemantics()(match) as any).lint();

  if (context === 'write' && _hasData && !_hasNewData && !_hasDataChildAccess) {
    _warnings.push({
      code: 'DATA_IN_WRITE',
      message: "Write rule references 'data' but not 'newData'; consider using 'newData' to check incoming data",
    });
  }

  return [..._warnings];
}
