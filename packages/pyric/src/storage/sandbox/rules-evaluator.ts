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
import { buildRequestObject, buildResourceObject } from './rules-bindings.js';
import { evalMethodCall } from './rules-methods.js';
import {
  evalArithmetic,
  evalOrdering,
  evalValueOperator,
  isValueTypeOperand,
  typeMatches,
} from './rules-operators.js';
import { formatPath, matchSegments, splitPath } from './rules-path-match.js';
import {
  RuleEvalError,
  RuleExpressionLimitError,
  RuleResourceLimitError,
  RuleUnsupportedError,
  isAbsorbableEvalError,
} from './rules-evaluation-error.js';
import { EXPRESSION_LIMIT, ExpressionBudget, describeExpressionLimit } from '../../rules/simulator/expression-budget.js';
import type { ExpressionPosition } from '../../rules/grammar/expression-positions.js';
import { StoragePath } from './rules-path.js';
import { ConversionFailure, applyConversion, conversionFor } from '../../rules/simulator/conversions.js';
import { describeRulesType as describeType, isRulesMap } from '../../rules/simulator/rules-type.js';
import { sliceBoundsError } from '../../rules/simulator/slice-bounds.js';
import { IndexAccessFailure, indexValue, readMember } from '../../rules/simulator/index-access.js';
import { mapLiteral } from '../../rules/simulator/map-keys.js';
import { MembershipFailure, membership } from '../../rules/simulator/membership.js';
import { rulesValuesEqual } from '../../rules/simulator/value-equality.js';
import {
  RuleError,
  isRuleError as isErr,
} from './rules-values.js';

export function evaluateStorageRules(
  rules: StorageRules,
  input: EvaluationInput,
  now: Date = new Date(),
  firestoreLookup?: FirestoreLookup,
): EvaluationResult {
  // `request.time` is the request's evaluation moment. The caller injects it
  // (deterministic in tests); it defaults to now. The request binding turns
  // it into the Timestamp value `timestamp.date(...)` and
  // `timestamp.value(...)` also build.
  const nowMillis = now.getTime();
  const pathSegments = splitPath(input.request.path);
  const reasons: string[] = [];
  const firestoreAccesses = new Set<string>();
  // One expression budget for the request, shared by every allow rule and
  // match block, in the unit the Firestore simulator counts.
  const expressionBudget = new ExpressionBudget((message, position) => new RuleExpressionLimitError(message, position));
  let expressionLimit: { message: string; position: ExpressionPosition | undefined } | undefined;
  // Whether the request stopped at the limit, and the first error an allow
  // rule raised before it. Production goes on to later allow rules after an
  // error, and reports that error rather than a limit reached after it.
  let stopped = false;
  let firstError: string | undefined;

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
    if (stopped) return false;
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
          let value: unknown = true;
          if (rule.condition) {
            value = evalExpr(rule.condition, {
              input,
              now: nowMillis,
              params: newParams,
              locals: {},
              funcs: block.visibleFuncs ?? new Map(),
              firestoreLookup,
              firestoreAccesses,
              expressionBudget,
            });
          }
          if (typeof value === 'boolean') {
            result = value;
          } else {
            // Not a bool. Either the expression already produced an evaluation
            // error, or CEL's boolean typing of the allow boundary makes one
            // here: the same `RuleError` the ternary condition raises, rather
            // than a truthiness coercion. Both DENY this rule with production's
            // own message in the reason trace and continue to the next rule.
            // Registry rows
            // `storage-rules#storage.semantic.strict-boolean-allow-boundary`
            // and `storage-rules#storage.semantic.strict-boolean-ternary-condition`
            // carry the claim; corpus scenario
            // `strict-boolean-allow-and-ternary` is the capture that verifies it.
            let failure: RuleError;
            if (isErr(value)) {
              failure = value;
            } else {
              failure = new RuleError(`Allow condition expected bool, got ${describeType(value)}.`);
            }
            firstError ??= failure.message;
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${failure.message}`,
            );
            continue;
          }
        } catch (err) {
          // The expression limit ends the request: production evaluates no
          // later allow rule or match block once it is reached.
          if (err instanceof RuleExpressionLimitError) {
            stopped = true;
            if (firstError === undefined) {
              expressionLimit = { message: err.message, position: err.position };
              // Production reports the limit at the expression the budget ran
              // out on, so the reason cites that position.
              reasons.push(
                `match ${formatPath(block.segments)} ${input.request.method}: ${describeExpressionLimit(err.message, err.position)}`,
              );
            } else {
              reasons.push(
                `match ${formatPath(block.segments)} ${input.request.method}: ${err.message} `
                + `Reached after an earlier allow rule raised an error; production reports that earlier error: ${firstError}`,
              );
            }
            return false;
          }
          // Any thrown evaluation failure (an unresolved
          // import, an error inside a body) denies this rule with a reason
          // that names the function, never a false allow.
          if (err instanceof RuleEvalError) {
            firstError ??= err.message;
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
  return {
    allowed,
    reasons,
    evaluatedExpressions: expressionBudget.evaluated,
    ...(expressionLimit !== undefined
      ? {
        resourceLimit: {
          kind: 'expressions' as const,
          limit: EXPRESSION_LIMIT,
          message: expressionLimit.message,
          ...(expressionLimit.position === undefined
            ? {}
            : { line: expressionLimit.position.line, column: expressionLimit.position.column }),
        },
      }
      : {}),
  };
}

/** `obj.name`: a map's own key, a path's bound name, or production's error (`index-access.ts`). */
function readProperty(obj: unknown, name: string): unknown {
  const value = readMember(obj, name);
  return value instanceof IndexAccessFailure ? new RuleError(value.message) : value;
}

/** Everything an expression needs to evaluate. */
export interface EvalCtx {
  input: EvaluationInput;
  /** The evaluation instant in epoch milliseconds (injected by the caller,
   *  defaulting to evaluation-time now); `request.time` is its Timestamp. */
  now: number;
  /** Path wildcards from the enclosing match. Empty inside a function
   *  body: caller wildcards do not leak in except via arguments. */
  params: Record<string, string | string[]>;
  /** Function parameter and `let` bindings for the current body. */
  locals: Record<string, unknown>;
  /** Functions callable from the current scope. */
  funcs: FunctionMap;
  /** Optional Firestore read capability for `firestore.get()/exists()`.
   *  Absent in pure/test usage → those methods deny "unsupported". */
  firestoreLookup?: FirestoreLookup;
  /** Distinct Firestore document paths charged during this evaluation. */
  firestoreAccesses: Set<string>;
  /** Per-request expression budget; absent in direct evaluator use. */
  expressionBudget?: ExpressionBudget;
}

/**
 * Walk an `Expr` against the bindings + path params. Missing bindings or
 * members and invalid operations produce `RuleError` values. They propagate
 * unless a `&&`/`||` operand that uniquely determines the result absorbs
 * them COMMUTATIVELY, CEL-style (`<error> || true` → true, and
 * `<error> && false` → false, see the binary case). Any `RuleError` that
 * reaches an allow boundary denies with its production-shaped reason.
 *
 * Function-evaluation failures throw `RuleEvalError`; at a `&&`/`||`
 * operand boundary the ABSORBABLE ones are converted to error values so
 * they participate in the same absorption, while unsupported/compile-reject
 * (`RuleUnsupportedError`) and resource-limit (`RuleResourceLimitError`)
 * failures re-throw and fail the evaluation closed. The allow boundary
 * catches whatever still throws and denies instead of falling through to a
 * potentially truthy value.
 */
export function evalExpr(expr: Expr, ctx: EvalCtx): unknown {
  // A call by name is charged as it is entered; every other node as it
  // completes, with a value or an error, as the Firestore simulator charges
  // (`expression-budget.ts`).
  const budget = ctx.expressionBudget;
  if (!budget) return evalNode(expr, ctx);
  if (expr.kind === 'call') {
    budget.call(expr);
    return evalNode(expr, ctx);
  }
  let value: unknown;
  try {
    value = evalNode(expr, ctx);
  } catch (e) {
    if (!(e instanceof RuleResourceLimitError)) budget.node(expr);
    throw e;
  }
  budget.node(expr);
  return value;
}

function evalNode(expr: Expr, ctx: EvalCtx): unknown {
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
      // The index evaluates before the value it indexes, as in the
      // Firestore simulator.
      const operands = evalOperands([expr.index, expr.target], ctx);
      if (isErr(operands)) return operands;
      const [idx, t] = operands;
      if (t === null || t === undefined) return new RuleError(`Null value error.`);
      // A list, string or path index must be an int within bounds, a map key
      // must be owned, and other wrappers have no index operator
      // (`index-access.ts`, shared with the Firestore simulator).
      const element = indexValue(t, idx);
      return element instanceof IndexAccessFailure ? new RuleError(element.message) : element;
    }
    case 'call':
      return evalCall(expr, ctx);
    case 'methodcall':
      return evalMethodCall(expr, ctx);
    case 'path': {
      // A path literal outside a `firestore.get()/exists()` call is a path
      // value, such as an argument to a function that passes it on to
      // `firestore.get()`. It charges what the literal charges as a direct
      // argument there: one node and one unit per literal segment.
      ctx.expressionBudget?.node(expr);
      for (const seg of expr.segments) if (seg.kind === 'literal') ctx.expressionBudget?.pathSegment(expr);
      const interpolated = evalOperands(expr.segments.flatMap((seg) => (seg.kind === 'literal' ? [] : [seg.expr])), ctx);
      if (isErr(interpolated)) return interpolated;
      let next = 0;
      const parts: string[] = [];
      for (const seg of expr.segments) {
        if (seg.kind === 'literal') {
          parts.push(seg.value);
          continue;
        }
        const v = interpolated[next++];
        if (typeof v !== 'string' && typeof v !== 'number') {
          return new RuleError(`Path interpolation resolved to ${describeType(v)} (expected a string)`);
        }
        parts.push(String(v));
      }
      return new StoragePath(`/${parts.join('/')}`);
    }
    case 'unary': {
      const a = evalExpr(expr.arg, ctx);
      if (expr.op === '!') {
        if (isErr(a)) {
          throw new RuleEvalError(a.message);
        }
        if (typeof a !== 'boolean') {
          throw new RuleEvalError(`Unary '!' expects a boolean, got ${describeType(a)}.`);
        }
        return !a;
      }
      if (isErr(a)) return a;
      if (expr.op === '-') {
        if (a instanceof RulesFloat) return new RulesFloat(-a.value);
        if (typeof a !== 'number') return new RuleError(`Unary '-' applied to ${describeType(a)}.`);
        return -a;
      }
      return undefined;
    }
    case 'ternary': {
      ctx.expressionBudget?.ternary(expr);
      const c = evalExpr(expr.cond, ctx);
      // An error condition denies the whole conditional; it must not fall
      // through to the alternate branch and potentially allow.
      if (isErr(c)) return c;
      // CEL types the condition as bool. A non-boolean condition is an
      // evaluation error, which `&&` and `||` absorb like any other. Registry
      // row `storage-rules#storage.semantic.strict-boolean-ternary-condition`
      // carries the claim; corpus scenario `strict-boolean-allow-and-ternary`
      // is the capture that would verify it.
      if (typeof c !== 'boolean') {
        return new RuleError(`Ternary condition expected bool, got ${describeType(c)}.`);
      }
      if (c) return evalExpr(expr.then, ctx);
      ctx.expressionBudget?.ternaryElse(expr);
      return evalExpr(expr.else, ctx);
    }
    case 'in': {
      // List and set elements under Rules value equality, own map keys only,
      // and production's errors for any other operand (`membership.ts`,
      // shared with the Firestore simulator). Production evaluates the
      // collection before the element: when both error, the collection's
      // error is the result.
      const operands = evalOperands([expr.collection, expr.element], ctx);
      if (isErr(operands)) return operands;
      const [coll, el] = operands;
      const result = membership(el, coll);
      return result instanceof MembershipFailure ? new RuleError(result.message) : result;
    }
    case 'is': {
      const v = evalExpr(expr.value, ctx);
      if (isErr(v)) return v;
      return typeMatches(v, expr.typeName);
    }
    case 'list':
      return evalOperands(expr.elements, ctx);
    case 'map': {
      const values = evalOperands(expr.entries.flatMap((entry) => [entry.key, entry.value]), ctx);
      if (isErr(values)) return values;
      const entries: [string, unknown][] = [];
      for (let i = 0; i < values.length; i += 2) {
        const k = values[i];
        if (typeof k !== 'string') return new RuleError(`Map literal key is ${describeType(k)} (expected a string).`);
        entries.push([k, values[i + 1]]);
      }
      // The literal keeps its written order for values() (`map-keys.ts`).
      return mapLiteral(entries);
    }
    case 'slice': {
      const operands = evalOperands([expr.target, expr.start, expr.end], ctx);
      if (isErr(operands)) return operands;
      const [t, start, end] = operands;
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
        return new RuleError(`Slice bounds must be integers.`);
      }
      // Production slices lists and strings, and an out-of-range bound is an
      // error, never clamped the way JS `.slice()` does. The bounds are the
      // Firestore simulator's (`rules/simulator/slice-bounds.ts`).
      if (Array.isArray(t) || typeof t === 'string') {
        const boundsError = sliceBoundsError(start, end, t.length);
        if (boundsError) return new RuleError(boundsError);
        return t.slice(start, end);
      }
      return new RuleError(`Slice applied to ${describeType(t)} (expected a list or string).`);
    }
    case 'binary': {
      // RULES-B3: && and || are COMMUTATIVE error-absorbing operators in
      // CEL, not JS left-to-right short-circuit. The two operators differ
      // only in which operand value uniquely determines the result: false
      // for &&, true for ||. Both are evaluated by the one helper below.
      if (expr.op === '&&') return evalAbsorbingOperator(expr, false, ctx);
      if (expr.op === '||') return evalAbsorbingOperator(expr, true, ctx);
      // Both operands evaluate, and count, when the left one errors; the
      // left error is the result.
      const operands = evalOperands([expr.left, expr.right], ctx);
      if (isErr(operands)) return operands;
      const [l, r] = operands;
      // Timestamp, Duration, and Bytes operands own their comparison and
      // arithmetic operators; equality stays with rulesValuesEqual below.
      if (expr.op !== '==' && expr.op !== '!=' && (isValueTypeOperand(l) || isValueTypeOperand(r))) {
        return evalValueOperator(expr.op, l, r);
      }
      switch (expr.op) {
        // Lists and maps compare structurally (production `[a] == [a]` is
        // true), each element by its numeric type as well as its value.
        case '==': return rulesValuesEqual(l, r);
        case '!=': return !rulesValuesEqual(l, r);
        case '<':
        case '>':
        case '<=':
        case '>=':
          return evalOrdering(expr.op, l, r);
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          return evalArithmetic(expr.op, l, r);
      }
    }
  }
}

/**
 * Evaluate one commutative error-absorbing operator, `&&` or `||`. The two
 * differ only in `determining`, the operand value that fixes the result on
 * its own: `false` for `&&`, `true` for `||`.
 *
 * If either operand evaluates to `determining`, that is the result and an
 * error in the other operand is absorbed, whichever side it sits on. So
 * `error && false` evaluates to false and `error || true` to true, while
 * `error && true` and `error || false` propagate the error and deny.
 * Laziness is preserved in the no-error path: a determining left operand
 * skips the right one entirely.
 */
function evalAbsorbingOperator(
  operator: Extract<Expr, { kind: 'binary' }>,
  determining: boolean,
  ctx: EvalCtx,
): boolean | RuleError {
  const { left, right } = operator;
  const l = evalLogicalOperand(left, ctx);
  if (l === determining) return determining; // left determines; right unevaluated
  ctx.expressionBudget?.logicalRight(operator);
  const r = evalLogicalOperand(right, ctx);
  if (r === determining) return determining; // right determines and absorbs any left error
  if (isErr(l)) return l;                    // left errored and nothing determined
  return r;                                  // left was non-determining; right decides
}

/**
 * Evaluate one `&&`/`||` operand tri-state: `true`, `false`, or a
 * {@link RuleError} value the operator may absorb commutatively.
 *
 *   - A thrown ABSORBABLE {@link RuleEvalError} (for example
 *     `firestore.get()` without an injected capability, or `!` on an error)
 *     is converted to an error VALUE here so a determining sibling operand
 *     can absorb it: production evaluates these positions to a
 *     position-local error.
 *   - {@link RuleUnsupportedError} (compile-reject or unmodelable) and
 *     {@link RuleResourceLimitError} (the lookup cap) re-throw:
 *     production fails those closed for the WHOLE evaluation, so no
 *     determining operand may rescue them (the lookup-budget precedent).
 *   - A non-boolean, non-error operand is a CEL TYPE error (RULES-B6,
 *     captured by rules-firestore-strict-boolean-control-flow): it becomes
 *     an absorbable error value, never a truthy/falsy coercion.
 */
function evalLogicalOperand(expr: Expr, ctx: EvalCtx): boolean | RuleError {
  const v = evalOperand(expr, ctx);
  if (isErr(v)) return v;
  if (typeof v !== 'boolean') {
    return new RuleError(`Expected a boolean '&&'/'||' operand, got ${describeType(v)}.`);
  }
  return v;
}

/**
 * Evaluate one operand to a value or an error value. A thrown ABSORBABLE
 * {@link RuleEvalError} becomes a {@link RuleError} value; an unsupported
 * construct or a resource limit re-throws and fails the evaluation closed.
 */
export function evalOperand(expr: Expr, ctx: EvalCtx): unknown {
  try {
    return evalExpr(expr, ctx);
  } catch (err) {
    if (isAbsorbableEvalError(err)) return new RuleError(err.message);
    throw err;
  }
}

/**
 * Evaluate every operand in order: the values, or the first error value.
 * Production goes on evaluating the operands of a non-logical operator, a
 * literal's elements, and a call's receiver and arguments after one errors,
 * and counts them toward the expression limit; the result is the first
 * error.
 */
export function evalOperands(exprs: readonly Expr[], ctx: EvalCtx): unknown[] | RuleError {
  const values: unknown[] = [];
  let error: RuleError | undefined;
  for (const expr of exprs) {
    const value = evalOperand(expr, ctx);
    if (isErr(value)) error ??= value;
    values.push(value);
  }
  return error ?? values;
}

/**
 * Evaluate a bare function call. A function the ruleset declares in scope
 * wins over a global of the same name. Arguments are evaluated in the
 * CALLER's context, then bound to the function's parameters; the body
 * (with any `let` bindings) is evaluated in the function's own lexical
 * scope with fresh locals, so caller path wildcards are not visible except
 * through the arguments passed. An undefined function and a wrong argument
 * count are error values that `&&` and `||` can absorb, as in production.
 */
function evalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  const fn = ctx.funcs.get(expr.name);
  if (!fn) return evalGlobalCall(expr, ctx);
  // An unresolved import is a construct the evaluator cannot model, so it
  // always fails closed.
  if (fn.unresolvedImport !== undefined) {
    throw new RuleUnsupportedError(
      `function ${expr.name}() is imported from '${fn.unresolvedImport}', but import module resolution is not implemented`,
    );
  }
  if (fn.params.length !== expr.args.length) {
    return new RuleError(
      `Incorrect number of arguments. Received: ${expr.args.length}. Expected: ${expr.name}(${fn.params.join(', ')}).`,
    );
  }
  // No call depth guard: `parseStorageRules` rejects a chain over
  // production's compile limit and any recursive call, so the depth of a
  // call here is bounded (`rules/grammar/compile-limits.ts`).
  // Arguments: caller context. Every argument evaluates; one that errors
  // binds its error value, which decides the call only if the body reads
  // that parameter.
  const argVals = expr.args.map((a) => evalOperand(a, ctx));
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
    firestoreLookup: ctx.firestoreLookup,
    firestoreAccesses: ctx.firestoreAccesses,
    expressionBudget: ctx.expressionBudget,
  };
  // `let` bindings evaluated in order; each is visible to the next and
  // to the return expression (they share the `locals` object). A binding
  // whose value errors holds the error, as a parameter does.
  for (const b of fn.lets) {
    locals[b.name] = evalOperand(b.value, bodyCtx);
    bodyCtx.expressionBudget?.letBinding(b);
  }
  return evalExpr(fn.body, bodyCtx);
}

/** Evaluate a call to a global function: `path()` or a conversion. */
function evalGlobalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  if (expr.name === 'path' && expr.args.length === 1) {
    const inner = evalExpr(expr.args[0], ctx);
    if (isErr(inner)) return inner;
    if (typeof inner === 'string') return new StoragePath(inner);
    if (inner instanceof StoragePath) return inner;
    return new RuleError(`path() expects a string, got ${describeType(inner)}.`);
  }
  const conversion = conversionFor(expr.name);
  if (!conversion) return new RuleError(`Function not found error: Name: [${expr.name}].`);
  const args = evalOperands(expr.args, ctx);
  if (isErr(args)) return args;
  const converted = applyConversion(conversion, args);
  return converted instanceof ConversionFailure ? new RuleError(converted.message) : converted;
}
