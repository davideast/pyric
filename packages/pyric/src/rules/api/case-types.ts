/**
 * The public case and result vocabulary for both rules languages.
 *
 * Firestore and RTDB cases are deliberately NOT unified — the two rules
 * languages take different request shapes (Firestore is method + document
 * path + resource/data; RTDB is operation + tree path + data/newData), and
 * collapsing them into one shape would force every field to be optional and
 * every reader to guess which half applies. They share the assertion
 * adapters (`eachCase` / `assertCase` / `explainCase`) and the unified
 * {@link RuleIssue}, nothing more.
 */

import type {
  FirestoreMethod,
  FunctionMock,
  ListQuery,
  RuleEvaluation,
  PathResolutionTrace,
  TestIdentity,
  WriteMode,
} from '../test/spec.js';
import type { EvaluatedRuleInfo } from '../test/spec.js';

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
 * One Realtime Database rules case. `expect` is required so a `simulate`
 * run can partition cases into passed/failed the same way Firestore does —
 * the RTDB simulator otherwise returns only a raw allow/deny with no notion
 * of an expectation.
 */
export interface RtdbCase {
  /** Human-readable description of what this case verifies. */
  description?: string;
  /** Expected outcome. */
  expect: 'allow' | 'deny';
  /** RTDB rule kind under test. */
  operation: 'read' | 'write' | 'validate';
  /** Absolute, root-relative tree path, e.g. `"/users/alice"`. */
  path: string;
  /** Auth context; a bare uid string, a full identity, or `null`. */
  auth?: string | { uid: string; token?: Record<string, unknown> } | null;
  /** Existing tree data the rule reads (`data`). */
  data?: Record<string, unknown>;
  /** Proposed write value (`newData`), for write/validate cases. */
  newData?: unknown;
}

/** The outcome of running one RTDB case through `simulate`. */
export interface RtdbCaseResult {
  case: RtdbCase;
  description?: string;
  expect: 'allow' | 'deny';
  decision: 'allow' | 'deny' | 'unsupported';
  passed: boolean;
  unsupported: boolean;
  /** The tree path whose rule decided the request. */
  matchedPath: string;
  /** Which rule kind (`.read` / `.write` / `.validate`) decided. */
  matchedRule: string;
  /** Engine-provided reason string. */
  reason: string;
}

export interface RtdbExplanation {
  decision: 'allow' | 'deny' | 'unsupported';
  expect: 'allow' | 'deny';
  passed: boolean;
  unsupported: boolean;
  matchedPath: string;
  matchedRule: string;
  reason: string;
}

export interface RtdbSimulationSummary {
  passed: number;
  failed: number;
  unsupported: number;
  cases: RtdbCaseResult[];
}
