import { Duration } from '../../rules/simulator/wrappers/duration.js';
import { Timestamp } from '../../rules/simulator/wrappers/timestamp.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  evalValueMethod,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { isRuleError as isErr } from './rules-values.js';

/** The units `duration.value(magnitude, unit)` accepts, per the rules language. */
const DURATION_UNITS = ['w', 'd', 'h', 'm', 's', 'ms', 'ns'];

/**
 * `timestamp.date(year, month, day)` (UTC midnight, 1-based month) and
 * `timestamp.value(epochMillis)`, both returning a Timestamp that compares
 * with `request.time` and the resource time fields.
 */
export function evalTimestampNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (expr.method === 'value') {
    if (args.length !== 1 || typeof args[0] !== 'number') {
      throw new RuleEvalError(`timestamp.value() expects (epochMillis: number)`);
    }
    return Timestamp.fromMillis(args[0]);
  }
  if (expr.method === 'date') {
    if (args.length !== 3 || !args.every((a) => typeof a === 'number')) {
      throw new RuleEvalError(`timestamp.date() expects (year, month, day) numbers`);
    }
    const [year, month, day] = args as [number, number, number];
    return Timestamp.fromYMD(year, month, day);
  }
  throw new RuleEvalError(`unsupported timestamp.${expr.method}()`);
}

/**
 * `duration.value(magnitude, unit)`, `duration.time(hours, minutes, seconds,
 * nanos)`, and `duration.abs(duration)`, each returning a Duration. A
 * timestamp plus a duration is a timestamp, which is the freshness idiom
 * production accepts:
 *
 *   request.time < resource.timeCreated + duration.value(1, 'h')
 */
export function evalDurationNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (expr.method === 'value') {
    if (args.length !== 2 || typeof args[0] !== 'number' || typeof args[1] !== 'string') {
      throw new RuleEvalError(`duration.value() expects (magnitude: number, unit: string)`);
    }
    const [magnitude, unit] = args as [number, string];
    if (!DURATION_UNITS.includes(unit)) {
      throw new RuleEvalError(
        `duration.value() got unknown unit "${unit}", expected one of ${DURATION_UNITS.join(', ')}`,
      );
    }
    return Duration.fromValue(magnitude, unit);
  }
  if (expr.method === 'time') {
    if (args.length !== 4 || !args.every((a) => typeof a === 'number')) {
      throw new RuleEvalError(`duration.time() expects (hours, minutes, seconds, nanos) numbers`);
    }
    const [hours, minutes, seconds, nanos] = args as [number, number, number, number];
    return Duration.fromTime(hours, minutes, seconds, nanos);
  }
  if (expr.method === 'abs') {
    if (args.length !== 1 || !(args[0] instanceof Duration)) {
      throw new RuleEvalError(`duration.abs() expects a single duration`);
    }
    return Duration.abs(args[0]);
  }
  throw new RuleEvalError(`unsupported duration.${expr.method}()`);
}

/**
 * The Timestamp accessors and the Duration `seconds()`/`nanos()`, answered
 * by the value itself. On a timestamp, `seconds()` and `nanos()` are the
 * seconds of the minute and the nanoseconds of the second; `toMillis()` is
 * the epoch value.
 */
export const timeMethods: ReceiverMethods = {
  date: evalValueMethod,
  day: evalValueMethod,
  dayOfWeek: evalValueMethod,
  dayOfYear: evalValueMethod,
  hours: evalValueMethod,
  minutes: evalValueMethod,
  month: evalValueMethod,
  nanos: evalValueMethod,
  seconds: evalValueMethod,
  time: evalValueMethod,
  toMillis: evalValueMethod,
  year: evalValueMethod,
};
