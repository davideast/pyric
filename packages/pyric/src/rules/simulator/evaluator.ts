/**
 * Firestore Security Rules Expression Evaluator.
 *
 * Walks the parsed AST and evaluates expressions against a simulated context.
 * Implements short-circuit evaluation for && and || to match Firestore behavior.
 *
 * Layers (built incrementally):
 *   1. Literals, identifiers, binary ops, comparisons
 *   2. Member access, bracket access, `in` operator
 *   3. Function calls, let bindings
 *   4. Method calls + MapDiff
 *   5. get()/exists() with mock resolution
 */
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { MapDiff } from './mapdiff.js';
import { FirestoreSet } from './firestore-set.js';
import { rulesValuesEqual } from './value-equality.js';
import { describeRulesType } from './rules-type.js';
import { sliceBoundsError } from './slice-bounds.js';
import { MembershipFailure, membership } from './membership.js';
import { RulesValue, NO_OP } from './wrappers/base.js';
import { LatLng } from './wrappers/latlng.js';
import { Duration } from './wrappers/duration.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Bytes } from './wrappers/bytes.js';
import { Path } from './wrappers/path.js';
import { RulesFloat } from './wrappers/float.js';
import { DIVIDE_BY_ZERO_MESSAGE, EvalError, ResourceLimitError } from './eval-error.js';
import { UnsupportedError } from './unsupported-error.js';

export { EvalError, EvalError as RuleEvalError } from './eval-error.js';
export { UnsupportedError } from './unsupported-error.js';

// ═══ Simulation Context ═══

export type { SimAuth, SimRequest, SimResource, SimulationContext } from './evaluation-context.js';
export type { ExprTraceEntry } from './trace-recorder.js';
export { TraceRecorder } from './trace-recorder.js';
import type { SimulationContext } from './evaluation-context.js';
import { evaluateFunctionCall, evaluateMethodCall } from './evaluation-builtins.js';

// ═══ Evaluator ═══

/**
 * Evaluate an expression against the simulation context. The public
 * entry point — recursive calls inside the evaluator come back through
 * here, so the optional trace wrapping naturally applies to every
 * sub-expression.
 */
export function evaluate(expr: Expression, ctx: SimulationContext, scope: Record<string, unknown> = {}): unknown {
  if (!ctx.trace) return evaluateExpr(expr, ctx, scope);
  return ctx.trace.capture(expr, () => evaluateExpr(expr, ctx, scope));
}

function evaluateExpr(expr: Expression, ctx: SimulationContext, scope: Record<string, unknown>): unknown {
  // One unit per evaluated node, charged inside the trace capture so the
  // node that reaches the limit records the limit as its error.
  ctx.expressionBudget?.node();
  switch (expr.type) {
    // ═══ Layer 1: Literals, identifiers, binary ops ═══

    case 'literal':
      // RULES-B5: a source literal written with a decimal point is a FLOAT
      // (`1.0`, `1.5`), even when its value is integral. The grammar's
      // `number_float` rule preserves the original text in `raw`, so a `.`
      // there is the float signal. Bare integer literals (`1`) stay raw
      // numbers (= int). Non-numeric literals (string/bool/null) pass through.
      if (typeof expr.value === 'number' && expr.raw.includes('.')) {
        return new RulesFloat(expr.value);
      }
      // A bytes literal (`b'...'`) evaluates to the same Bytes value as `toUtf8()`.
      if (expr.value instanceof Uint8Array) return new Bytes(expr.value);
      return expr.value;

    case 'identifier':
      return resolveIdentifier(expr.name, ctx, scope);

    case 'binaryOp':
      return evaluateBinaryOp(expr.op, expr.left, expr.right, ctx, scope);

    case 'unaryOp': {
      if (expr.op === '!') {
        return !requireBoolean(evaluate(expr.operand, ctx, scope), expr.operand);
      }
      if (expr.op === '-') {
        const v = evaluate(expr.operand, ctx, scope);
        // RULES-B5: negating a float stays a float (`-1.5 is float`); negating
        // an int stays an int. Preserve the operand's type tag.
        if (v instanceof RulesFloat) return new RulesFloat(-v.value);
        return -(v as number);
      }
      throw new EvalError(`Unknown unary op: ${expr.op}`, expr);
    }

    case 'ternary': {
      ctx.expressionBudget?.ternary();
      const cond = requireBoolean(evaluate(expr.condition, ctx, scope), expr.condition);
      if (cond) return evaluate(expr.consequent, ctx, scope);
      ctx.expressionBudget?.ternaryElse();
      return evaluate(expr.alternate, ctx, scope);
    }

    // ═══ Layer 2: Member access, bracket access, `in` ═══

    case 'memberAccess': {
      const obj = evaluate(expr.object, ctx, scope);
      // RULES-B2: field access on null/undefined is a runtime ERROR in
      // Firestore rules (CEL field selection has no overload for null),
      // not a silent null. Production denies the request. The common
      // guard `request.auth != null && request.auth.uid == ...` stays
      // safe because `&&` absorbs this error commutatively (RULES-B3) —
      // the `false` LHS uniquely determines the result.
      if (obj === null || obj === undefined) {
        throw new EvalError(
          `Property '${expr.property}' accessed on ${obj === null ? 'null' : 'undefined'} value`,
          expr,
        );
      }
      // Wrapper-owned property dispatch (Item 0.B hook 2). Wrappers like
      // Timestamp expose no readable properties — `t.year` returns null,
      // `t.year()` goes through callMethod. The base default returns null
      // so unknown properties stay consistent with Firestore's "missing
      // map key reads as null" semantics.
      if (obj instanceof RulesValue) return obj.field(expr.property);
      if (obj instanceof MapDiff) {
        // MapDiff methods that return FirestoreSet
        switch (expr.property) {
          case 'addedKeys': return () => (obj as MapDiff).addedKeys();
          case 'removedKeys': return () => (obj as MapDiff).removedKeys();
          case 'changedKeys': return () => (obj as MapDiff).changedKeys();
          case 'affectedKeys': return () => (obj as MapDiff).affectedKeys();
          case 'unchangedKeys': return () => (obj as MapDiff).unchangedKeys();
        }
      }
      if (obj instanceof FirestoreSet) {
        switch (expr.property) {
          case 'size': return () => (obj as FirestoreSet).size();
        }
      }
      // RULES-B2: reading a key that does not exist on a map is a runtime
      // ERROR in Firestore rules (`resource.data.typo` denies the request),
      // not the silent null this path used to return — that inversion made
      // `resource.data.typo == null` ALLOW where production DENYs. A key
      // present with an explicit null value still returns null (the key
      // exists). Guard with the `in` operator (`'f' in resource.data`) or
      // `resource.data.get('f', default)` to read a possibly-absent field.
      if (Object.hasOwn(obj as object, expr.property)) {
        return (obj as Record<string, unknown>)[expr.property];
      }
      throw new EvalError(
        `No field '${expr.property}' on map (use 'in' or .get() to read a possibly-absent field)`,
        expr,
      );
    }

    case 'bracketAccess': {
      const [obj, idx] = evaluateOperands([expr.object, expr.index], ctx, scope);
      // RULES-B2: index/key access on null/undefined errors in production
      // (no CEL index overload for null), absorbed by &&/|| where guarded.
      if (obj === null || obj === undefined) {
        throw new EvalError(`Index access on ${obj === null ? 'null' : 'undefined'} value`, expr);
      }
      // Wrapper-owned bracket dispatch (Item 0.B hook 2, bracket variant).
      // Path is the only wrapper that uses bracket access semantically
      // (`/users/$(uid)`-style binding), but routing every wrapper through
      // `field()` here keeps the contract uniform — wrappers that don't
      // implement bracket access return null.
      if (obj instanceof RulesValue) return obj.field(String(idx));
      // RULES-B2 scope note: DYNAMIC bracket/index access (`data[expr]`) is the
      // documented idiom for "look up a key that may be absent" (e.g. a chess
      // rule's `cfg().paths[from][to]`, `resource.data[squareVar]`). The
      // Firebase docs explicitly confirm the ERROR semantics for DOTTED field
      // access (`resource.data.typo`) — handled in `memberAccess` above — but
      // NOT for dynamic index access, and flagship rules rely on null-on-miss
      // here. Without an emulator to confirm bracket-vs-field divergence, we
      // keep dynamic index access returning null on a missing key (the
      // conservative, non-bug-laundering choice — the disputed-edge STOP).
      // Present-with-null still returns null.
      const key = String(idx);
      return Object.hasOwn(obj as object, key) ? (obj as Record<string, unknown>)[key] : null;
    }

    case 'sliceAccess': {
      // Range slice `obj[start:end]` on a List or String: a sub-list or
      // substring, `end` exclusive. Indices must be integers, and the bounds
      // follow production's checks in `slice-bounds.ts`, shared with the
      // Storage evaluator.
      const [obj, start, end] = evaluateOperands([expr.object, expr.start, expr.end], ctx, scope);
      if (obj === null || obj === undefined) return null;
      if (typeof start !== 'number' || !Number.isInteger(start)) {
        throw new EvalError(`Slice start must be an integer, got ${typeof start}`);
      }
      if (typeof end !== 'number' || !Number.isInteger(end)) {
        throw new EvalError(`Slice end must be an integer, got ${typeof end}`);
      }
      if (typeof obj === 'string' || Array.isArray(obj)) {
        const boundsError = sliceBoundsError(start, end, obj.length);
        if (boundsError) throw new EvalError(boundsError);
        return obj.slice(start, end);
      }
      throw new EvalError(`Slice not supported on ${typeof obj}`);
    }

    case 'inExpr': {
      // List and set elements under Rules value equality, own map keys only,
      // and production's errors for any other operand (`membership.ts`,
      // shared with the Storage evaluator). Production evaluates the
      // collection before the element: when both error, the collection's
      // error is the result.
      const [collection, element] = evaluateOperands([expr.collection, expr.element], ctx, scope);
      const result = membership(element, collection, rulesValuesEqual);
      if (result instanceof MembershipFailure) throw new EvalError(result.message, expr);
      return result;
    }

    case 'isExpr': {
      const value = evaluate(expr.value, ctx, scope);
      switch (expr.typeName) {
        case 'string': return typeof value === 'string';
        // RULES-B5: int and float are DISTINCT types. A bare JS number is an
        // int; a RulesFloat wrapper is a float. `number` matches either.
        // `1.5 is int` → false, `1 is float` → false, `1.0 is float` → true.
        case 'int':
          if (value instanceof RulesValue) return false;
          return typeof value === 'number';
        case 'float':
          return value instanceof RulesFloat;
        case 'number':
          // Reject wrappers that coerce to NaN (LatLng/Path) — they're
          // not numbers even though valueOf() returns a Number. A RulesFloat
          // IS a number, so it must pass here.
          if (value instanceof RulesFloat) return true;
          if (value instanceof RulesValue) return false;
          return typeof value === 'number';
        case 'bool': return typeof value === 'boolean';
        case 'null': return value === null;
        case 'list': return Array.isArray(value);
        case 'set': return value instanceof FirestoreSet;
        case 'map':
          // Wrappers are objects but `is map` should be false for them —
          // a Timestamp is not a Map. Filter via instanceof RulesValue.
          if (value instanceof RulesValue) return false;
          // RULES-B12: MapDiff and FirestoreSet are internal types, not user
          // maps — `someDiff is map` / `someSet is map` must be false.
          if (value instanceof MapDiff || value instanceof FirestoreSet) return false;
          return typeof value === 'object' && value !== null && !Array.isArray(value);
        default:
          // Wrapper type tags ('timestamp', 'duration', 'bytes', 'latlng',
          // 'path') match via typeName. Item 0.B hook 5.
          if (value instanceof RulesValue) return value.typeName === expr.typeName;
          return false;
      }
    }

    case 'listLiteral':
      return evaluateOperands(expr.elements, ctx, scope);

    case 'mapLiteral': {
      const values = evaluateOperands(expr.entries.flatMap((entry) => [entry.key, entry.value]), ctx, scope);
      const map: Record<string, unknown> = {};
      for (let i = 0; i < values.length; i += 2) map[String(values[i])] = values[i + 1];
      return map;
    }

    // ═══ Layer 3: Function calls ═══

    case 'functionCall':
      return evaluateFunctionCall(expr.name, expr.args, ctx, scope);

    // ═══ Layer 4: Method calls ═══

    case 'methodCall':
      return evaluateMethodCall(expr.object, expr.method, expr.args, ctx, scope);

    // ═══ Layer 5: Path literals ═══

    case 'pathLiteral': {
      // Resolve segments — string literals pass through, embedded
      // expressions (`$(uid)`) get evaluated and stringified.
      // Item 5.4: returns Path wrapper instead of raw string so `is path`
      // works. get/exists already String()-coerce, so resolveGet/Exists
      // see the same '/foo/bar' shape via Path.toString().
      // Every embedded expression evaluates when an earlier one errors.
      const parts: string[] = [];
      let error: EvalError | undefined;
      for (const seg of expr.segments) {
        if (typeof seg === 'string') {
          ctx.expressionBudget?.pathSegment();
          parts.push(seg);
        } else {
          try {
            parts.push(String(evaluate(seg, ctx, scope)));
          } catch (e) {
            error = firstError(error, e);
          }
        }
      }
      if (error) throw error;
      return new Path(parts);
    }

    default:
      throw new EvalError(`Unknown expression type: ${(expr as Expression).type}`, expr);
  }
}

// ═══ Identifier resolution ═══

export function resolveIdentifier(name: string, ctx: SimulationContext, scope: Record<string, unknown>): unknown {
  // Local scope first (let bindings, function parameters). A binding whose
  // value errored holds that error, which decides only where it is read.
  if (name in scope) {
    const value = scope[name];
    if (value instanceof EvalError) throw value;
    return value;
  }

  // Path variables
  if (name in ctx.pathVariables) return ctx.pathVariables[name];

  // Built-in globals
  switch (name) {
    case 'request': return ctx.request;
    case 'resource':
      if (ctx.resource === null) throw new EvalError('Null value error.');
      return ctx.resource;
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
  }

  // RULES-B2: an unbound identifier (typo'd variable, undeclared name) is a
  // compile/runtime error in production rules, not a silent `undefined` that
  // later reads as null. Surface it as an EvalError so the handler DENYs and
  // &&/|| can absorb it where guarded.
  throw new EvalError(`Undefined variable '${name}'`);
}

/** True for the built-in top-level globals resolvable as values. Used to
 *  decide whether an unknown method-call target is a possible (unimplemented)
 *  namespace vs a real resolvable identifier. */
export function isKnownGlobal(name: string): boolean {
  return name === 'request' || name === 'resource'
    || name === 'true' || name === 'false' || name === 'null';
}

// ═══ Error values ═══

/**
 * True for an evaluation error production treats as a CEL error value: it
 * flows through operands and bindings and decides the verdict only where it
 * is used. A per-request resource limit ends the request at once, and a
 * simulator gap abstains at once, so neither is a value.
 */
export function isErrorValue(e: unknown): e is EvalError {
  return e instanceof EvalError && !(e instanceof ResourceLimitError) && !(e instanceof UnsupportedError);
}

/** `e` as an error value, rethrowing anything that is not one. */
function asErrorValue(e: unknown): EvalError {
  if (isErrorValue(e)) return e;
  throw e;
}

/**
 * The first of an operand list's errors once `e` is thrown: `first` when an
 * earlier operand errored, else `e`. A resource limit or simulator gap in `e`
 * is rethrown even after an earlier error.
 */
function firstError(first: EvalError | undefined, e: unknown): EvalError {
  const value = asErrorValue(e);
  return first ?? value;
}

/**
 * Evaluate every operand in order and return their values. Production goes on
 * evaluating the operands of a non-logical operator, a literal's elements,
 * and a call's receiver and arguments after one errors, and counts them
 * toward the expression limit; the result is then the first error.
 */
export function evaluateOperands(exprs: readonly Expression[], ctx: SimulationContext, scope: Record<string, unknown>): unknown[] {
  const values = new Array<unknown>(exprs.length);
  let error: EvalError | undefined;
  for (let i = 0; i < exprs.length; i++) {
    try {
      values[i] = evaluate(exprs[i]!, ctx, scope);
    } catch (e) {
      error = firstError(error, e);
    }
  }
  if (error) throw error;
  return values;
}

/**
 * The value a function parameter or `let` binding holds: the evaluated value,
 * or the error value it evaluated to. Production binds the error and runs the
 * function body; reading the binding raises it (see `resolveIdentifier`).
 */
export function evaluateBinding(expr: Expression, ctx: SimulationContext, scope: Record<string, unknown>): unknown {
  try {
    return evaluate(expr, ctx, scope);
  } catch (e) {
    return asErrorValue(e);
  }
}

// ═══ Binary operations with short-circuit ═══

function evaluateShortCircuitOp(
  determiningValue: boolean,
  left: Expression,
  right: Expression,
  ctx: SimulationContext,
  scope: Record<string, unknown>,
): unknown {
  let lv: unknown, lErr: unknown;
  try {
    lv = requireBoolean(evaluate(left, ctx, scope), left);
  } catch (e) {
    lErr = e;
  }
  if (lErr instanceof ResourceLimitError) throw lErr;
  if (lErr === undefined && lv === determiningValue) {
    ctx.trace?.skip(right);
    return determiningValue;
  }

  ctx.expressionBudget?.logicalRight();
  let rv: unknown, rErr: unknown;
  try {
    rv = requireBoolean(evaluate(right, ctx, scope), right);
  } catch (e) {
    rErr = e;
  }
  if (rErr instanceof ResourceLimitError) throw rErr;
  if (rErr === undefined && rv === determiningValue) return determiningValue;
  if (lErr !== undefined) throw lErr;
  if (rErr !== undefined) throw rErr;
  return rv;
}

function evaluateBinaryOp(
  op: string, left: Expression, right: Expression,
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // RULES-B3: && and || are COMMUTATIVE error-absorbing operators in CEL,
  // not plain left-to-right short-circuit. Per the CEL spec: "if any of
  // their operands uniquely determines the result (false for &&, true for
  // ||) the other operand may or may not be evaluated, and if that
  // evaluation produces a runtime error, it will be ignored." So
  // `error && false` → false and `error || true` → true — the error is
  // absorbed by the determining operand regardless of position.
  //
  // We preserve laziness in the no-error path (the determining LHS skips
  // the RHS), and only evaluate the RHS to attempt absorption when the LHS
  // either errored or did not determine the result. If neither operand
  // determines the result and one errored, the error propagates (re-thrown)
  // so the handler DENYs.
  if (op === '&&') return evaluateShortCircuitOp(false, left, right, ctx, scope);
  if (op === '||') return evaluateShortCircuitOp(true, left, right, ctx, scope);

  // Both operands evaluate, and count, when the left one errors; the left
  // error is the result.
  let lv: unknown, rv: unknown, error: EvalError | undefined;
  try {
    lv = evaluate(left, ctx, scope);
  } catch (e) {
    error = asErrorValue(e);
  }
  try {
    rv = evaluate(right, ctx, scope);
  } catch (e) {
    error = firstError(error, e);
  }
  if (error) throw error;

  // Wrapper-aware binary op dispatch (Item 0.B hook 4). Cross-type
  // arithmetic like `Timestamp + Duration → Timestamp` and lexicographic
  // `Bytes < Bytes` are handled here via the wrapper's own `binaryOp`
  // method. NO_OP means the wrapper doesn't claim this op — fall through
  // to the generic numeric switch below.
  //
  // == and != intentionally bypass this hook — they route through
  // rulesValuesEqual above, which already calls the wrapper's
  // `equals()`. Splitting "value equality" from "operator dispatch"
  // keeps each wrapper's contract clean.
  if (op !== '==' && op !== '!=') {
    if (lv instanceof RulesValue) {
      const r = lv.binaryOp(op, rv);
      if (r !== NO_OP) return r;
    }
    // RULES-B5: `int OP float` (bare-number LHS, RulesFloat RHS) must yield a
    // float and preserve operand ORDER (unlike Duration/Timestamp this is a
    // genuinely ordered numeric op for `-`/`/`/`%` and the comparisons). Route
    // it through `RulesFloat(lv).binaryOp(op, rv)` so the result re-tags as a
    // float and `5 / 2.0` does float division (2.5), not int truncation.
    if (typeof lv === 'number' && rv instanceof RulesFloat) {
      const r = new RulesFloat(lv).binaryOp(op, rv);
      if (r !== NO_OP) return r;
    }
    // Right-side dispatch for symmetric/commutative ops only. Avoids
    // surprises like `1 - duration` accidentally reversing semantics.
    if (rv instanceof RulesValue && (op === '+' || op === '*')) {
      const r = rv.binaryOp(op, lv);
      if (r !== NO_OP) return r;
    }
    // Risk 2 (REBUILD_PLAN Item 1.2): if either operand is still a
    // RulesValue at this point, the only remaining path is generic
    // numeric coercion via valueOf(). For LatLng that yields NaN
    // (silent DENY); for Duration/Timestamp/Bytes it would silently
    // drop the type. Both are real type errors in the rule (e.g.
    // `latlng + 1`, `duration > 60`), not sim gaps — surface as
    // EvalError so handler.ts maps to DENY-with-error instead of a
    // misleading "passed but came out false" or "UNSUPPORTED". A string
    // operand is no exception: production has no string + timestamp,
    // string + duration, or string + bytes overload.
    if (lv instanceof RulesValue || rv instanceof RulesValue) {
      throw new EvalError(
        `Operator '${op}' is not defined between ${describeRulesType(lv)} and ${describeRulesType(rv)}`,
      );
    }
  }

  // RULES-B12: ordered comparisons (`< > <= >=`) require both operands to be the
  // SAME comparable type. CEL has no cross-type ordering overload, so `'a' < 1`
  // is an error, not the JS-coerced `false` the bare `as number` casts produced.
  // (Comparable wrappers — Bytes, Timestamp, Duration — were already dispatched
  // via binaryOp above; anything reaching here is a raw number or string.)
  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    const sameComparable =
      (typeof lv === 'number' && typeof rv === 'number') ||
      (typeof lv === 'string' && typeof rv === 'string');
    if (!sameComparable) {
      throw new EvalError(
        `Operator '${op}' is not defined between ${typeof lv} and ${typeof rv}`,
      );
    }
  }

  switch (op) {
    case '==': return lv === rv || rulesValuesEqual(lv, rv);
    case '!=': return !(lv === rv || rulesValuesEqual(lv, rv));
    case '<': return (lv as number) < (rv as number);
    case '>': return (lv as number) > (rv as number);
    case '<=': return (lv as number) <= (rv as number);
    case '>=': return (lv as number) >= (rv as number);
    case '+': {
      // Production's `+` accepts int + int, float + float, string + string,
      // duration + duration, duration + timestamp, and timestamp + duration.
      // Every other pair is "Unsupported operation error", an error value
      // that `&&` and `||` absorb: `'a' + 1` errors rather than coercing,
      // `[1] + [2]` errors rather than concatenating (`list.concat(list)`
      // joins lists), and `'at ' + request.time`, `bytes + bytes`, and
      // `duration + 1` error rather than joining. The float and the
      // duration and timestamp pairs were dispatched above through the
      // wrappers' `binaryOp`, and any other wrapper operand errored there.
      if (typeof lv === 'string' && typeof rv === 'string') return lv + rv;
      if (typeof lv === 'number' && typeof rv === 'number') return lv + rv;
      throw new EvalError(
        `Operator '+' is not defined between ${describeRulesType(lv)} and ${describeRulesType(rv)}`,
      );
    }
    case '-': return (lv as number) - (rv as number);
    case '*': return (lv as number) * (rv as number);
    case '/':
      // RULES-B5: both operands are bare numbers here (= int ÷ int; any float
      // operand was already handled by RulesFloat.binaryOp above). CEL INT64
      // division TRUNCATES toward zero (`10 / 4 == 2`) and ERRORS on a zero
      // divisor (it does NOT yield ±Infinity the way JS / float division does).
      // The EvalError propagates via the tri-state so the rule DENYs.
      if ((rv as number) === 0) {
        throw new EvalError(DIVIDE_BY_ZERO_MESSAGE);
      }
      return Math.trunc((lv as number) / (rv as number));
    case '%':
      // CEL INT64 modulo likewise errors on a zero divisor (JS would give
      // NaN), with the same message as division.
      if ((rv as number) === 0) {
        throw new EvalError(DIVIDE_BY_ZERO_MESSAGE);
      }
      return (lv as number) % (rv as number);
    default: throw new EvalError(`Unknown binary op: ${op}`);
  }
}

/** An `&&`/`||`/`!` operand, a ternary condition, or an allow condition must be a bool. */
export function requireBoolean(value: unknown, expr: Expression): boolean {
  if (typeof value === 'boolean') return value;
  throw new EvalError(`Type error. Received: [${describeRulesType(value)}] Expected: [bool].`, expr);
}
