import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import {
  expandVerb,
  type EvaluationInput,
  type EvaluationResult,
  type Expr,
  type FirestoreLookup,
  type FunctionMap,
  type MatchBlock,
  type StorageResource,
  type StorageRules,
} from './rules.js';
import { evalMethodCall } from './rules-methods.js';
import { formatPath, matchSegments, splitPath } from './rules-path-match.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  RuleError,
  describeRulesType as describeType,
  isRuleError as isErr,
  isRulesMap,
  numericValue as numVal,
  rulesEquals,
} from './rules-values.js';

export function evaluateStorageRules(
  rules: StorageRules,
  input: EvaluationInput,
  now: Date = new Date(),
  firestoreLookup?: FirestoreLookup,
): EvaluationResult {
  // `request.time` is the request's evaluation moment, modeled internally
  // as epoch milliseconds so it compares numerically against the
  // `timestamp.date(...)` / `timestamp.value(...)` constructors. The caller
  // injects it (deterministic in tests); it defaults to now.
  const nowMillis = now.getTime();
  const pathSegments = splitPath(input.request.path);
  const reasons: string[] = [];
  const firestoreAccesses = new Set<string>();

  // The operation's verb, reduced to its granular set. A coarse
  // request method expands to its sub-verbs so umbrella semantics are
  // symmetric; a precise granular verb expands to itself.
  const requestVerbs = new Set(expandVerb(input.request.method));

  /**
   * Walk a match block. `remaining` is the still-unmatched part of
   * the request path; `params` are the bindings accumulated so far.
   * Recurses into matching children. Whenever a block fully
   * consumes the path, its `allow` rules run.
   */
  function visit(
    block: MatchBlock,
    remaining: string[],
    params: Record<string, string | string[]>,
  ): boolean {
    // Match this block's segments against the start of `remaining`.
    const match = matchSegments(block.segments, remaining, params);
    if (!match) return false;
    const newParams = match.params;
    const left = match.left;

    // If this block fully consumes the path, evaluate its allow
    // rules. (Or if a wildcard absorbed the remainder.)
    if (left.length === 0) {
      for (const rule of block.allows) {
        // A grant applies when the operation's verb falls within the
        // grant's verbs after coarse→granular expansion. `allow read`
        // covers get + list; `allow get` covers only get.
        const grantVerbs = new Set(rule.verbs.flatMap(expandVerb));
        const applies = [...requestVerbs].some((v) => grantVerbs.has(v));
        if (!applies) continue;
        let result: boolean;
        try {
          const value = rule.condition
            ? evalExpr(rule.condition, {
                input,
                now: nowMillis,
                params: newParams,
                locals: {},
                funcs: block.visibleFuncs ?? new Map(),
                depth: 0,
                firestoreLookup,
                firestoreAccesses,
              })
            : true;
          // An error value reaching the allow boundary DENIES, carrying
          // production's own message (e.g. "Property name is undefined on
          // object.") into the reason trace.
          if (isErr(value)) {
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${value.message}`,
            );
            continue;
          }
          result = truthy(value);
        } catch (err) {
          // Any function-evaluation failure (undefined function, wrong
          // arity, depth exceeded, error inside a body) denies this rule
          // with a reason that names the function — never a false allow.
          if (err instanceof RuleEvalError) {
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`,
            );
            continue;
          }
          throw err;
        }
        if (result) return true;
        reasons.push(
          `match ${formatPath(block.segments)} ${input.request.method}: condition false`,
        );
      }
    }
    // Recurse into children with the leftover path.
    for (const child of block.children) {
      if (visit(child, left, newParams)) return true;
    }
    return false;
  }

  const allowed = visit(rules._root, pathSegments, {});
  if (!allowed && reasons.length === 0) {
    reasons.push(`no rule matches ${input.request.method} /${pathSegments.join('/')}`);
  }
  return { allowed, reasons };
}

/** Property read against `obj`, with production's absent-property semantics:
 *  a key that is missing — or present but holding `undefined` — is an ERROR,
 *  never a silent `undefined`. */
function readProperty(obj: unknown, name: string): unknown {
  if (!isRulesMap(obj) && !Array.isArray(obj)) {
    return new RuleError(`Property ${name} is undefined on ${describeType(obj)}.`);
  }
  if (!Object.hasOwn(obj, name)) {
    return new RuleError(`Property ${name} is undefined on object.`);
  }
  const v = obj[name as keyof typeof obj];
  if (v === undefined) return new RuleError(`Property ${name} is undefined on object.`);
  return v;
}

function truthy(v: unknown): boolean {
  // An error value is never truthy: it denies. (Without this, a `RuleError`
  // object would be truthy and every absent-property read would FALSE-ALLOW.)
  if (isErr(v)) return false;
  return v !== false && v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
}

/**
 * Raised when a user-defined function cannot be evaluated (undefined,
 * wrong arity, call depth exceeded, or an error surfacing from within a
 * body). Caught at the condition boundary and converted into a
 * deny-with-reason so a function failure NEVER produces a false allow,
 * matching production Storage, where evaluation errors deny.
 */
/**
 * Production Storage caps function call depth (documented limit 20) and
 * effectively disallows recursion. We enforce a hard cap that errors
 * (→ deny) rather than looping forever.
 */
const MAX_CALL_DEPTH = 20;

/** Everything an expression needs to evaluate. */
export interface EvalCtx {
  input: EvaluationInput;
  /** `request.time` as epoch milliseconds (injected by the caller,
   *  defaulting to evaluation-time now). */
  now: number;
  /** Path wildcards from the enclosing match. Empty inside a function
   *  body: caller wildcards do not leak in except via arguments. */
  params: Record<string, string | string[]>;
  /** Function parameter and `let` bindings for the current body. */
  locals: Record<string, unknown>;
  /** Functions callable from the current scope. */
  funcs: FunctionMap;
  /** Current call depth (0 at an allow condition). */
  depth: number;
  /** Optional Firestore read capability for `firestore.get()/exists()`.
   *  Absent in pure/test usage → those methods deny "unsupported". */
  firestoreLookup?: FirestoreLookup;
  /** Distinct Firestore document paths charged during this evaluation. */
  firestoreAccesses: Set<string>;
}

/**
 * Walk an `Expr` against the bindings + path params. Missing bindings or
 * members and invalid operations produce `RuleError` values. They propagate
 * unless evaluation short-circuits around them or an explicitly modeled
 * boolean case absorbs them (for example, `<error> || true`). Any `RuleError`
 * that reaches an allow boundary denies with its production-shaped reason.
 *
 * User-defined function failures throw `RuleEvalError`; the allow boundary
 * likewise catches them and denies instead of falling through to a
 * potentially truthy value.
 */
export function evalExpr(expr: Expr, ctx: EvalCtx): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ident': {
      // Local (param / let) bindings win over globals and path params.
      if (expr.name in ctx.locals) return ctx.locals[expr.name];
      if (expr.name === 'request') return buildRequestObject(ctx.input, ctx.now);
      // Production exposes no usable `resource` value when the target object
      // does not exist. Even comparing the missing binding with null errors
      // and denies; it is not a JavaScript-like null sentinel.
      if (expr.name === 'resource') {
        return ctx.input.resource === null
          ? new RuleError('Null value error.')
          : buildResourceObject(ctx.input.resource);
      }
      if (expr.name in ctx.params) return ctx.params[expr.name];
      return undefined;
    }
    case 'member': {
      const t = evalExpr(expr.target, ctx);
      if (isErr(t)) return t;
      // Production: dereferencing a null (e.g. `resource.name` on a create) is
      // a "Null value error" — it denies, and denies through a negation too.
      if (t === null || t === undefined) return new RuleError(`Null value error.`);
      return readProperty(t, expr.name);
    }
    case 'index': {
      const t = evalExpr(expr.target, ctx);
      if (isErr(t)) return t;
      if (t === null || t === undefined) return new RuleError(`Null value error.`);
      const idx = evalExpr(expr.index, ctx);
      if (isErr(idx)) return idx;
      return readProperty(t, String(idx));
    }
    case 'call':
      return evalCall(expr, ctx);
    case 'methodcall':
      return evalMethodCall(expr, ctx);
    case 'path':
      // A path literal is only meaningful as a `firestore.get()/exists()`
      // argument (handled directly there). Reaching it anywhere else means
      // the rule used it out of position — deny rather than coerce.
      throw new RuleEvalError('a Firestore path literal is only valid as an argument to firestore.get()/exists()');
    case 'unary': {
      // An error survives negation (production: `!(resource.name == 'x')` with
      // `name` absent DENIES). Propagate rather than flipping it to `true`.
      const a = evalExpr(expr.arg, ctx);
      if (isErr(a)) return a;
      if (expr.op === '-') {
        if (a instanceof RulesFloat) return new RulesFloat(-a.value);
        if (typeof a !== 'number') return new RuleError(`Unary '-' applied to ${describeType(a)}.`);
        return -a;
      }
      if (typeof a !== 'boolean') {
        throw new RuleEvalError(`Unary '!' expects a boolean, got ${describeType(a)}.`);
      }
      return !a;
    }
    case 'ternary': {
      const c = evalExpr(expr.cond, ctx);
      // An error condition denies the whole conditional; it must not fall
      // through to the alternate branch and potentially allow.
      if (isErr(c)) return c;
      return truthy(c) ? evalExpr(expr.then, ctx) : evalExpr(expr.else, ctx);
    }
    case 'in': {
      const el = evalExpr(expr.element, ctx);
      if (isErr(el)) return el;
      const coll = evalExpr(expr.collection, ctx);
      if (isErr(coll)) return coll;
      // `x in list` is membership; `x in map` tests OWN keys only — production
      // maps never expose prototype names (`'toString' in map` is false;
      // live-pinned by rules-firestore-prototype-chain-keys), so JS `in`
      // (which walks the prototype chain) would false-ALLOW here.
      if (Array.isArray(coll)) return coll.some((v) => rulesEquals(v, el));
      if (isRulesMap(coll)) return typeof el === 'string' && Object.prototype.hasOwnProperty.call(coll, el);
      return new RuleError(`'in' applied to ${describeType(coll)} (expected a list or map).`);
    }
    case 'is': {
      const v = evalExpr(expr.value, ctx);
      if (isErr(v)) return v;
      return typeMatches(v, expr.typeName);
    }
    case 'list': {
      const out: unknown[] = [];
      for (const el of expr.elements) {
        const v = evalExpr(el, ctx);
        if (isErr(v)) return v;
        out.push(v);
      }
      return out;
    }
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        const k = evalExpr(entry.key, ctx);
        if (isErr(k)) return k;
        if (typeof k !== 'string') return new RuleError(`Map literal key is ${describeType(k)} (expected a string).`);
        const v = evalExpr(entry.value, ctx);
        if (isErr(v)) return v;
        out[k] = v;
      }
      return out;
    }
    case 'slice': {
      const t = evalExpr(expr.target, ctx);
      if (isErr(t)) return t;
      const start = evalExpr(expr.start, ctx);
      if (isErr(start)) return start;
      const end = evalExpr(expr.end, ctx);
      if (isErr(end)) return end;
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
        return new RuleError(`Slice bounds must be integers.`);
      }
      // Production slices lists AND strings, but an out-of-range bound ERRORS
      // (deny) — it does NOT clamp the way JS `.slice()` does (live-pinned by
      // rules-firestore-range-slice-list-and-string: end past length → DENY).
      if (Array.isArray(t) || typeof t === 'string') {
        if (start < 0 || end < start || end > t.length) {
          return new RuleError(`Slice bounds [${start}:${end}] out of range for ${describeType(t)} of size ${t.length}.`);
        }
        return t.slice(start, end);
      }
      return new RuleError(`Slice applied to ${describeType(t)} (expected a list or string).`);
    }
    case 'binary': {
      // Short-circuit && / || so half-undefined chains don't trip
      // (e.g. `request.auth != null && request.auth.uid == 'a'`).
      if (expr.op === '&&') {
        const l = evalExpr(expr.left, ctx);
        if (isErr(l)) return l;
        return truthy(l) ? evalExpr(expr.right, ctx) : l;
      }
      if (expr.op === '||') {
        const l = evalExpr(expr.left, ctx);
        if (isErr(l)) {
          // Production: `<error> || true` ALLOWS — a true disjunct rescues the
          // error; `<error> || false` stays an error.
          const r = evalExpr(expr.right, ctx);
          return truthy(r) ? r : l;
        }
        return truthy(l) ? l : evalExpr(expr.right, ctx);
      }
      const l = evalExpr(expr.left, ctx);
      if (isErr(l)) return l;
      const r = evalExpr(expr.right, ctx);
      if (isErr(r)) return r;
      switch (expr.op) {
        // Lists and maps compare STRUCTURALLY (production `[a] == [a]` is true;
        // JS reference identity would make every literal comparison
        // false). Everything else is strict equality.
        case '==': return rulesEquals(l, r);
        case '!=': return !rulesEquals(l, r);
        case '<':  return cmp(l, r) < 0;
        case '>':  return cmp(l, r) > 0;
        case '<=': return cmp(l, r) <= 0;
        case '>=': return cmp(l, r) >= 0;
        case '+':  return numOp(l, r, (a, b) => a + b);
        case '-':  return numOp(l, r, (a, b) => a - b);
        case '*':  return numOp(l, r, (a, b) => a * b);
        // Division: int ÷ int TRUNCATES toward zero and an int zero divisor
        // ERRORS (deny; `10 / 0 || true` still absorbs to allow) — JS float
        // division would yield 2.5 / Infinity, and Infinity leaks through
        // comparisons as a false-ALLOW. Float division stays float (÷ 0 →
        // ±Infinity/NaN, the simulator's CEL-pinned behavior).
        case '/': {
          if (isFloatNum(l) || isFloatNum(r)) return numOp(l, r, (a, b) => a / b);
          return numVal(r) === 0
            ? new RuleError('Division by zero.')
            : numOp(l, r, (a, b) => Math.trunc(a / b));
        }
        case '%': {
          if (isFloatNum(l) || isFloatNum(r)) return numOp(l, r, (a, b) => a % b);
          return numVal(r) === 0 ? new RuleError('Modulo by zero.') : numOp(l, r, (a, b) => a % b);
        }
      }
    }
  }
}

/**
 * Evaluate a user-defined function call. Arguments are evaluated in the
 * CALLER's context, then bound to the function's parameters; the body
 * (with any `let` bindings) is evaluated in the function's own lexical
 * scope with fresh locals — caller path wildcards are not visible except
 * through the arguments passed. Every failure mode throws `RuleEvalError`
 * so the caller denies with a function-naming reason.
 */
function evalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  const fn = ctx.funcs.get(expr.name);
  if (!fn) {
    throw new RuleEvalError(`undefined function ${expr.name}()`);
  }
  if (fn.unresolvedImport !== undefined) {
    throw new RuleEvalError(
      `function ${expr.name}() is imported from '${fn.unresolvedImport}', but import module resolution is not implemented`,
    );
  }
  if (fn.params.length !== expr.args.length) {
    throw new RuleEvalError(
      `function ${expr.name}() expects ${fn.params.length} argument(s), got ${expr.args.length}`,
    );
  }
  const depth = ctx.depth + 1;
  if (depth > MAX_CALL_DEPTH) {
    throw new RuleEvalError(
      `function ${expr.name}() exceeded max call depth ${MAX_CALL_DEPTH}`,
    );
  }
  // Arguments: caller context.
  const argVals = expr.args.map((a) => evalExpr(a, ctx));
  const locals: Record<string, unknown> = {};
  fn.params.forEach((p, i) => {
    locals[p] = argVals[i];
  });
  const bodyCtx: EvalCtx = {
    input: ctx.input,
    now: ctx.now,
    params: {}, // no dynamic-scope leakage of caller wildcards
    locals,
    funcs: fn.declScope ?? new Map(),
    depth,
    firestoreLookup: ctx.firestoreLookup,
    firestoreAccesses: ctx.firestoreAccesses,
  };
  // `let` bindings evaluated in order; each is visible to the next and
  // to the return expression (they share the `locals` object).
  for (const b of fn.lets) {
    locals[b.name] = evalExpr(b.value, bodyCtx);
  }
  return evalExpr(fn.body, bodyCtx);
}

/**
 * `value is <type>` check. Numbers use the RULES-B5 model: a `RulesFloat`
 * wrapper is a FLOAT, a bare number is an INT — so `1.0 is float` and
 * `!(1.0 is int)` type by literal form exactly as production does. A bare
 * NON-integral number (a fractional value that arrived from data rather than
 * a literal, e.g. a Firestore-lookup double) still reads as float. `number`
 * accepts either.
 */
function typeMatches(v: unknown, typeName: string): boolean | RuleError {
  switch (typeName) {
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'int': return typeof v === 'number' && Number.isInteger(v);
    case 'float': return v instanceof RulesFloat || (typeof v === 'number' && !Number.isInteger(v));
    case 'number': return v instanceof RulesFloat || typeof v === 'number';
    case 'list': return Array.isArray(v);
    case 'map': return isRulesMap(v);
    default:
      // timestamp/duration/path/latlng are modeled as plain millis/strings
      // here — a type test against them cannot answer honestly, so deny
      // with a reason rather than false-allow.
      return new RuleError(`'is ${typeName}' is not supported by the storage evaluator.`);
  }
}

/** Raw numeric value of an int (bare number) or float (RulesFloat); undefined
 *  for anything else. */
function isFloatNum(v: unknown): boolean {
  return v instanceof RulesFloat;
}

function cmp(a: unknown, b: unknown): number {
  const an = numVal(a);
  const bn = numVal(b);
  // CEL compares int and float by numeric value (`1 < 1.5` is well-typed).
  if (an !== undefined && bn !== undefined) return an - bn;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN; // mismatched types → NaN → all comparisons return false
}

/** Arithmetic over ints and floats: unwraps, computes, and RE-TAGS the result
 *  as a float when either operand was one (int op float promotes to float). */
function numOp(a: unknown, b: unknown, fn: (x: number, y: number) => number): unknown {
  const an = numVal(a);
  const bn = numVal(b);
  if (an === undefined || bn === undefined) return undefined;
  const result = fn(an, bn);
  return isFloatNum(a) || isFloatNum(b) ? new RulesFloat(result) : result;
}

/**
 * Build the `resource.*` binding from the existing-object record, converting
 * the ISO-8601 time fields to epoch millis so they compare numerically against
 * `request.time` (which {@link buildRequestObject} models the same way) and
 * against each other (`resource.timeCreated == resource.updated`).
 *
 * A field the record does not carry is left `undefined`, which
 * {@link readProperty} reports as production's absent-property ERROR.
 */
function buildResourceObject(resource: StorageResource): Record<string, unknown> {
  return {
    size: resource.size,
    contentType: resource.contentType,
    metadata: resource.metadata,
    name: resource.name,
    bucket: resource.bucket,
    generation: resource.generation,
    metageneration: resource.metageneration,
    timeCreated: isoToMillis(resource.timeCreated),
    updated: isoToMillis(resource.updated),
  };
}

/** ISO-8601 → epoch millis. An unparseable or absent value stays `undefined`
 *  (→ absent-property error → deny) rather than becoming `NaN`. */
function isoToMillis(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function buildRequestObject(input: EvaluationInput, now: number): Record<string, unknown> {
  return {
    // The production Storage engine represents anonymous auth as an absent
    // property, not a usable null value. Ordinary `request.auth != null`
    // gates still deny, while conditionals cannot incorrectly select a
    // fallback branch from the synthetic null.
    auth: input.request.auth ?? new RuleError('Property auth is undefined on object.'),
    // Production treats an operation without an incoming object (notably
    // delete/read) as an absent binding. A direct null comparison errors just
    // like a property read; neither may turn the missing value into an allow.
    resource: input.request.resource ?? new RuleError('Property resource is undefined on object.'),
    method: input.request.method,
    path: input.request.path,
    // `request.time` as epoch millis — see the timestamp constructors in
    // `evalMethodCall`, which produce the same representation so comparisons
    // like `request.time < timestamp.date(2030, 1, 1)` are plain numerics.
    time: now,
  };
}
