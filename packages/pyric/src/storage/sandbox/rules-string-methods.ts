import { re2FullMatch, replaceRe2 } from '../../rules/simulator/rules-type.js';
import { splitRe2 } from '../../rules/simulator/string-split.js';
import { trimRulesString } from '../../rules/simulator/string-trim.js';
import { Bytes } from '../../rules/simulator/wrappers/bytes.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  expectNoArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { isRuleError as isErr, type RuleError } from './rules-values.js';

/** The receiver as a string, or production's function-not-found error. */
function stringReceiver(receiver: unknown, expr: MethodCall): string {
  if (typeof receiver !== 'string') throw functionNotFound(expr.method);
  return receiver;
}

/** The single string argument of `matches()` and `split()`. */
function patternArgument(expr: MethodCall, ctx: EvalCtx): string | RuleError {
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`${expr.method}() expects a single pattern argument`);
  }
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [pattern] = args;
  if (typeof pattern !== 'string') {
    throw new RuleEvalError(`${expr.method}() pattern must be a string`);
  }
  return pattern;
}

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
 * also deny. A non-string receiver denies too: production would error, and
 * an error denies.
 */
function evalMatches(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = stringReceiver(receiver, expr);
  const pattern = patternArgument(expr, ctx);
  if (typeof pattern !== 'string') return pattern;
  return asEvaluationError(() => re2FullMatch(pattern, subject));
}

/**
 * Evaluate `string.split(re)`: RE2 regex split, the storage-rules idiom for
 * segmenting object names (`fileId.split('-')[0:2]`). It is the shared
 * `splitRe2`, so Storage and Firestore split alike: no capture-group text,
 * trailing empty pieces dropped, and RE2's syntax checks and pyric's size
 * limits on a pattern from request data.
 */
function evalSplit(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = stringReceiver(receiver, expr);
  const pattern = patternArgument(expr, ctx);
  if (typeof pattern !== 'string') return pattern;
  return asEvaluationError(() => splitRe2(subject, pattern));
}

/**
 * `string.replace(pattern, replacement)`: replaces every match of the RE2
 * pattern. The replacement follows Java `Matcher` template rules, which
 * rules-storage-stdlib-string-bytes-hashing captures: `$n` inserts group n,
 * `${name}` a named group, and `\c` the character c. Any other `$` is an
 * illegal group reference and an error; production's Rules Test API answers
 * one with HTTP 500, so the error here denies rather than guessing a value.
 */
function evalReplace(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = stringReceiver(receiver, expr);
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  const [pattern, replacement] = args;
  if (args.length !== 2 || typeof pattern !== 'string' || typeof replacement !== 'string') {
    throw new RuleEvalError(`replace() expects (pattern: string, replacement: string)`);
  }
  return asEvaluationError(() => replaceRe2(subject, pattern, replacement));
}

/** Run a shared string method, turning what it throws into a Storage evaluation error. */
function asEvaluationError<T>(method: () => T): T {
  try {
    return method();
  } catch (err) {
    throw new RuleEvalError((err as Error).message);
  }
}

/** `string.lower()`, `upper()`, and `trim()`. */
function evalCaseAndTrim(receiver: unknown, expr: MethodCall): unknown {
  const subject = stringReceiver(receiver, expr);
  expectNoArguments(expr);
  if (expr.method === 'lower') return subject.toLowerCase();
  if (expr.method === 'upper') return subject.toUpperCase();
  return trimRulesString(subject);
}

/** `string.toUtf8()`: the string's UTF-8 encoding as Bytes. */
function evalToUtf8(receiver: unknown, expr: MethodCall): unknown {
  const subject = stringReceiver(receiver, expr);
  expectNoArguments(expr);
  return Bytes.fromUtf8(subject);
}

export const stringMethods: ReceiverMethods = {
  lower: evalCaseAndTrim,
  matches: evalMatches,
  replace: evalReplace,
  split: evalSplit,
  toUtf8: evalToUtf8,
  trim: evalCaseAndTrim,
  upper: evalCaseAndTrim,
};
