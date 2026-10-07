/**
 * The public case and result vocabulary for both rules languages.
 *
 * Firestore and RTDB cases are deliberately NOT unified — the two rules
 * languages take different request shapes (Firestore is method + document
 * path + resource/data; RTDB is operation + tree path + data/newData), and
 * collapsing them into one shape would force every field to be optional and
 * every reader to guess which half applies. They share the assertion
 * adapter (`assertCase`, with `explainCase` as its renderer) and the unified
 * {@link RuleIssue}, nothing more.
 */

import type {
  FirestoreMethod,
  FunctionMock,
  ListQuery,
  RuleEvaluation,
  PathResolutionTrace,
  RulesResourceLimit,
  TestIdentity,
  WriteMode,
} from '../test/spec.js';
import type { EvaluatedRuleInfo } from '../test/spec.js';
import type { RtdbRuleEvaluation } from '../rtdb/simulation/spec.js';

export type { RtdbRuleEvaluation };

// ─── Firestore ───────────────────────────────────────────────────────

/**
 * One Firestore rules case: a single request plus the outcome it should
 * produce. Structurally identical to the engine's `TestCase` — re-exported
 * here under the public name so callers never reach into the engine seam.
 */
export interface FirestoreCase {
  /** Human-readable description of what this case verifies. */
  description: string;
  /** Expected outcome. */
  expectation: 'ALLOW' | 'DENY';
  /** Firestore method under test. */
  method: FirestoreMethod;
  /** Document path, e.g. `"users/alice"`. */
  path: string;
  /** Auth context; `null`/omitted for unauthenticated. */
  auth?: TestIdentity | null;
  /** `request.resource.data` for write operations. */
  data?: Record<string, unknown>;
  /** Existing document data (`resource.data`). */
  resource?: Record<string, unknown>;
  /** Explicit write semantics — controls update-merge and getAfter()
   *  projection. Omit to treat `data` as the full after-state. */
  writeMode?: WriteMode;
  /** Mock `get()` / `exists()` calls the rules make. */
  functionMocks?: FunctionMock[];
  /** `request.query` payload (list ops only): limit/offset/orderBy. */
  query?: ListQuery;
  /** Override for `request.time` (ISO-8601). Defaults to wallclock. */
  requestTime?: string;
}

/** The outcome of running one Firestore case through `simulate`. Never a
 *  thrown error — a denied or abstained case is data, not an exception. */
export interface CaseResult {
  /** The case that produced this result. */
  case: FirestoreCase;
  description: string;
  expectation: 'ALLOW' | 'DENY';
  /** The engine's absolute verdict, independent of expectation. */
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  /** `true` when `decision` matched `expectation`. */
  passed: boolean;
  /** `true` when the simulator abstained on a feature it does not
   *  implement — neither a pass nor a genuine failure. */
  unsupported: boolean;
  /** Per-rule evaluation entries in source order. */
  trace: RuleEvaluation[];
  /** Top-level diagnostic strings. */
  notes: string[];
  /** Which match blocks the resolver considered and where each fell apart. */
  pathResolution?: PathResolutionTrace;
  /**
   * Expressions the request evaluated, in the unit of production's
   * per-request limit of 1000, across every allow rule and match block it
   * reached. `1000 - evaluatedExpressions` is the request's margin. See
   * `TestResult.evaluatedExpressions` for the unit.
   */
  evaluatedExpressions: number;
  /** The per-request limit that stopped the request, when one did. A
   *  request past 1000 expressions is DENY with `kind: 'expressions'`
   *  and production's message. */
  resourceLimit?: RulesResourceLimit;
}

/** The structured account of why one Firestore case resolved as it did. */
export interface Explanation {
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  expectation: 'ALLOW' | 'DENY';
  passed: boolean;
  unsupported: boolean;
  /** The deciding `allow` rule (line, condition text, sub-expression
   *  trace), when one was evaluated. Absent on default-deny / abstain. */
  deciding?: EvaluatedRuleInfo;
  trace: RuleEvaluation[];
  pathResolution?: PathResolutionTrace;
  notes: string[];
  /** Expressions the request evaluated; see {@link CaseResult.evaluatedExpressions}. */
  evaluatedExpressions: number;
  /** The per-request limit that stopped the request, when one did. */
  resourceLimit?: RulesResourceLimit;
}

/** Aggregate of a `simulate(cases)` run. Counts partition the cases:
 *  `passed + failed + unsupported === cases.length`. */
export interface SimulationSummary {
  passed: number;
  failed: number;
  unsupported: number;
  cases: CaseResult[];
}

// ─── RTDB ────────────────────────────────────────────────────────────

/**
 * The query a Realtime Database read carries, in the members rules read as
 * `query.*`. At most one `orderBy*` member and at most one limit may be set,
 * as in the SDK.
 */
export interface RtdbCaseQuery {
  orderByChild?: string;
  orderByKey?: true;
  orderByValue?: true;
  equalTo?: string | number | boolean | null;
  startAt?: string | number | boolean | null;
  endAt?: string | number | boolean | null;
  limitToFirst?: number;
  limitToLast?: number;
}

/**
 * One Realtime Database rules case. `expectation` is required so a `simulate`
 * run can partition cases into passed/failed the same way Firestore does —
 * the RTDB simulator otherwise returns only a raw allow/deny with no notion
 * of an expectation.
 */
export interface RtdbCase {
  /** Human-readable description of what this case verifies. */
  description?: string;
  /** Expected outcome. */
  expectation: 'ALLOW' | 'DENY';
  /**
   * RTDB rule kind under test. `update` is a multi-path `update()`: every
   * path in `newData` is written together and each is judged against the
   * tree the whole update produces.
   */
  operation: 'read' | 'write' | 'validate' | 'update';
  /** Absolute, root-relative tree path, e.g. `"/users/alice"`. */
  path: string;
  /** Auth context; a bare uid string, a full identity, or `null`. */
  auth?: string | { uid: string; token?: Record<string, unknown> } | null;
  /** Existing tree data the rule reads (`data`). */
  data?: Record<string, unknown>;
  /**
   * Proposed write value (`newData`), for write/validate cases. Any JSON
   * value: a scalar such as `5` or `true` is a scalar write. For an `update`
   * case it is the patch, an object keyed by paths relative to `path`, such
   * as `{ "rooms/r1/title": "x", "rooms/r2/title": "y" }`.
   */
  newData?: unknown;
  /**
   * The query a `read` case carries, so `query.*` rule expressions evaluate.
   * Omit it to simulate a plain read of `path`.
   */
  query?: RtdbCaseQuery;
  /**
   * The instant `now` reports in this case, in epoch milliseconds. A caller
   * hosting a sandbox passes its sandbox clock so a `now`-gated rule moves
   * with the sandbox rather than the wall clock. Omit to evaluate at the
   * real current instant.
   */
  now?: number;
}

/** The outcome of running one RTDB case through `simulate`. */
export interface RtdbCaseResult {
  case: RtdbCase;
  description?: string;
  expectation: 'ALLOW' | 'DENY';
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  passed: boolean;
  unsupported: boolean;
  /** The tree path whose rule decided the request. */
  matchedPath: string;
  /** The expression of the rule that decided, such as `auth != null`. Empty
   *  when no rule on the path decided, as for a request denied by default or
   *  one the engine could not evaluate. */
  matchedRule: string;
  /** Engine-provided reason string. */
  reason: string;
  /** Every `.read`, `.write` and `.validate` rule the engine evaluated, in
   *  evaluation order. Empty when no rule of the operation's kind exists on
   *  the path, or when the engine could not evaluate the case. */
  trace: RtdbRuleEvaluation[];
}

export interface RtdbExplanation {
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  expectation: 'ALLOW' | 'DENY';
  passed: boolean;
  unsupported: boolean;
  matchedPath: string;
  matchedRule: string;
  reason: string;
  /** See {@link RtdbCaseResult.trace}. */
  trace: RtdbRuleEvaluation[];
}

export interface RtdbSimulationSummary {
  passed: number;
  failed: number;
  unsupported: number;
  cases: RtdbCaseResult[];
}
