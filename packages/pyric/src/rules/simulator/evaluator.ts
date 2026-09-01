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
import { RulesValue, NO_OP } from './wrappers/base.js';
import { LatLng } from './wrappers/latlng.js';
import { Duration } from './wrappers/duration.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Bytes } from './wrappers/bytes.js';
import { Path } from './wrappers/path.js';
import { RulesFloat } from './wrappers/float.js';
import { EvalError } from './eval-error.js';
import { LookupBudgetError } from './document-lookups.js';
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
      const cond = requireBoolean(evaluate(expr.condition, ctx, scope), expr.condition);
      return cond ? evaluate(expr.consequent, ctx, scope) : evaluate(expr.alternate, ctx, scope);
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
      const obj = evaluate(expr.object, ctx, scope);
      const idx = evaluate(expr.index, ctx, scope);
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
      // Range slice `obj[start:end]` — Item 4 (REBUILD_PLAN.md).
      // Per type table:
      //   List:   `[i:j]` returns sub-list, j exclusive.
      //   String: `[i:j]` returns substring, j exclusive.
      // Indices must be integers; production rejects non-integer (incl.
      // booleans coerced) so we surface as EvalError → DENY.
      // Production rejects an end index beyond the value's length instead of
      // applying JavaScript's clamping semantics.
      // Negative indices: rejected (CEL doesn't support Python negatives).
      const obj = evaluate(expr.object, ctx, scope);
      const start = evaluate(expr.start, ctx, scope);
      const end = evaluate(expr.end, ctx, scope);
      if (obj === null || obj === undefined) return null;
      if (typeof start !== 'number' || !Number.isInteger(start)) {
        throw new EvalError(`Slice start must be an integer, got ${typeof start}`);
      }
      if (typeof end !== 'number' || !Number.isInteger(end)) {
        throw new EvalError(`Slice end must be an integer, got ${typeof end}`);
      }
      if (start < 0 || end < 0) {
        throw new EvalError(`Slice indices must be non-negative, got [${start}:${end}]`);
      }
      if (typeof obj === 'string' || Array.isArray(obj)) {
        if (end > obj.length) {
          throw new EvalError(`Slice end ${end} exceeds length ${obj.length}`);
        }
        return obj.slice(start, end);
      }
      throw new EvalError(`Slice not supported on ${typeof obj}`);
    }

    case 'inExpr': {
      const element = evaluate(expr.element, ctx, scope);
      const collection = evaluate(expr.collection, ctx, scope);
      if (collection === null || collection === undefined) return false;
      // Use Rules value equality instead of Array.includes so wrapper
      // value-equality applies (Item 0.B hook 6). Without this,
      // `someTimestamp in [t1, t2]` is always false because `===`
      // doesn't see the wrappers as equal even when their contents
      // match. Map-key membership stays as a String() check — keys
      // are always strings in Firestore rules.
      if (Array.isArray(collection)) {
        return collection.some(v => rulesValuesEqual(v, element));
      }
      // RULES-B7: map-key membership must use OWN keys only. `in` walks the JS
      // prototype chain, so `'toString' in resource.data` wrongly returned
      // true (and an `in`-guarded access then leaked the Object method).
      // Object.hasOwn ignores inherited keys, matching Firestore's "the map
      // has no inherited keys" model.
      if (typeof collection === 'object') return Object.hasOwn(collection as object, String(element));
      return false;
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
      return expr.elements.map(e => evaluate(e, ctx, scope));

    case 'mapLiteral': {
      const map: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        const key = String(evaluate(entry.key, ctx, scope));
        map[key] = evaluate(entry.value, ctx, scope);
      }
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
      const parts: string[] = [];
      for (const seg of expr.segments) {
        if (typeof seg === 'string') {
          parts.push(seg);
        } else {
          parts.push(String(evaluate(seg, ctx, scope)));
        }
      }
      return new Path(parts);
    }

    default:
      throw new EvalError(`Unknown expression type: ${(expr as Expression).type}`, expr);
  }
}

// ═══ Identifier resolution ═══

export function resolveIdentifier(name: string, ctx: SimulationContext, scope: Record<string, unknown>): unknown {
  // Local scope first (let bindings, function parameters)
  if (name in scope) return scope[name];

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

// ═══ Binary operations with short-circuit ═══

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
  if (op === '&&') {
    let lv: unknown, lErr: unknown;
    try { lv = requireBoolean(evaluate(left, ctx, scope), left); } catch (e) { lErr = e; }
    // T2.1 — budget exhaustion is a resource-limit failure of the WHOLE
    // evaluation, not a CEL error value: a determining RHS must not absorb
    // it into an ALLOW. Fail closed immediately.
    // TODO(verify-against-capture): confirm production does not absorb the
    // 11th-access error (corpus scenario firestore/get-budget-exceeded).
    if (lErr instanceof LookupBudgetError) throw lErr;
    if (lErr === undefined && lv === false) {
      // LHS is false → determines the result; RHS need not be evaluated.
      ctx.trace?.skip(right);
      return false;
    }
    // LHS errored or was true — RHS may absorb the error (if RHS is false)
    // or determine the truthy result.
    let rv: unknown, rErr: unknown;
    try { rv = requireBoolean(evaluate(right, ctx, scope), right); } catch (e) { rErr = e; }
    if (rErr === undefined && rv === false) return false; // RHS false absorbs any LHS error
    if (lErr !== undefined) throw lErr;           // LHS error not absorbed
    if (rErr !== undefined) throw rErr;           // RHS error, LHS was true
    return rv;
  }
  if (op === '||') {
    let lv: unknown, lErr: unknown;
    try { lv = requireBoolean(evaluate(left, ctx, scope), left); } catch (e) { lErr = e; }
    // T2.1 — see the `&&` branch: lookup-budget exhaustion is not absorbable.
    if (lErr instanceof LookupBudgetError) throw lErr;
    if (lErr === undefined && lv === true) {
      // LHS is true → determines the result; RHS need not be evaluated.
      ctx.trace?.skip(right);
      return true;
    }
    let rv: unknown, rErr: unknown;
    try { rv = requireBoolean(evaluate(right, ctx, scope), right); } catch (e) { rErr = e; }
    if (rErr === undefined && rv === true) return true; // RHS true absorbs any LHS error
    if (lErr !== undefined) throw lErr;          // LHS error not absorbed
    if (rErr !== undefined) throw rErr;          // RHS error, LHS was false
    return rv;
  }

  const lv = evaluate(left, ctx, scope);
  const rv = evaluate(right, ctx, scope);

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
    // misleading "passed but came out false" or "UNSUPPORTED".
    //
    // Exception: `string + wrapper` is documented coercion that flows
    // through `String(rv)` concat in the switch below.
    if (op !== '+' || (typeof lv !== 'string' && typeof rv !== 'string')) {
      if (lv instanceof RulesValue || rv instanceof RulesValue) {
        const lhsType = lv instanceof RulesValue ? lv.typeName : typeof lv;
        const rhsType = rv instanceof RulesValue ? rv.typeName : typeof rv;
        throw new EvalError(
          `Operator '${op}' is not defined between ${lhsType} and ${rhsType}`,
        );
      }
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
      // RULES-B6: CEL `+` has no mixed-type overloads — both operands must be
      // the same type. Allowed: string+string, number+number, list+list (concat).
      // `'a' + 1` is an error (no string+int overload), not the silent
      // `String(rv)` coercion the old impl did. (Wrapper `+` like
      // Timestamp+Duration was already handled above via binaryOp dispatch;
      // the documented `string + wrapper` affordance also flows above this.)
      if (Array.isArray(lv) && Array.isArray(rv)) return [...lv, ...rv];
      if (typeof lv === 'string' && typeof rv === 'string') return lv + rv;
      if (typeof lv === 'number' && typeof rv === 'number') return lv + rv;
      // Documented sim affordance (see the `op !== '+'` guard above): a
      // `string + wrapper` (e.g. `'at ' + request.time`) concatenates the
      // wrapper's string form. Preserved here for back-compat with that path.
      if (typeof lv === 'string' && rv instanceof RulesValue) return lv + String(rv);
      throw new EvalError(
        `Operator '+' is not defined between ${Array.isArray(lv) ? 'list' : typeof lv} and ${Array.isArray(rv) ? 'list' : typeof rv}`,
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
        throw new EvalError('Division by zero');
      }
      return Math.trunc((lv as number) / (rv as number));
    case '%':
      // CEL INT64 modulo likewise errors on a zero divisor (JS would give NaN).
      if ((rv as number) === 0) {
        throw new EvalError('Modulo by zero');
      }
      return (lv as number) % (rv as number);
    default: throw new EvalError(`Unknown binary op: ${op}`);
  }
}

function requireBoolean(value: unknown, expr: Expression): boolean {
  if (typeof value === 'boolean') return value;
  throw new EvalError(
    `Expected a boolean control-flow operand, got ${value === null ? 'null' : typeof value}`,
    expr,
  );
}
