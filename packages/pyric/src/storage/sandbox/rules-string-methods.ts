import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import { describeRulesType as describeType, isRuleError as isErr } from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * `string.matches(re)`: regex match anchored to the WHOLE string, mirroring
 * production Storage (which anchors implicitly, so `'abc'.matches('a')` is
 * FALSE).
 *
 * RE2-vs-JS divergence (honest note): production runs RE2, we compile the
 * pattern with JavaScript's `RegExp`. JS RegExp is a superset of RE2:
 * backreferences (`\1`) and lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) work in
 * JS but are UNSUPPORTED in RE2 and would fail in production. To avoid ever
 * false-allowing on a pattern production would reject, those constructs are
 * detected up front and denied. Invalid patterns (that even JS won't compile)
 * also deny. A non-string target (e.g. a missing metadata key → undefined)
 * denies too: production would error, and an error denies.
 */
export function evalMatches(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  // `resource.name.matches(…)` on an object whose `name` is absent: the target
  // is already production's absent-property error. Propagate it (→ deny)
  // rather than recasting it as a matches()-specific failure.
  if (isErr(subject)) return subject;
  if (typeof subject !== 'string') {
    throw new RuleEvalError(`matches() requires a string target, got ${describeType(subject)}`);
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`matches() expects a single pattern argument`);
  }
  const pattern = evalExpr(expr.args[0], ctx);
  if (typeof pattern !== 'string') {
    throw new RuleEvalError(`matches() pattern must be a string`);
  }
  // Anchor to the whole string. `(?:...)` keeps the caller's alternations
  // from binding past the anchors.
  return compileRe2Pattern('matches', pattern, `^(?:${pattern})$`).test(subject);
}

/**
 * Evaluate `string.split(re)`: RE2 regex split, the storage-rules idiom for
 * segmenting object names (`fileId.split('-')[0:2]`). Shares matches()'s
 * RE2-vs-JS guard: constructs RE2 rejects (backreferences, lookaround) deny
 * with a reason rather than silently (mis)compiling under JS semantics.
 */
export function evalSplit(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (typeof subject !== 'string') {
    throw new RuleEvalError(`split() requires a string target, got ${describeType(subject)}`);
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`split() expects a single pattern argument`);
  }
  const pattern = evalExpr(expr.args[0], ctx);
  if (typeof pattern !== 'string') {
    throw new RuleEvalError(`split() pattern must be a string`);
  }
  return subject.split(compileRe2Pattern('split', pattern, pattern));
}

/**
 * Compile a rules regular expression with JavaScript's `RegExp`. `pattern`
 * is the caller's RE2 pattern, checked for the constructs JS accepts and RE2
 * rejects (backreferences, lookaround); `source` is what compiles, which is
 * `pattern` itself or an anchored wrapper around it.
 */
function compileRe2Pattern(method: string, pattern: string, source: string): RegExp {
  const backref = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?<?[=!]/.test(pattern);
  if (backref || lookaround) {
    throw new RuleEvalError(
      `${method}() pattern uses an RE2-unsupported construct (${backref ? 'backreference' : 'lookaround'}) that production would reject`,
    );
  }
  try {
    return new RegExp(source);
  } catch (err) {
    throw new RuleEvalError(`${method}() invalid regex pattern: ${(err as Error).message}`);
  }
}
