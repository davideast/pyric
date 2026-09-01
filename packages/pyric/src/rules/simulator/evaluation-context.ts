import type { FunctionDef } from '../grammar/FirestoreAST.js';
import type { LookupBudget } from './document-lookups.js';
import type { TraceRecorder } from './trace-recorder.js';
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
  /**
   * T2.1 — per-request document access budget (production: 10 distinct
   * get/exists/getAfter/existsAfter reads per single-document request; the
   * 11th fails the evaluation closed). The handler creates one per test
   * case and shares it across every match block and allow rule evaluated
   * for that request; a fresh budget per test case is the "resets between
   * requests" semantics. Optional so non-handler evaluation paths are
   * unaffected. See LookupBudget in document-lookups.ts for the counting
   * semantics and the in-repo production evidence.
   */
  lookupBudget?: LookupBudget;
  /** Optional per-rule expression-trace recorder. When set, the evaluator
   *  wraps every `evaluate()` call and records the sub-expression tree;
   *  when absent (the default), the evaluator is unchanged. The handler
   *  attaches a fresh recorder per allow-rule evaluation so each
   *  `RuleEvaluation.expressionTrace` is independent. */
  trace?: TraceRecorder;
}
