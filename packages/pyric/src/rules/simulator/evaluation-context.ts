import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import { Path } from './wrappers/path.js';
import { Timestamp } from './wrappers/timestamp.js';

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
  // Item 6: request.query exists only for `list` operations. Production makes
  // the property absent on get/write requests, so reading it errors to DENY.
  // On list, limit/offset/orderBy are always-present nullable fields.
  query?: Record<string, unknown>;
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
// Serializable function mocks used by `get()`/`getAfter()` also omit identity,
// while real DocStore lookups retain the identity-bearing document path.
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
  /** Paths populated by serializable Rules Test API `functionMocks`. Production
   *  exposes only the supplied data for these synthetic get() results; unlike a
   *  real DocStore read, no `id`/`__name__` identity is attached. */
  identitylessFunctionMocks?: ReadonlySet<string>;
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
