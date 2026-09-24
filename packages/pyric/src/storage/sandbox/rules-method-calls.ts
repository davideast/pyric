import { NO_OP, RulesValue } from '../../rules/simulator/wrappers/base.js';
import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import { isRuleError as isErr, type RuleError } from './rules-values.js';

export type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Evaluates `<receiver>.<method>(args)` for one method name. The dispatcher
 * evaluates the receiver first and passes its value; an error receiver never
 * reaches a method.
 */
export type ReceiverMethod = (receiver: unknown, expr: MethodCall, ctx: EvalCtx) => unknown;

/** Method name to evaluator, one record per concern file. */
export type ReceiverMethods = Readonly<Record<string, ReceiverMethod>>;

/**
 * Evaluates `<namespace>.<method>(args)` for a builtin namespace such as
 * `timestamp` or `hashing`.
 */
export type NamespaceMethod = (expr: MethodCall, ctx: EvalCtx) => unknown;

/**
 * Production's error for a method its receiver type does not define, such as
 * `resource.size.hours()`. It is an evaluation error, so a determining
 * `&&`/`||` operand absorbs it (rules-storage-stdlib-timestamp-duration
 * captures `resource.size.year() == 1970 || true` allowing).
 */
export function functionNotFound(method: string): RuleEvalError {
  return new RuleEvalError(`Function not found error: Name: [${method}].`);
}

/** Deny a call that passes arguments to a method that takes none. */
export function expectNoArguments(expr: MethodCall): void {
  if (expr.args.length !== 0) {
    throw new RuleEvalError(`${expr.method}() expects no arguments`);
  }
}

/** Evaluate every argument in order; the first error value wins. */
export function evalArguments(expr: MethodCall, ctx: EvalCtx): unknown[] | RuleError {
  const values: unknown[] = [];
  for (const arg of expr.args) {
    const value = evalExpr(arg, ctx);
    if (isErr(value)) return value;
    values.push(value);
  }
  return values;
}

/**
 * A no-argument method a Timestamp, Duration, or Bytes value answers for
 * itself through `callMethod`: the timestamp accessors, `seconds()` and
 * `nanos()` on a duration, and the Bytes encodings. Any other receiver, or a
 * value that does not define the method, is production's function-not-found
 * error.
 */
export function evalValueMethod(receiver: unknown, expr: MethodCall): unknown {
  expectNoArguments(expr);
  if (receiver instanceof RulesValue) {
    const result = receiver.callMethod(expr.method, []);
    if (result !== NO_OP) return result;
  }
  throw functionNotFound(expr.method);
}
