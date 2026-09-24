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
function evalSplit(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const subject = stringReceiver(receiver, expr);
  const pattern = patternArgument(expr, ctx);
  if (typeof pattern !== 'string') return pattern;
  return subject.split(compileRe2Pattern('split', pattern, pattern));
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
  const regex = compileRe2Pattern('replace', pattern, pattern, 'g');
  const groupCount = captureGroupCount(regex);
  return subject.replace(regex, (...match: unknown[]) => {
    const groups = match.slice(0, groupCount + 1) as Array<string | undefined>;
    return expandReplacement(replacement, groups, namedGroupsOf(match[match.length - 1]));
  });
}

/** The named-groups object JavaScript passes last to a replacer, when the pattern has one. */
function namedGroupsOf(lastReplacerArgument: unknown): Readonly<Record<string, string | undefined>> {
  if (typeof lastReplacerArgument === 'object' && lastReplacerArgument !== null) {
    return lastReplacerArgument as Record<string, string | undefined>;
  }
  return {};
}

/** Number of capture groups in `regex`, read from a match of the empty alternative. */
function captureGroupCount(regex: RegExp): number {
  const probe = new RegExp(`${regex.source}|`).exec('');
  return probe === null ? 0 : probe.length - 1;
}

/**
 * Expand a Java `Matcher` replacement template. `groups[0]` is the whole
 * match; a group that did not participate inserts nothing.
 */
function expandReplacement(
  template: string,
  groups: ReadonlyArray<string | undefined>,
  namedGroups: Readonly<Record<string, string | undefined>>,
): string {
  const groupCount = groups.length - 1;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char === '\\') {
      if (i + 1 >= template.length) {
        throw new RuleEvalError('replace() replacement ends with an escape character');
      }
      out += template[i + 1];
      i += 2;
      continue;
    }
    if (char !== '$') {
      out += char;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      if (close === -1) {
        throw new RuleEvalError(`replace() replacement has an unclosed group name: ${template.slice(i)}`);
      }
      const name = template.slice(i + 2, close);
      if (!Object.hasOwn(namedGroups, name)) {
        throw new RuleEvalError(`replace() replacement names no group: ${template.slice(i, close + 1)}`);
      }
      out += namedGroups[name] ?? '';
      i = close + 1;
      continue;
    }
    if (next === undefined || next < '0' || next > '9') {
      throw new RuleEvalError(`replace() replacement has an illegal group reference: ${template.slice(i)}`);
    }
    // Java reads the longest digit run that still names an existing group.
    let group = Number(next);
    let end = i + 2;
    while (end < template.length && template[end] >= '0' && template[end] <= '9') {
      const longer = group * 10 + Number(template[end]);
      if (longer > groupCount) break;
      group = longer;
      end += 1;
    }
    if (group > groupCount) {
      throw new RuleEvalError(`replace() replacement names group ${group}, but the pattern has ${groupCount}`);
    }
    out += groups[group] ?? '';
    i = end;
  }
  return out;
}

/** `string.lower()`, `upper()`, and `trim()`. */
function evalCaseAndTrim(receiver: unknown, expr: MethodCall): unknown {
  const subject = stringReceiver(receiver, expr);
  expectNoArguments(expr);
  if (expr.method === 'lower') return subject.toLowerCase();
  if (expr.method === 'upper') return subject.toUpperCase();
  return subject.trim();
}

/** `string.toUtf8()`: the string's UTF-8 encoding as Bytes. */
function evalToUtf8(receiver: unknown, expr: MethodCall): unknown {
  const subject = stringReceiver(receiver, expr);
  expectNoArguments(expr);
  return Bytes.fromUtf8(subject);
}

/**
 * Compile a rules regular expression with JavaScript's `RegExp`. `pattern`
 * is the caller's RE2 pattern, checked for the constructs JS accepts and RE2
 * rejects (backreferences, lookaround); `source` is what compiles, which is
 * `pattern` itself or an anchored wrapper around it.
 */
function compileRe2Pattern(method: string, pattern: string, source: string, flags?: string): RegExp {
  const backref = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?<?[=!]/.test(pattern);
  if (backref || lookaround) {
    throw new RuleEvalError(
      `${method}() pattern uses an RE2-unsupported construct (${backref ? 'backreference' : 'lookaround'}) that production would reject`,
    );
  }
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new RuleEvalError(`${method}() invalid regex pattern: ${(err as Error).message}`);
  }
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
