import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  describeRulesType as describeType,
  isRuleError as isErr,
  isRulesMap,
  rulesEquals,
} from './rules-values.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Evaluate `.size()` on the three sized types (string → length, list →
 * element count, map → own-key count). Anything else denies with a reason.
 */
export function evalSize(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (expr.args.length !== 0) {
    throw new RuleEvalError(`size() expects no arguments`);
  }
  if (typeof subject === 'string' || Array.isArray(subject)) return subject.length;
  if (isRulesMap(subject)) return Object.keys(subject).length;
  throw new RuleEvalError(`size() requires a string, list, or map target, got ${describeType(subject)}`);
}

/** `Map.keys()` returns the map's own keys and never exposes JS prototypes. */
export function evalMapKeys(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (expr.args.length !== 0) {
    throw new RuleEvalError(`keys() expects no arguments`);
  }
  if (!isRulesMap(subject)) {
    throw new RuleEvalError(`keys() requires a map target, got ${describeType(subject)}`);
  }
  return Object.keys(subject);
}

/** `List/Set.hasAll(other)` with Rules structural value equality. */
export function evalHasAll(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (!Array.isArray(subject)) {
    throw new RuleEvalError(`hasAll() requires a list or set target, got ${describeType(subject)}`);
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`hasAll() expects one list or set argument`);
  }
  const required = evalExpr(expr.args[0], ctx);
  if (isErr(required)) return required;
  if (!Array.isArray(required)) {
    throw new RuleEvalError(`hasAll() argument must be a list or set`);
  }
  return required.every((candidate) => subject.some((value) => rulesEquals(value, candidate)));
}

/** `Map.get(key, default)` for the production-probed string-key form. */
export function evalMapGet(expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (!isRulesMap(subject)) {
    throw new RuleEvalError(`get() requires a map target, got ${describeType(subject)}`);
  }
  if (expr.args.length !== 2) {
    throw new RuleEvalError(`get() expects a key and default value`);
  }
  const key = evalExpr(expr.args[0], ctx);
  if (isErr(key)) return key;
  if (typeof key !== 'string') {
    throw new RuleEvalError(`get() key must be a string`);
  }
  const fallback = evalExpr(expr.args[1], ctx);
  if (isErr(fallback)) return fallback;
  return Object.prototype.hasOwnProperty.call(subject, key)
    ? subject[key]
    : fallback;
}
