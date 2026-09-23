import { NO_OP } from '../../rules/simulator/wrappers/base.js';
import { Bytes } from '../../rules/simulator/wrappers/bytes.js';
import { Duration } from '../../rules/simulator/wrappers/duration.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { Timestamp } from '../../rules/simulator/wrappers/timestamp.js';
import { FirestoreSet } from '../../rules/simulator/firestore-set.js';
import { evaluateHashingMethod } from '../../rules/simulator/hashing-builtins.js';
import { MapDiff } from '../../rules/simulator/mapdiff.js';
import { UnsupportedError } from '../../rules/simulator/unsupported-error.js';
import type { Expr } from './rules.js';
import { evalExpr, type EvalCtx } from './rules-evaluator.js';
import {
  RuleEvalError,
  RuleResourceLimitError,
  RuleUnsupportedError,
} from './rules-evaluation-error.js';
import {
  RuleError,
  describeRulesType as describeType,
  isRuleError as isErr,
  isRulesMap,
  numericValue as numVal,
  rulesEquals,
} from './rules-values.js';

// ═══════════════════════════════════════════════════════════════
// Builtin method / namespace calls
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate a `<target>.<method>(args)` call. Two builtin families are
 * supported; everything else denies (throws `RuleEvalError`), so unknown
 * builtins — including deliberately-out-of-scope `firestore.get`/`exists` —
 * deny with a reason rather than ever a false allow.
 *
 *   - `string.matches(re)` — RE2-style whole-string regex match.
 *   - `timestamp.date(y, m, d)` / `timestamp.value(epochMillis)` —
 *     timestamp constructors, returned as epoch millis to compare against
 *     `request.time`.
 */
export function evalMethodCall(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  // Timestamp namespace: `timestamp.date(...)` / `timestamp.value(...)`.
  // Detected structurally on the bare `timestamp` identifier (not a bound
  // local/param/global) so a user value named `timestamp` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'timestamp' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalTimestampBuiltin(expr, ctx);
  }

  // Duration namespace: `duration.value(n, unit)` / `duration.time(...)` / `duration.abs(...)`.
  // Detected on the bare `duration` identifier so a user value named `duration` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'duration' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalDurationBuiltin(expr, ctx);
  }

  // Hashing namespace: `hashing.md5(...)` / `hashing.sha256(...)` / `hashing.crc32(...)` / `hashing.crc32c(...)`.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'hashing' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    const args = expr.args.map((a) => evalExpr(a, ctx));
    const errArg = args.find(isErr);
    if (errArg) return errArg;
    try {
      return evaluateHashingMethod(expr.method, args);
    } catch (err) {
      if (err instanceof UnsupportedError) {
        throw new RuleUnsupportedError(err.message);
      }
      throw new RuleEvalError((err as Error).message);
    }
  }

  // Firestore namespace: `firestore.get(path)` / `firestore.exists(path)`.
  // Detected on the bare `firestore` identifier (not a bound local/param) so
  // a user value named `firestore` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'firestore' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalFirestoreBuiltin(expr, ctx);
  }

  if (expr.method === 'matches') {
    return evalMatches(expr, ctx);
  }

  if (expr.method === 'split') {
    return evalSplit(expr, ctx);
  }

  if (expr.method === 'size') {
    return evalSize(expr, ctx);
  }

  if (expr.method === 'keys') {
    return evalMapKeys(expr, ctx);
  }

  if (expr.method === 'hasAll') {
    return evalHasAll(expr, ctx);
  }

  if (expr.method === 'get') {
    return evalMapGet(expr, ctx);
  }

  const targetVal = evalExpr(expr.target, ctx);
  if (isErr(targetVal)) return targetVal;
  const argVals = expr.args.map((a) => evalExpr(a, ctx));
  const errArg = argVals.find(isErr);
  if (errArg) return errArg;

  // Shared CEL wrapper dispatch (Bytes, Timestamp, Duration)
  if (
    targetVal instanceof Bytes ||
    targetVal instanceof Timestamp ||
    targetVal instanceof Duration
  ) {
    try {
      const res = targetVal.callMethod(expr.method, argVals);
      if (res !== NO_OP) return res;
    } catch (err) {
      if (err instanceof UnsupportedError) {
        throw new RuleUnsupportedError(err.message);
      }
      throw new RuleEvalError((err as Error).message);
    }
  }

  if (targetVal instanceof MapDiff) {
    if (argVals.length !== 0) {
      throw new RuleEvalError(`${expr.method}() expects no arguments`);
    }
    switch (expr.method) {
      case 'addedKeys':
        return targetVal.addedKeys();
      case 'removedKeys':
        return targetVal.removedKeys();
      case 'changedKeys':
        return targetVal.changedKeys();
      case 'affectedKeys':
        return targetVal.affectedKeys();
      case 'unchangedKeys':
        return targetVal.unchangedKeys();
      default:
        throw new RuleUnsupportedError(`unsupported MapDiff method .${expr.method}()`);
    }
  }

  if (targetVal instanceof FirestoreSet) {
    switch (expr.method) {
      case 'hasOnly':
      case 'hasAll':
      case 'hasAny':
        if (argVals.length !== 1 || (!Array.isArray(argVals[0]) && !(argVals[0] instanceof FirestoreSet))) {
          throw new RuleEvalError(`${expr.method}() expects a list or set argument`);
        }
        return targetVal[expr.method](argVals[0]);
      case 'difference':
      case 'union':
      case 'intersection':
        if (argVals.length !== 1 || !(argVals[0] instanceof FirestoreSet)) {
          throw new RuleEvalError(`${expr.method}() expects a set argument`);
        }
        return targetVal[expr.method](argVals[0]);
      default:
        throw new RuleUnsupportedError(`unsupported Set method .${expr.method}()`);
    }
  }

  if (Array.isArray(targetVal) && expr.method === 'toSet') {
    if (argVals.length !== 0) throw new RuleEvalError(`toSet() expects no arguments`);
    return new FirestoreSet(targetVal);
  }

  // Storage models timestamps (`request.time`, `resource.timeCreated`, `timestamp.date(...)`)
  // and durations (`duration.value(...)`, `duration.time(...)`) as millisecond numbers.
  // Delegate Timestamp / Duration instance methods on numeric targets to the shared CEL wrappers.
  if (typeof targetVal === 'number') {
    if (
      expr.method === 'year' ||
      expr.method === 'month' ||
      expr.method === 'day' ||
      expr.method === 'hours' ||
      expr.method === 'minutes' ||
      expr.method === 'toMillis' ||
      expr.method === 'dayOfWeek' ||
      expr.method === 'dayOfYear'
    ) {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`${expr.method}() expects no arguments`);
      }
      return Timestamp.fromMillis(targetVal).callMethod(expr.method, []);
    }
    if (expr.method === 'date') {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`date() expects no arguments`);
      }
      const ts = Timestamp.fromMillis(targetVal).callMethod('date', []) as Timestamp;
      return ts.toMillis();
    }
    if (expr.method === 'time') {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`time() expects no arguments`);
      }
      const dur = Timestamp.fromMillis(targetVal).callMethod('time', []) as Duration;
      return dur.valueOf();
    }
    if (expr.method === 'seconds') {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`seconds() expects no arguments`);
      }
      return Math.trunc(targetVal / 1000);
    }
    if (expr.method === 'nanos') {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`nanos() expects no arguments`);
      }
      return Math.round((targetVal % 1000) * 1e6);
    }
    if (expr.method === 'abs') {
      if (argVals.length !== 0) {
        throw new RuleEvalError(`abs() expects no arguments`);
      }
      return Math.abs(targetVal);
    }
  }

  // Map.diff(otherMap) -> MapDiff(before=otherMap, after=targetVal)
  if (isRulesMap(targetVal) && expr.method === 'diff') {
    if (argVals.length !== 1 || !isRulesMap(argVals[0])) {
      throw new RuleEvalError(`diff() expects a single map argument`);
    }
    return new MapDiff(argVals[0], targetVal);
  }

  // CEL String methods: lower(), upper(), trim(), replace(old, new), toUtf8()
  if (typeof targetVal === 'string') {
    switch (expr.method) {
      case 'lower':
        if (argVals.length !== 0) throw new RuleEvalError(`lower() expects no arguments`);
        return targetVal.toLowerCase();
      case 'upper':
        if (argVals.length !== 0) throw new RuleEvalError(`upper() expects no arguments`);
        return targetVal.toUpperCase();
      case 'trim':
        if (argVals.length !== 0) throw new RuleEvalError(`trim() expects no arguments`);
        return targetVal.trim();
      case 'toUtf8':
        if (argVals.length !== 0) throw new RuleEvalError(`toUtf8() expects no arguments`);
        return Bytes.fromUtf8(targetVal);
      case 'replace': {
        if (argVals.length !== 2 || typeof argVals[0] !== 'string' || typeof argVals[1] !== 'string') {
          throw new RuleEvalError(`replace() expects (old: string, new: string)`);
        }
        const re = compileRe2Pattern(argVals[0], 'replace', { flags: 'g' });
        return targetVal.replace(re, argVals[1]);
      }
    }
  }

  // An unknown method name is either unmodeled here or rejected by
  // production's compiler. Its verdict is unknowable locally, so it is
  // unabsorbable (fails closed even under a determining &&/|| operand).
  throw new RuleUnsupportedError(`unsupported method .${expr.method}()`);
}

/**
 * Evaluate `firestore.get(path)` / `firestore.exists(path)`.
 *
 * Requires an injected {@link FirestoreLookup} (the enforcement layer
 * supplies one from the sandbox's Firestore data). With NO capability —
 * pure/test usage without a sandbox — this denies with an "unsupported"
 * reason rather than ever a false allow, preserving the pre-lookup posture.
 *
 * Semantics (production-honest, deny-on-error):
 *   - `firestore.get(path)` → a resource `{ data: <fields> }`. Member access
 *     `.data.<field>` then reads the doc's fields. On a NONEXISTENT doc,
 *     production `get()` is itself an error, so this denies with a reason.
 *   - `firestore.exists(path)` → boolean.
 *   - Malformed path (missing `/databases/<db>/documents/` prefix, odd
 *     segment count), a non-string interpolation, wrong arg count, or a
 *     non-path argument → deny with a reason.
 */
function evalFirestoreBuiltin(
  expr: Extract<Expr, { kind: 'methodcall' }>,
  ctx: EvalCtx,
): unknown {
  if (expr.method !== 'get' && expr.method !== 'exists') {
    // Unknown namespace method, compile-reject class, never absorbed.
    throw new RuleUnsupportedError(`unsupported method firestore.${expr.method}()`);
  }
  if (!ctx.firestoreLookup) {
    // No sandbox-backed capability injected — keep the deny-with-reason
    // "unsupported" behavior; never a false allow.
    throw new RuleEvalError(
      `firestore.${expr.method}() is unsupported here — no Firestore lookup capability is configured`,
    );
  }
  if (expr.args.length !== 1) {
    // Wrong call shape: production rejects at compile; never absorbed.
    throw new RuleUnsupportedError(`firestore.${expr.method}() expects a single path argument`);
  }
  const arg = expr.args[0];
  if (arg.kind !== 'path') {
    throw new RuleUnsupportedError(`firestore.${expr.method}() requires a /databases/.../documents/... path literal`);
  }
  const docPath = buildFirestoreDocPath(arg, ctx);
  if (!ctx.firestoreAccesses.has(docPath)) {
    if (ctx.firestoreAccesses.size >= 2) {
      // Resource-limit class, the same posture as the Firestore lookup
      // budget: production fails the whole evaluation closed, so a
      // determining &&/|| operand must NOT absorb this into an allow.
      throw new RuleResourceLimitError('firestore access limit exceeded: at most two distinct documents');
    }
    ctx.firestoreAccesses.add(docPath);
  }
  if (expr.method === 'exists') {
    return ctx.firestoreLookup.exists(docPath);
  }
  const fields = ctx.firestoreLookup.get(docPath);
  if (fields === null) {
    // A missing get is a Rules error VALUE: it denies at the allow boundary,
    // but participates in COMMUTATIVE CEL error absorption in `&&`/`||`
    // (`error || true` allows, and `error && false` evaluates to false,
    // see the tri-state operand handling in rules-evaluator.ts).
    return new RuleError(`firestore.get() targeted a nonexistent document: ${docPath}`);
  }
  return { data: fields };
}

/**
 * Assemble a {@link PathArgSegment} list into the document path the
 * {@link FirestoreLookup} expects, then validate + strip the required
 * `/databases/<db>/documents/` prefix. Interpolations must resolve to a
 * string or number; anything else (e.g. `request.auth.uid` when auth is
 * null → undefined) throws → deny.
 */
function buildFirestoreDocPath(
  pathExpr: Extract<Expr, { kind: 'path' }>,
  ctx: EvalCtx,
): string {
  const parts = pathExpr.segments.map((seg) => {
    if (seg.kind === 'literal') return seg.value;
    const v = evalExpr(seg.expr, ctx);
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    throw new RuleEvalError(
      `Firestore path interpolation resolved to ${describeType(v)} (expected a string)`,
    );
  });
  // Required production shape: databases / <db> / documents / <doc path…>.
  if (parts.length < 4 || parts[0] !== 'databases' || parts[2] !== 'documents') {
    throw new RuleEvalError(
      `malformed Firestore path — expected /databases/<db>/documents/... , got /${parts.join('/')}`,
    );
  }
  if (parts[1] !== '(default)') {
    throw new RuleEvalError(
      `Storage rules may access only the default Firestore database, got ${parts[1]}`,
    );
  }
  const docSegments = parts.slice(3);
  // A document path is collection/doc pairs — an even, non-zero segment count.
  if (docSegments.length === 0 || docSegments.length % 2 !== 0) {
    throw new RuleEvalError(
      `Firestore path does not point at a document (needs an even segment count): ${docSegments.join('/')}`,
    );
  }
  return docSegments.join('/');
}

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
 * `duration.value(magnitude, unit)` — a duration, returned as milliseconds so
 * it adds to / subtracts from the millis-modeled timestamps
 * (`request.time`, `resource.timeCreated`). This is what makes the freshness
 * idiom production accepts work here too:
 *
 *   request.time < resource.timeCreated + duration.value(1, 'h')
 */
function evalDurationBuiltin(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): number {
  const args = expr.args.map((a) => evalExpr(a, ctx));
  if (expr.method === 'time') {
    if (args.length !== 4 || !args.every((a) => typeof a === 'number')) {
      throw new RuleEvalError(`duration.time() expects (hours, mins, secs, nanos) numbers`);
    }
    const [h, m, s, ns] = args as [number, number, number, number];
    return Duration.fromTime(h, m, s, ns).valueOf();
  }
  if (expr.method === 'abs') {
    if (args.length !== 1 || typeof args[0] !== 'number') {
      throw new RuleEvalError(`duration.abs() expects a single duration argument`);
    }
    return Math.abs(args[0]);
  }
  if (expr.method !== 'value') {
    throw new RuleEvalError(`unsupported duration.${expr.method}()`);
  }
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
function evalTimestampBuiltin(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): number {
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

/**
 * `string.matches(re)` — regex match anchored to the WHOLE string, mirroring
 * production Storage (which anchors implicitly, so `'abc'.matches('a')` is
 * FALSE).
 *
 * RE2-vs-JS divergence (honest note): production runs RE2, we compile the
 * pattern with JavaScript's `RegExp`. JS RegExp is a superset of RE2 —
 * backreferences (`\1`) and lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) work in
 * JS but are UNSUPPORTED in RE2 and would fail in production. To avoid ever
 * false-allowing on a pattern production would reject, those constructs are
 * detected up front and denied. Invalid patterns (that even JS won't compile)
 * also deny. A non-string target (e.g. a missing metadata key → undefined)
 * denies too — production would error, and an error denies.
 */
function compileRe2Pattern(
  pattern: string,
  methodName: string,
  opts?: { anchored?: boolean; flags?: string },
): RegExp {
  const backref = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?<?[=!]/.test(pattern);
  if (backref || lookaround) {
    throw new RuleEvalError(
      `${methodName}() pattern uses an RE2-unsupported construct (${backref ? 'backreference' : 'lookaround'}) that production would reject`,
    );
  }
  try {
    const source = opts?.anchored ? `^(?:${pattern})$` : pattern;
    return new RegExp(source, opts?.flags);
  } catch (err) {
    throw new RuleEvalError(`${methodName}() invalid regex pattern: ${(err as Error).message}`);
  }
}

function evalMatches(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
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
  const re = compileRe2Pattern(pattern, 'matches', { anchored: true });
  return re.test(subject);
}

/**
 * Evaluate `string.split(re)` — RE2 regex split, the storage-rules idiom for
 * segmenting object names (`fileId.split('-')[0:2]`). Shares matches()'s
 * RE2-vs-JS guard: constructs RE2 rejects (backreferences, lookaround) deny
 * with a reason rather than silently (mis)compiling under JS semantics.
 */
function evalSplit(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
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
  const re = compileRe2Pattern(pattern, 'split');
  return subject.split(re);
}

/**
 * Evaluate `.size()` on sized types (string → length, list → element count,
 * map → own-key count, Bytes/Set → element count). Anything else denies with a reason.
 */
function evalSize(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (expr.args.length !== 0) {
    throw new RuleEvalError(`size() expects no arguments`);
  }
  if (subject instanceof Bytes || subject instanceof FirestoreSet) return subject.size();
  if (typeof subject === 'string' || Array.isArray(subject)) return subject.length;
  if (isRulesMap(subject)) return Object.keys(subject).length;
  throw new RuleEvalError(`size() requires a string, list, or map target, got ${describeType(subject)}`);
}

/** `Map.keys()` returns the map's own keys and never exposes JS prototypes. */
function evalMapKeys(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
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
function evalHasAll(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  const subject = evalExpr(expr.target, ctx);
  if (isErr(subject)) return subject;
  if (subject instanceof FirestoreSet) {
    if (expr.args.length !== 1) {
      throw new RuleEvalError(`hasAll() expects one list or set argument`);
    }
    const required = evalExpr(expr.args[0], ctx);
    if (isErr(required)) return required;
    if (!Array.isArray(required) && !(required instanceof FirestoreSet)) {
      throw new RuleEvalError(`hasAll() argument must be a list or set`);
    }
    return subject.hasAll(required);
  }
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
function evalMapGet(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
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
