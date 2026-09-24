import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';

type MethodCall = Extract<Expr, { kind: 'methodcall' }>;

/**
 * Milliseconds in each unit `duration.value(n, unit)` accepts.
 * Production's units, per the rules language: weeks, days, hours, minutes,
 * seconds, milliseconds, nanoseconds.
 */
const DURATION_UNIT_MILLIS: Record<string, number> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
  ms: 1,
  ns: 1e-6,
};

/**
 * `duration.value(magnitude, unit)`: a duration, returned as milliseconds so
 * it adds to / subtracts from the millis-modeled timestamps
 * (`request.time`, `resource.timeCreated`). This is what makes the freshness
 * idiom production accepts work here too:
 *
 *   request.time < resource.timeCreated + duration.value(1, 'h')
 */
export function evalDurationBuiltin(expr: MethodCall, ctx: EvalCtx): number {
  if (expr.method !== 'value') {
    throw new RuleEvalError(`unsupported duration.${expr.method}()`);
  }
  const args = expr.args.map((a) => evalExpr(a, ctx));
  if (args.length !== 2 || typeof args[0] !== 'number' || typeof args[1] !== 'string') {
    throw new RuleEvalError(`duration.value() expects (magnitude: number, unit: string)`);
  }
  const [magnitude, unit] = args as [number, string];
  const millis = DURATION_UNIT_MILLIS[unit];
  if (millis === undefined) {
    throw new RuleEvalError(
      `duration.value() got unknown unit "${unit}" — expected one of ${Object.keys(DURATION_UNIT_MILLIS).join(', ')}`,
    );
  }
  return magnitude * millis;
}

/** `timestamp.date(year, month, day)` (UTC midnight) and
 *  `timestamp.value(epochMillis)`, both returning epoch milliseconds. */
export function evalTimestampBuiltin(expr: MethodCall, ctx: EvalCtx): number {
  const args = expr.args.map((a) => evalExpr(a, ctx));
  if (expr.method === 'value') {
    if (args.length !== 1 || typeof args[0] !== 'number') {
      throw new RuleEvalError(`timestamp.value() expects (epochMillis: number)`);
    }
    return args[0];
  }
  if (expr.method === 'date') {
    if (args.length !== 3 || !args.every((a) => typeof a === 'number')) {
      throw new RuleEvalError(`timestamp.date() expects (year, month, day) numbers`);
    }
    const [y, m, d] = args as [number, number, number];
    // Production `timestamp.date(y, m, d)` is UTC midnight; month is 1-based.
    return Date.UTC(y, m - 1, d);
  }
  throw new RuleEvalError(`unsupported timestamp.${expr.method}()`);
}
