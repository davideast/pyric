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
import { assembleExpression } from '../grammar/FirestoreAssembler.js';
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
import { md5 as md5Bytes } from 'js-md5';
import { sha256 as sha256Bytes } from 'js-sha256';

// ═══ Simulation Context ═══

export interface SimAuth {
  uid: string;
  token: Record<string, unknown>;
}

export interface SimRequest {
  auth: SimAuth | null;
  resource: { data: Record<string, unknown> };
  method: string;
  // Item 6: request.path is a Path wrapper (was string). The full document
  // path including /databases/(default)/documents prefix.
  path: Path;
  // Item 6: request.query is the projection/limit map for `list` operations.
  // Empty {} for non-list methods. Production exposes limit/offset/orderBy;
  // we model as a plain map and defer field-level coverage until a real
  // rule references it (most rules don't).
  query: Record<string, unknown>;
  time: Timestamp; // request.time as Timestamp wrapper (Item 1.3 flip — was ISO string)
}

// A document value in rules: `data` plus, WHERE PRODUCTION EXPOSES IT, the
// document identity.
//
// RULES-B12 — resource identity is NOT synthesized for the request target.
// Production's Rules Test API builds `resource` (and `request.resource`) from
// the caller-supplied document alone: the object carries the keys it was given
// and nothing more. It does NOT derive `id`/`__name__` from the request path.
// Reading an absent one is a runtime ERROR, verbatim:
//   "Property id is undefined on object."
//   "Property __name__ is undefined on object."
// which absorbs to DENY, survives negation (`resource.id != 'x'` DENIES —
// the error propagates rather than yielding `true`), and is absorbed only by
// a determining `||` operand. Synthesizing an id/__name__ here — the previous
// behavior for get/list/update/delete — made `resource.id == id` ALLOW where
// production DENIES: an OVER-PERMISSIVE divergence, the dangerous direction.
//
// `id`/`__name__` are therefore OPTIONAL. The request-target `resource` omits
// them (absent → the evaluator's absent-key error → DENY, matching prod). The
// value returned by `get()`/`getAfter()` still carries them; that synthesis is
// a separate, already-documented divergence (firestore-rules#165).
export interface SimResource {
  data: Record<string, unknown>;
  id?: string;
  __name__?: Path;
}

export interface SimulationContext {
  request: SimRequest;
  /**
   * The PRE-WRITE stored document (data + identity), or `null` when no such
   * document exists. On a `create` the target does not exist yet, so this is
   * null and any access (`resource.data`, `resource.id`, `resource.__name__`)
   * errors → DENY, matching production. `request.resource` (the INCOMING
   * proposed data) is a separate value and is populated on create/update.
   */
  resource: SimResource | null;
  /** Mock documents for get()/exists() calls, keyed by full path. Pre-seeded
   *  from `functionMocks` (the serializable Test API path) and/or populated
   *  lazily by {@link getDoc}. */
  mockDocuments: Map<string, Record<string, unknown>>;
  /** Lazy fault-in resolver. When a get()/exists() path misses
   *  {@link mockDocuments}, the evaluator resolves it through this (the DocStore
   *  point-read) and memoizes the result into mockDocuments. Lets the sandbox
   *  avoid dumping the whole keyspace into every simulate(); naturally transitive
   *  for data-dependent get() chains, since the inner get() faults its doc in
   *  before the outer path string is built. */
  getDoc?: (path: string) => Record<string, unknown> | null;
  /** Path variable bindings from match block, e.g. { gameId: 'game1' } */
  pathVariables: Record<string, string>;
  /** Function definitions available in scope */
  functions: Map<string, FunctionDef>;
  /** Database name for path resolution */
  database: string;
  // Item 7 — getAfter()/existsAfter() data plumbing.
  //
  // afterStatePath is the full Path of the document being written. When
  // getAfter()/existsAfter() are called with this exact path, they return
  // the projected post-write state (or null + false for delete). For any
  // other path, they fall through to get()/exists() — unrelated docs
  // aren't mutated by the write under evaluation.
  afterStatePath: Path;
  afterState: Record<string, unknown> | null;
  existsAfter: boolean;
  /**
   * Batch/transaction sibling-write projection (getafter-batch fix).
   *
   * `afterState`/`afterStatePath` above only describe the ONE document
   * this simulate() call is evaluating a rule for. In production,
   * `getAfter(path)` sees the post-commit state of the ENTIRE atomic
   * batch/transaction, not just the current write — a rule on doc A can
   * read what doc B will become once the whole batch lands. Callers that
   * evaluate a multi-op batch/transaction build ONE projected map up
   * front (normalized relative path → post-write data, or `null` for a
   * doc the batch deletes) covering every op in the group, and pass the
   * SAME map into every per-op simulate() call. Keyed the same way as
   * `mockDocuments` (normalized relative path, no `/databases/.../documents/`
   * prefix). A path absent from this map was not written by the batch —
   * `getAfter` on it falls through to `get()` (current committed data),
   * matching production. Single-op writes (execute()) omit this map
   * entirely, so `getAfter` on any path but the op's own target falls
   * through to `get()` exactly as before.
   */
  batchProjection?: Map<string, Record<string, unknown> | null>;
  /** Optional per-rule expression-trace recorder. When set, the evaluator
   *  wraps every `evaluate()` call and records the sub-expression tree;
   *  when absent (the default), the evaluator is unchanged. The handler
   *  attaches a fresh recorder per allow-rule evaluation so each
   *  `RuleEvaluation.expressionTrace` is independent. */
  trace?: TraceRecorder;
}

// ═══ Evaluation errors ═══

export class EvalError extends Error {
  constructor(message: string, public expr?: Expression) {
    super(message);
    this.name = 'EvalError';
  }
}

/**
 * Thrown when the simulator encounters a feature it doesn't yet implement
 * (an unknown built-in function, namespace method, or method on a wrapper
 * type we haven't added). Distinct from EvalError so the handler can map it
 * to TestResult.state = 'UNSUPPORTED' instead of a silent DENY — that way
 * agents see "sim abstained" rather than "your rule is wrong" when the gap
 * is on our side. See REBUILD_PLAN.md Item 0.A.
 */
export class UnsupportedError extends EvalError {
  constructor(message: string, expr?: Expression) {
    super(message, expr);
    this.name = 'UnsupportedError';
  }
}

// ═══ Expression trace ═══

/**
 * One entry in the per-rule expression trace recorded by `TraceRecorder`.
 *
 * Trace entries are emitted in evaluation order. The tree shape is
 * reconstructable via `parent`: root entries have `parent: null`, and
 * each child entry's `parent` is the array index of its evaluating
 * ancestor. This is denser than nested objects for transport (a tool
 * call returns a single flat array) and easier for the agent to scan
 * top-to-bottom.
 *
 * `value` carries the evaluation result. For nodes that threw, see
 * `error`; for short-circuit skips, `skipped: true` is set instead.
 */
export interface ExprTraceEntry {
  /** Pretty-printed source of the expression (via `assembleExpression`). */
  source: string;
  /** AST node type — useful for filtering by structural kind. */
  kind: Expression['type'];
  /** Index of the parent entry in the trace array; null at the root. */
  parent: number | null;
  /** Evaluation result. Undefined when `skipped` or `error` is set. */
  value?: unknown;
  /** True for an `&&` / `||` operand that was *not* evaluated due to
   *  short-circuit. The recorder emits a placeholder entry so the trace
   *  shape mirrors the surface AST. */
  skipped?: boolean;
  /** Error message when the expression threw. The wrapper still re-throws;
   *  this captures the diagnostic for the caller. */
  error?: string;
  /** Set on entries that record a `let` binding evaluation inside a
   *  user-defined function. `value` holds the bound value. */
  letBinding?: { name: string };
  /** Set on entries recorded *inside* a user-defined function's body
   *  (after parameter binding). Carries the enclosing function's name
   *  so the agent can filter the trace by frame —
   *  `entries.filter(e => e.inlinedFrom?.name === 'isOwner')` — without
   *  walking the parent chain to find the surrounding `functionCall`.
   *
   *  Parameter expressions are *not* tagged: they evaluate in the
   *  caller's scope, before the frame is entered. The `functionCall`
   *  entry itself is recorded in the caller's frame too, so a
   *  top-level `isOwner()` shows `inlinedFrom: undefined` on the
   *  `functionCall`, but `'isOwner'` on its body children. */
  inlinedFrom?: { name: string };
}

/**
 * Records every sub-expression evaluation. Attach to a
 * `SimulationContext.trace` to enable; the evaluator no-ops when absent
 * so unsentinel'd callers pay zero cost.
 *
 * Recording strategy: each call to `evaluate(expr, ...)` is wrapped via
 * `capture(expr, fn)`, which reserves a slot in `entries` (assigning
 * `parent` from the current stack), pushes the slot index, invokes
 * `fn`, then unwinds. This keeps recursion in the existing evaluator
 * paths working unchanged — the wrapper sits on top.
 */
export class TraceRecorder {
  readonly entries: ExprTraceEntry[] = [];
  private parents: number[] = [];
  /** Stack of enclosing user-defined function names. The top of stack is
   *  stamped onto each pushed entry as `inlinedFrom`. Independent of the
   *  `parents` stack because parameter expressions evaluate inside the
   *  capture stack but *outside* the function frame. */
  private frames: string[] = [];

  capture<T>(expr: Expression, fn: () => T): T {
    const index = this.entries.length;
    const parent = this.parents.length > 0 ? this.parents[this.parents.length - 1] : null;
    // Reserve the slot first so any child evaluations point at us as
    // their parent. The `value` field is filled in after `fn()` runs.
    const entry: ExprTraceEntry = { source: assembleExpression(expr), kind: expr.type, parent };
    this.stampFrame(entry);
    this.entries.push(entry);
    this.parents.push(index);
    try {
      const value = fn();
      this.entries[index].value = value;
      return value;
    } catch (e) {
      this.entries[index].error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.parents.pop();
    }
  }

  /** Record an operand the evaluator skipped because the LHS short-circuited.
   *  Emits an entry under the *current* parent so the trace tree mirrors
   *  the source AST (skip placeholder is a sibling of the LHS, not nested). */
  skip(expr: Expression): void {
    const parent = this.parents.length > 0 ? this.parents[this.parents.length - 1] : null;
    const entry: ExprTraceEntry = {
      source: assembleExpression(expr),
      kind: expr.type,
      parent,
      skipped: true,
    };
    this.stampFrame(entry);
    this.entries.push(entry);
  }

  /** Push a user-defined function frame onto the inlinedFrom stack.
   *  Returns the popped value of the previous top (currently unused —
   *  callers pair `enterFrame` with `exitFrame()` via the stack, not a
   *  saved token — but keeping a return value lets future code switch
   *  to a save/restore idiom without API churn). */
  enterFrame(name: string): void {
    this.frames.push(name);
  }

  /** Pop the topmost frame. Safe to call on an empty stack — no-ops. */
  exitFrame(): void {
    this.frames.pop();
  }

  private stampFrame(entry: ExprTraceEntry): void {
    if (this.frames.length === 0) return;
    entry.inlinedFrom = { name: this.frames[this.frames.length - 1] };
  }

  /** Annotate the entry at `index` as a `let` binding — the value was
   *  bound to `name` in scope. Called from `evaluateFunctionCall` after
   *  each `let <name> = <expr>` line; the index is the binding root's
   *  position in the trace (`entries.length` captured BEFORE the call).
   *  Using a stable index instead of "last entry" is necessary because
   *  the binding's expression may have recursive children — the most
   *  recently pushed entry is the deepest leaf, not the root. */
  markEntryAsLetBinding(index: number, name: string): void {
    if (index < 0 || index >= this.entries.length) return;
    this.entries[index].letBinding = { name };
  }
}

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
      if (expr.op === '!') return !evaluate(expr.operand, ctx, scope);
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
      const cond = evaluate(expr.condition, ctx, scope);
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
      // Out-of-bounds: clamp to [0, length] (matches JS Array.slice and
      // is the standard CEL-style semantics — locked in by parity scenario).
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
      if (typeof obj === 'string') return obj.slice(start, end);
      if (Array.isArray(obj)) return obj.slice(start, end);
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

function resolveIdentifier(name: string, ctx: SimulationContext, scope: Record<string, unknown>): unknown {
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
function isKnownGlobal(name: string): boolean {
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
    try { lv = evaluate(left, ctx, scope); } catch (e) { lErr = e; }
    if (lErr === undefined && !lv) {
      // LHS is false → determines the result; RHS need not be evaluated.
      ctx.trace?.skip(right);
      return false;
    }
    // LHS errored or was true — RHS may absorb the error (if RHS is false)
    // or determine the truthy result.
    let rv: unknown, rErr: unknown;
    try { rv = evaluate(right, ctx, scope); } catch (e) { rErr = e; }
    if (rErr === undefined && !rv) return false; // RHS false absorbs any LHS error
    if (lErr !== undefined) throw lErr;           // LHS error not absorbed
    if (rErr !== undefined) throw rErr;           // RHS error, LHS was true
    return !!rv;
  }
  if (op === '||') {
    let lv: unknown, lErr: unknown;
    try { lv = evaluate(left, ctx, scope); } catch (e) { lErr = e; }
    if (lErr === undefined && lv) {
      // LHS is true → determines the result; RHS need not be evaluated.
      ctx.trace?.skip(right);
      return true;
    }
    let rv: unknown, rErr: unknown;
    try { rv = evaluate(right, ctx, scope); } catch (e) { rErr = e; }
    if (rErr === undefined && rv) return true; // RHS true absorbs any LHS error
    if (lErr !== undefined) throw lErr;          // LHS error not absorbed
    if (rErr !== undefined) throw rErr;          // RHS error, LHS was false
    return !!rv;
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

// ═══ Type-conversion builtins (RULES-B5 / RULES-B6) ═══
//
// CEL's int()/float()/bool() conversions are STRICT — they error on inputs
// that JS would silently coerce. The pre-fix impl used `parseInt` (which
// grabs a leading numeric prefix, so `int('12abc')` → 12) and `Boolean`
// (truthiness, so `bool('false')` → true). Both diverge from prod, which
// rejects a malformed string outright. Docs: rules.Integer / rules.Float /
// rules.Boolean (string converters require a fully-valid literal).

/** `int(x)` — truncate a number/float, parse a strict-integer string, or 0/1 a bool. */
function rulesInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (v instanceof RulesFloat) return Math.trunc(v.value);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    // CEL parses the WHOLE string as an integer; a trailing non-digit (or any
    // float/garbage) is an error, not a salvaged prefix like parseInt gives.
    if (/^[+-]?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    throw new EvalError(`int() cannot convert string '${v}' to an integer`);
  }
  throw new EvalError(`int() cannot convert ${typeof v} to an integer`);
}

/** `float(x)` — produce a FLOAT (tagged) from a number, float, or numeric string. */
function rulesFloatBuiltin(v: unknown): RulesFloat {
  if (v instanceof RulesFloat) return v;
  if (typeof v === 'number') return new RulesFloat(v);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    // Strict numeric form (optional sign, digits, optional fraction). Rejects
    // `'1.2.3'`, `'abc'`, trailing junk — all errors in prod.
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return new RulesFloat(parseFloat(trimmed));
    throw new EvalError(`float() cannot convert string '${v}' to a float`);
  }
  throw new EvalError(`float() cannot convert ${typeof v} to a float`);
}

/** `bool(x)` — pass a bool through; parse only the exact strings 'true'/'false'. */
function rulesBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new EvalError(`bool() cannot convert string '${v}' to a boolean`);
  }
  throw new EvalError(`bool() cannot convert ${typeof v} to a boolean`);
}

// ═══ Function calls ═══

function evaluateFunctionCall(
  name: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // Built-in functions
  switch (name) {
    case 'get': {
      const path = String(evaluate(args[0], ctx, scope));
      return resolveGet(path, ctx);
    }
    case 'exists': {
      const path = String(evaluate(args[0], ctx, scope));
      return resolveExists(path, ctx);
    }
    case 'getAfter': {
      // Item 7 — projected post-write state.
      // For the document being written (matches request.path), return the
      // afterState. getafter-batch fix: for a SIBLING doc written earlier
      // (or later) in the same atomic batch/transaction, consult the
      // shared batchProjection map so the rule sees that write too — matches
      // production, where getAfter() reflects the whole batch's post-commit
      // state, not just the current op. Only once neither applies do we
      // fall through to get() (current committed data) for a doc the batch
      // doesn't touch.
      const argVal = evaluate(args[0], ctx, scope);
      const pathStr = String(argVal);
      if (pathStr === ctx.afterStatePath.toString()) {
        // RULES-B8: getAfter() of a doc that won't exist post-write (delete,
        // or projected-null) ERRORS like get() — guard with existsAfter().
        if (ctx.afterState === null) {
          throw new EvalError(`getAfter() of non-existent document '${pathStr}' (guard with existsAfter() first)`);
        }
        return makeGetResource(normalizePath(pathStr, ctx), ctx.afterState);
      }
      const normalized = normalizePath(pathStr, ctx);
      if (ctx.batchProjection?.has(normalized)) {
        const projected = ctx.batchProjection.get(normalized)!;
        if (projected === null) {
          throw new EvalError(`getAfter() of non-existent document '${pathStr}' (guard with existsAfter() first)`);
        }
        return makeGetResource(normalized, projected);
      }
      return resolveGet(pathStr, ctx);
    }
    case 'existsAfter': {
      // Item 7 — projected existence after the write.
      // Same dispatch shape as getAfter: target path uses ctx.existsAfter,
      // sibling batch writes consult batchProjection, other paths fall
      // through to exists().
      const argVal = evaluate(args[0], ctx, scope);
      const pathStr = String(argVal);
      if (pathStr === ctx.afterStatePath.toString()) {
        return ctx.existsAfter;
      }
      const normalized = normalizePath(pathStr, ctx);
      if (ctx.batchProjection?.has(normalized)) {
        return ctx.batchProjection.get(normalized) !== null;
      }
      return resolveExists(pathStr, ctx);
    }
    case 'debug': {
      const val = evaluate(args[0], ctx, scope);
      return val; // debug() returns its argument
    }
    // RULES-B5 / RULES-B6: type-conversion builtins follow CEL's strict
    // semantics, not JS coercion. `String()` routes a RulesFloat through its
    // `.toString()` so `string(1.0)` → "1.0" (decimal preserved); bare ints
    // and other types stringify normally.
    case 'string': return String(evaluate(args[0], ctx, scope));
    case 'int': return rulesInt(evaluate(args[0], ctx, scope));
    case 'float': return rulesFloatBuiltin(evaluate(args[0], ctx, scope));
    case 'bool': return rulesBool(evaluate(args[0], ctx, scope));
    case 'path': {
      // Item 5.4 — `path('users/alice')` returns a Path wrapper. Accepts
      // strings or existing Paths (idempotent). Other inputs throw —
      // mismatched argument is a real type error in the rule.
      const arg = evaluate(args[0], ctx, scope);
      if (arg instanceof Path) return arg;
      if (typeof arg === 'string') return Path.fromString(arg);
      throw new EvalError(`path() requires a string argument, got ${typeof arg}`);
    }
  }

  // User-defined functions
  const fn = ctx.functions.get(name);
  if (!fn) throw new UnsupportedError(`Unknown function: ${name}`);

  // Bind parameters — parameter expressions evaluate in the CALLER's
  // scope and frame. We push the inlinedFrom frame *after* this loop
  // so parameter traces stay attributed to the caller (where the
  // argument expression literally lives in source).
  const fnScope: Record<string, unknown> = { ...scope };
  for (let i = 0; i < fn.parameters.length; i++) {
    fnScope[fn.parameters[i]] = evaluate(args[i], ctx, scope);
  }

  // Push frame for let bindings + body so their trace entries get
  // tagged `inlinedFrom: { name }`. try/finally so an evaluation
  // error still pops the frame and doesn't pollute sibling rules.
  ctx.trace?.enterFrame(name);
  try {
    // Evaluate let bindings. Capture the trace entries' next-write
    // position BEFORE the binding's expression evaluates — that slot
    // will be the binding-root entry (recursive children land below
    // it). After the evaluate returns, tag that root slot with the
    // bound name so the agent can attribute "this subtree was the
    // value of `<name>`" without re-walking the function AST.
    for (const binding of fn.lets) {
      const bindingRootIdx = ctx.trace ? ctx.trace.entries.length : -1;
      fnScope[binding.name] = evaluate(binding.value, ctx, fnScope);
      if (bindingRootIdx >= 0) {
        ctx.trace?.markEntryAsLetBinding(bindingRootIdx, binding.name);
      }
    }

    // Evaluate body
    return evaluate(fn.body, ctx, fnScope);
  } finally {
    ctx.trace?.exitFrame();
  }
}

// ═══ Method calls ═══

function evaluateMethodCall(
  objectExpr: Expression, method: string, args: Expression[],
  ctx: SimulationContext, scope: Record<string, unknown>,
): unknown {
  // Built-in namespaces (math, timestamp, duration) are not first-class
  // values — they exist only as method-call targets. Dispatch them before
  // calling evaluate(objectExpr), which would resolve the identifier to
  // undefined and fall through to "Unknown method on undefined".
  // Skip the dispatch if the namespace name is shadowed by a local binding
  // or path variable.
  if (objectExpr.type === 'identifier') {
    const name = objectExpr.name;
    if (isBuiltinNamespace(name) && !(name in scope) && !(name in ctx.pathVariables)) {
      const argValues = args.map(a => evaluate(a, ctx, scope));
      return evaluateNamespaceMethod(name, method, argValues);
    }
    // RULES-B2 interaction: an UNKNOWN bare identifier used as a method-call
    // target (e.g. `foo.bar()`) is most likely a namespace the simulator
    // hasn't implemented, not a typo'd value. Resolving it as a value now
    // throws "Undefined variable" (RULES-B2), but we want the agent-facing
    // UNSUPPORTED signal ("sim gap") here rather than a hard ERROR — that's
    // the deliberate affordance the old `undefined.method()` path provided.
    // (Bare `foo` used as a VALUE still errors via resolveIdentifier; only the
    // method-call-target case is lifted to UNSUPPORTED.)
    if (
      !isBuiltinNamespace(name)
      && !(name in scope)
      && !(name in ctx.pathVariables)
      && !isKnownGlobal(name)
    ) {
      throw new UnsupportedError(`Unknown namespace or method '${name}.${method}()'`);
    }
  }

  const obj = evaluate(objectExpr, ctx, scope);
  const argValues = args.map(a => evaluate(a, ctx, scope));

  // RulesValue method dispatch (Item 0.B hook 3). Placed above MapDiff /
  // FirestoreSet / Map / Array / String branches because every wrapper
  // is also `typeof === 'object'` — without this short-circuit, a
  // Timestamp would fall into the Map branch and dispatch `.size()` on
  // its private `{seconds, nanos}` shape. NO_OP from the wrapper means
  // "I don't have this method" → UnsupportedError, which the handler
  // maps to TestResult.state = 'UNSUPPORTED' (Item 0.A) so agents see
  // a sim gap rather than a silent DENY.
  if (obj instanceof RulesValue) {
    const result = obj.callMethod(method, argValues);
    if (result === NO_OP) {
      throw new UnsupportedError(`Unknown method '${method}' on ${obj.typeName}`);
    }
    return result;
  }

  // MapDiff: obj.diff(other) → MapDiff
  if (method === 'diff' && typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const other = argValues[0];
    if (typeof other === 'object' && other !== null) {
      return new MapDiff(other as Record<string, unknown>, obj as Record<string, unknown>);
    }
    throw new EvalError('diff() requires a map argument');
  }

  // Callable methods (from memberAccess returning a function)
  if (typeof obj === 'function') {
    return (obj as Function)(...argValues);
  }

  // FirestoreSet methods
  if (obj instanceof FirestoreSet) {
    switch (method) {
      case 'hasOnly': return obj.hasOnly(argValues[0] as string[] | FirestoreSet);
      case 'hasAll': return obj.hasAll(argValues[0] as string[] | FirestoreSet);
      case 'hasAny': return obj.hasAny(argValues[0] as string[] | FirestoreSet);
      case 'size': return obj.size();
      // Set.difference/union/intersection: the sim CAN compute these (see
      // FirestoreSet.difference/union/intersection), but oracle capture
      // shows production denies every call that reaches them — these
      // methods don't behave as modeled in the real Firestore Rules CEL
      // dialect (see triage: set-algebra-difference-union-intersection /
      // list-methods-concat-removeall-toset scenarios, both false-ALLOW
      // against a prod DENY). Abstain rather than emit a confident wrong
      // verdict; do not "fix" this by re-deriving semantics without a
      // fresh oracle capture that actually isolates correct behavior.
      case 'difference':
      case 'union':
      case 'intersection':
        throw new UnsupportedError(
          `Set.${method}() is not faithfully modeled by the simulator (oracle capture shows production denies calls that reach it) — abstaining rather than guessing`,
        );
    }
  }

  // MapDiff methods (when called directly, not via memberAccess)
  if (obj instanceof MapDiff) {
    switch (method) {
      case 'addedKeys': return obj.addedKeys();
      case 'removedKeys': return obj.removedKeys();
      case 'changedKeys': return obj.changedKeys();
      case 'affectedKeys': return obj.affectedKeys();
      case 'unchangedKeys': return obj.unchangedKeys();
    }
  }

  // Map/object methods
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const map = obj as Record<string, unknown>;
    switch (method) {
      case 'keys': return new FirestoreSet(Object.keys(map));
      case 'values': return Object.values(map);
      case 'size': return Object.keys(map).length;
      // RULES-B7: key checks use OWN keys only (no prototype-chain leak).
      case 'hasAll': return (argValues[0] as string[]).every(k => Object.hasOwn(map, k));
      case 'hasAny': return (argValues[0] as string[]).some(k => Object.hasOwn(map, k));
      case 'hasOnly': return Object.keys(map).every(k => (argValues[0] as string[]).includes(k));
      case 'diff': {
        const other = argValues[0] as Record<string, unknown>;
        return new MapDiff(other, map);
      }
      case 'get': {
        // Map.get(key, default) — Item 3 (REBUILD_PLAN.md).
        // Two forms (production behavior locked in by 0.H parity probe):
        //   m.get('a', default)           → m.a if present, else default
        //   m.get(['a','b','c'], default) → m.a.b.c if full walk succeeds, else default
        // Production *always* returns default on any walk failure (missing
        // key, non-map intermediate, etc.). It does NOT distinguish "key
        // missing" from "intermediate missing" — both collapse to default.
        // An explicit `null` value at the leaf is returned as null (not
        // default), since the key is present.
        const keyArg = argValues[0];
        const def = argValues[1];
        if (Array.isArray(keyArg)) {
          // List-form nested traversal
          let cur: unknown = map;
          for (const seg of keyArg) {
            if (cur === null || cur === undefined) return def;
            // Cannot descend into non-maps (string, number, list, wrapper).
            // Probe scenarios list_form_mid_is_string / list_form_mid_is_int
            // confirmed prod returns default in these cases.
            if (typeof cur !== 'object' || Array.isArray(cur) || cur instanceof RulesValue) return def;
            const k = String(seg);
            if (!Object.hasOwn(cur as object, k)) return def; // RULES-B7: own keys only
            cur = (cur as Record<string, unknown>)[k];
          }
          return cur;
        }
        // Single-key form
        const k = String(keyArg);
        return Object.hasOwn(map, k) ? map[k] : def; // RULES-B7: own keys only
      }
    }
  }

  // List methods
  if (Array.isArray(obj)) {
    switch (method) {
      case 'size': return obj.length;
      // RULES-B9: list membership uses VALUE equality, not JS identity, so it
      // is consistent with `in` / `removeAll` (which already use
      // rulesValuesEqual). Without this, `[t1].hasAll([t2])` for equal-valued
      // Timestamp/Bytes/Path wrappers wrongly returned false because the two
      // instances aren't `===`.
      case 'hasAll': return (argValues[0] as unknown[]).every(v => obj.some(o => rulesValuesEqual(o, v)));
      case 'hasAny': return (argValues[0] as unknown[]).some(v => obj.some(o => rulesValuesEqual(o, v)));
      case 'hasOnly': {
        const allowed = argValues[0] as unknown[];
        return obj.every(v => allowed.some(o => rulesValuesEqual(o, v)));
      }
      case 'join': return obj.join(String(argValues[0] ?? ','));
      // ─── Item 5.2: List.concat / removeAll / toSet ─────────────────────
      case 'concat': {
        const other = argValues[0];
        if (!Array.isArray(other)) {
          throw new EvalError(`List.concat requires a list argument, got ${typeof other}`);
        }
        return [...obj, ...other];
      }
      case 'removeAll': {
        // Returns a new list with all items from `other` removed (by value
        // equality). Uses rulesValuesEqual so wrapper instances (Timestamp,
        // Duration, etc.) compare by value, not by JS identity — without
        // this, `[t1].removeAll([t2])` where t1 and t2 are equal Timestamp
        // wrappers would not remove t1.
        const other = argValues[0];
        if (!Array.isArray(other)) {
          throw new EvalError(`List.removeAll requires a list argument, got ${typeof other}`);
        }
        return obj.filter(v => !other.some(o => rulesValuesEqual(v, o)));
      }
      case 'toSet': {
        // Convert to FirestoreSet. The class stores strings only — coerce
        // via String() on each element. This is sufficient for the common
        // case of `[]Doc.tags.toSet()`-style usage where the source list
        // is already strings. Non-string elements (numbers, booleans) get
        // String()-coerced and may collapse onto each other (1 and '1'
        // become the same set member). Locked-in behavior is whatever the
        // parity scenario confirms; if prod diverges we revisit.
        return new FirestoreSet(obj.map(v => String(v)));
      }
    }
  }

  // String methods
  if (typeof obj === 'string') {
    switch (method) {
      case 'size': return obj.length;
      case 'lower': return obj.toLowerCase();
      case 'upper': return obj.toUpperCase();
      case 'trim': return obj.trim();
      // RULES-B4: split()/matches()/replace() take RE2 *regular expressions*
      // and matches() is a FULL-STRING (anchored) test — production: "returns
      // true if the whole string matches the regex". The previous impl used a
      // partial JS `.test()`, a literal-string `split`, and a first-only
      // `replace`. We compile via the JS RegExp engine (RE2 and JS share the
      // common subset used by rules; exotic RE2-only constructs are a noted
      // limitation, not a behavior divergence for the documented cases) and
      // anchor matches() with `^(?:…)$`, apply `g` to replace/split.
      case 'split': return obj.split(compileRulesRegex(String(argValues[0]), 'g'));
      case 'matches':
        return compileRulesRegex(`^(?:${String(argValues[0])})$`).test(obj);
      case 'replace':
        return obj.replace(compileRulesRegex(String(argValues[0]), 'g'), String(argValues[1]));
      case 'toUtf8': return Bytes.fromUtf8(obj); // Item 5.3 — only producer of Bytes from a literal.
    }
  }

  throw new UnsupportedError(`Unknown method '${method}' on ${typeof obj}`);
}

/**
 * Compile a Firestore-rules regex (RULES-B4). Rules regexes follow RE2
 * syntax; we use the JS RegExp engine, which shares the common subset rules
 * actually use. A pattern the engine can't compile is a real type error in
 * the rule (not a sim gap) → EvalError so the handler DENYs, matching
 * production's "invalid regex → error" behavior.
 */
function compileRulesRegex(pattern: string, flags = ''): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new EvalError(`Invalid regex '${pattern}': ${(e as Error).message}`);
  }
}

// ═══ Built-in namespaces (math, timestamp, duration) ═══
//
// Production parity: these used to throw via the "Unknown method on
// undefined" path because the identifiers `math` / `timestamp` / `duration`
// resolve to undefined. The throw was caught by handler.ts and counted as
// deny — silently denying every ALLOW case that touched a math/time
// built-in. Confirmed by parity-stress-integration.test.ts (Scenario 1).
//
// We model timestamp values and duration values as plain numbers
// (milliseconds since epoch and milliseconds, respectively). That lets
// JavaScript's `<`, `>`, `<=`, `>=`, `+`, `-` work without a wrapper
// class. This is sufficient for any rule whose timestamp/duration values
// originate from the namespace built-ins themselves.

const BUILTIN_NAMESPACES = new Set(['math', 'timestamp', 'duration', 'latlng', 'hashing']);

function isBuiltinNamespace(name: string): boolean {
  return BUILTIN_NAMESPACES.has(name);
}

function evaluateNamespaceMethod(ns: string, method: string, args: unknown[]): unknown {
  // RULES-B5: the numeric namespaces (math/latlng/timestamp/duration) operate
  // on the underlying double — `latlng.value(37.7, ...)` or `math.ceil(1.5)`
  // doesn't care whether the arg was written as an int or a float literal, and
  // the constructors store bare numbers. Unwrap RulesFloat args to their raw
  // value so `args[0] as number` casts inside each handler stay valid (a
  // RulesFloat is otherwise an object, breaking `latlng.value` equality etc.).
  // hashing.* takes Bytes/String — no numeric args — so it's left untouched.
  const a = ns === 'hashing' ? args : args.map(unwrapFloat);
  switch (ns) {
    case 'math': return evaluateMathMethod(method, a);
    case 'timestamp': return evaluateTimestampMethod(method, a);
    case 'duration': return evaluateDurationMethod(method, a);
    case 'latlng': return evaluateLatLngMethod(method, a);
    case 'hashing': return evaluateHashingMethod(method, args);
  }
  throw new UnsupportedError(`Unknown namespace '${ns}'`);
}

/** RULES-B5: collapse a RulesFloat to its raw double; pass everything else through. */
function unwrapFloat(v: unknown): unknown {
  return v instanceof RulesFloat ? v.value : v;
}

// ─── hashing.* (Item 5.3) ───────────────────────────────────────────────
//
// Per docs (rules.hashing): crc32, crc32c, md5, sha256.
// All accept Bytes | String; strings are hashed as UTF-8 bytes.
// All return Bytes (round-trips with Bytes.toBase64() / .toHexString()).
//
// md5 / sha256 use node:crypto (CLAUDE.md: dev tools must use node:* APIs).
// crc32 (IEEE 802.3) and crc32c (Castagnoli) are implemented inline via
// table lookup since no crc dep is in the SDK.

function coerceToBytes(arg: unknown): Bytes {
  if (arg instanceof Bytes) return arg;
  if (typeof arg === 'string') return Bytes.fromUtf8(arg);
  throw new EvalError(`hashing.* requires Bytes or String, got ${typeof arg}`);
}

function evaluateHashingMethod(method: string, args: unknown[]): unknown {
  const input = coerceToBytes(args[0]);
  switch (method) {
    case 'md5': {
      // js-md5 / js-sha256 keep this path browser-safe (no node:crypto).
      // Both libs return ArrayBuffer with `.arrayBuffer()`, identical
      // bytes to the previous createHash() output — pinned by the
      // hashing.* receipt corpus.
      return new Bytes(new Uint8Array(md5Bytes.arrayBuffer(input.data)));
    }
    case 'sha256': {
      return new Bytes(new Uint8Array(sha256Bytes.arrayBuffer(input.data)));
    }
    case 'crc32': {
      const u32 = crc32(input.data);
      return new Bytes(u32ToBeBytes(u32));
    }
    case 'crc32c': {
      const u32 = crc32c(input.data);
      return new Bytes(u32ToBeBytes(u32));
    }
  }
  throw new UnsupportedError(`Unknown hashing method '${method}'`);
}

function u32ToBeBytes(n: number): Uint8Array {
  // Big-endian 4 bytes — matches how Firestore returns CRC results.
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

// CRC32 IEEE 802.3 (polynomial 0xEDB88320, reflected).
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// CRC32C Castagnoli (polynomial 0x82F63B78, reflected).
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function evaluateLatLngMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      // latlng.value(lat, lng) → LatLng wrapper. Item 1.1 closes the
      // entire `latlng` namespace gap (was throwing UnsupportedError).
      const [lat, lng] = args as [number, number];
      return new LatLng(lat, lng);
    }
  }
  throw new UnsupportedError(`Unknown latlng method '${method}'`);
}

function evaluateMathMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'abs': return Math.abs(args[0] as number);
    case 'ceil': return Math.ceil(args[0] as number);
    case 'floor': return Math.floor(args[0] as number);
    case 'round': return Math.round(args[0] as number);
    case 'sqrt': return Math.sqrt(args[0] as number);
    case 'pow': return Math.pow(args[0] as number, args[1] as number);
    case 'isInfinite': {
      const n = args[0] as number;
      return Number.isFinite(n) === false && Number.isNaN(n) === false;
    }
    case 'isNaN': return Number.isNaN(args[0] as number);
  }
  throw new UnsupportedError(`Unknown math method '${method}'`);
}

function evaluateTimestampMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'date': {
      // timestamp.date(year, month, day) → Timestamp at midnight UTC.
      // Item 1.3 flip: was returning epoch-ms Number which broke
      // `is timestamp` and dropped sub-second precision under arithmetic.
      const [y, m, d] = args as [number, number, number];
      return Timestamp.fromYMD(y, m, d);
    }
    case 'value': {
      // timestamp.value(epochMillis) → Timestamp wrapper. Item 1.3 flip.
      return Timestamp.fromMillis(args[0] as number);
    }
  }
  throw new UnsupportedError(`Unknown timestamp method '${method}'`);
}

function evaluateDurationMethod(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'value': {
      // duration.value(magnitude, unit) → Duration wrapper. Item 1.2 flip:
      // was returning a millis Number, which silently lost sub-ms precision
      // and made `is duration` always false. Item 1.0 dispatch hooks +
      // Duration.binaryOp keep arithmetic and comparison working without
      // numeric coercion.
      try {
        return Duration.fromValue(args[0] as number, args[1] as string);
      } catch (e) {
        // Bad unit string is a real type error in the rule, not a sim gap.
        throw new EvalError((e as Error).message);
      }
    }
    case 'time': {
      const [h, m, s, ns] = args as [number, number, number, number];
      return Duration.fromTime(h, m, s, ns);
    }
    case 'abs': {
      const d = args[0];
      if (!(d instanceof Duration)) {
        throw new EvalError(
          `duration.abs() requires a Duration argument, got ${typeof d}`,
        );
      }
      return Duration.abs(d);
    }
  }
  throw new UnsupportedError(`Unknown duration method '${method}'`);
}

// ═══ get()/exists() mock resolution ═══

function normalizePath(rawPath: string, ctx: SimulationContext): string {
  // Path format: /databases/(default)/documents/collection/docId
  // or /databases/$(database)/documents/collection/docId
  return rawPath
    .replace(/\$\(database\)/g, '(default)')
    .replace(/^\/databases\/\(default\)\/documents\//, '');
}

/**
 * Build the resource value `get()` / `getAfter()` return for an existing
 * document. RULES-B8: production exposes the document identity alongside
 * `data` — `get(path).id` is the last path segment and `get(path).__name__`
 * is the full Path. These were never populated, so rules reading them
 * silently denied (the access returned undefined → now, post-B2, would
 * even error). Mirrors the top-level `resource` shape (SimResource).
 */
function makeGetResource(relPath: string, data: Record<string, unknown>): SimResource {
  const segs = relPath.split('/').filter(Boolean);
  const id = segs.length > 0 ? segs[segs.length - 1] : '';
  const fullSegs = ['databases', '(default)', 'documents', ...segs];
  return { data, id, __name__: new Path(fullSegs) };
}

function resolveGet(rawPath: string, ctx: SimulationContext): SimResource {
  const path = normalizePath(rawPath, ctx);
  let doc = ctx.mockDocuments.get(path);
  if (!doc && ctx.getDoc) {
    const faulted = ctx.getDoc(path);
    if (faulted) {
      ctx.mockDocuments.set(path, faulted); // memoize for repeat reads in this eval
      doc = faulted;
    }
  }
  if (doc) return makeGetResource(path, doc);
  // RULES-B8: get() of a missing document is a runtime ERROR in production
  // (it performs a real read; a non-existent doc denies the request), NOT
  // the silent null this used to return. The safe pattern is
  // `exists(path) && get(path).data...` — the false exists() absorbs this
  // error commutatively (RULES-B3). Throwing here makes that guard behave
  // exactly as prod, and makes an UNguarded get() of a missing doc DENY.
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}

function resolveExists(rawPath: string, ctx: SimulationContext): boolean {
  const path = normalizePath(rawPath, ctx);
  if (ctx.mockDocuments.has(path)) return true;
  if (ctx.getDoc) {
    const faulted = ctx.getDoc(path);
    if (faulted) {
      ctx.mockDocuments.set(path, faulted); // memoize so a later get() is consistent
      return true;
    }
  }
  return false;
}
