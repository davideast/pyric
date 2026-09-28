import { MathFailure, applyMath } from '../../rules/simulator/math-builtins.js';
import type { EvalCtx } from './rules-evaluator.js';
import { evalNamespaceArguments, type MethodCall } from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

/**
 * `math.abs()`, `ceil()`, `floor()`, `round()`, `sqrt()`, `pow()`, and
 * `isNaN()`, shared with the Firestore simulator (see
 * rules/simulator/math-builtins.ts). A failure, including a name the
 * namespace does not define such as `math.isInfinite()`, is an error value
 * that `&&` and `||` absorb, as production's are (corpus scenario
 * `math-namespace`).
 */
export function evalMathNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalNamespaceArguments(expr, ctx);
  if (isErr(args)) return args;
  const result = applyMath(expr.method, args);
  return result instanceof MathFailure ? new RuleError(result.message) : result;
}
