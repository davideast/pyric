import { z } from 'zod';
import type { ExprTraceEntry } from '../simulator/evaluator.js';

// ---- Canonical shared primitives ----

/**
 * THE Firestore rules method union — the one canonical declaration.
 * Everything that talks about per-method access (the simulator's
 * `TestCase`, the playground's workspace-test runner, the app-spec
 * access matrix) imports this; nothing redeclares it.
 *
 * Note: this is the RULES vocabulary (`request.method`). Data-plane
 * vocabularies that include `set` (sandbox `RequestEvent`, traffic
 * types) are deliberately distinct — `set` lowers to create/update at
 * rules-evaluation time.
 */
export const FIRESTORE_METHODS = ['get', 'list', 'create', 'update', 'delete'] as const;
export type FirestoreMethod = (typeof FIRESTORE_METHODS)[number];

/**
 * THE test-identity shape — a signed-in principal for a rules check.
 * Custom claims live under `token` and read as
 * `request.auth.token.<name>` in rules. `null` at usage sites means
 * unauthenticated; the shape itself is always a signed-in identity.
 */
export const TestIdentitySchema = z.object({
  uid: z.string(),
  token: z.record(z.unknown()).optional(),
});
export type TestIdentity = z.infer<typeof TestIdentitySchema>;

// ---- Simplified agent-friendly types ----

export const FunctionMockSchema = z.object({
  function: z.enum(['get', 'exists']).describe('Firestore function to mock'),
  path: z.string().describe('Document path, e.g. "users/alice"'),
  result: z.union([z.record(z.unknown()), z.boolean()]).describe('Document data for get, boolean for exists'),
});

export type FunctionMock = z.infer<typeof FunctionMockSchema>;

/**
 * Item 0.D / Item 7 — typed write-mode discriminator.
 *
 * Without this, an `update` test had to pre-merge its payload into the
 * post-state by hand (because the simulator just used `tc.data` as the
 * after-state). That works for shallow updates, but for nested-map
 * updates and dot-path updates it silently produces the wrong shape —
 * which then makes `request.resource.data.x.y` and `getAfter()` lie.
 *
 * The four modes mirror what the Firestore admin SDK actually emits:
 *   create               → write fails if doc exists; after = payload
 *   set { merge: false } → full replace; pre-state irrelevant
 *   set { merge: true }  → recursive merge of pre-state and payload
 *   update               → top-level keys replace; dot-paths patch nested maps
 *
 * `writeMode` is optional. When omitted, the simulator falls back to the
 * legacy "tc.data IS the full after-state" behavior, which keeps every
 * existing test passing. New tests SHOULD set writeMode whenever the
 * rule reads nested maps or calls getAfter()/existsAfter().
 */
export const WriteModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }),
  z.object({ kind: z.literal('set'), merge: z.boolean() }),
  z.object({ kind: z.literal('update') }),
  z.object({ kind: z.literal('delete') }),
]);

export type WriteMode = z.infer<typeof WriteModeSchema>;

/**
 * Shape of `request.query` — only populated for `list` operations
 * (REBUILD_PLAN.md Item 6 follow-up). Production exposes:
 *   - limit:   the requested page size
 *   - offset:  the start offset within the result set
 *   - orderBy: the orderBy clause as a string (field name with optional direction)
 *
 * Unset fields read as `null` from rules. Tests SHOULD set this whenever the
 * rule under evaluation references `request.query.<x>`; otherwise the field
 * read returns null and the rule may silently DENY.
 */
export const ListQuerySchema = z.object({
  limit: z.number().optional(),
  offset: z.number().optional(),
  orderBy: z.string().optional(),
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

export type ExpressionReportLevel = 'NONE' | 'VISITED' | 'FULL';

export interface RulesTestIssue {
  sourcePosition?: unknown;
  description: string;
  severity: string;
}

export interface RulesTestApiResultDetails {
  errorPosition?: unknown;
  functionCalls?: unknown[];
  visitedExpressions?: unknown[];
  expressionReports?: unknown[];
}

export const TestCaseSchema = z.object({
  description: z.string().describe('Human-readable description of what this test verifies'),
  expectation: z.enum(['ALLOW', 'DENY']).describe('Expected outcome'),
  method: z.enum(FIRESTORE_METHODS).describe('Firestore method to test'),
  path: z.string().describe('Document path, e.g. "users/alice"'),
  auth: z.union([TestIdentitySchema, z.null()]).optional().describe('Auth context; null or omitted for unauthenticated'),
  data: z.record(z.unknown()).optional().describe('request.resource.data for write operations'),
  resource: z.record(z.unknown()).optional().describe('Existing document data (resource.data)'),
  functionMocks: z.array(FunctionMockSchema).optional().describe('Mock get()/exists() calls in rules'),
  /**
   * Optional `request.query` payload for `list` operations only. Populating
   * this is the only way to satisfy rules that read `request.query.limit /
   * .offset / .orderBy` — without it, the field read returns null and a
   * naive `request.query.limit < 100` evaluates as `null < 100 → false → DENY`.
   * Ignored for non-list methods.
   */
  query: ListQuerySchema.optional().describe('request.query payload (list ops only): limit/offset/orderBy.'),
  /**
   * Override for `request.time` (REBUILD_PLAN.md Item 0.F). ISO-8601 string.
   * Defaults to wallclock when omitted — but date-gated rules then evaluate
   * non-deterministically across CI runs. Set this whenever the rule under
   * test references `request.time`.
   */
  requestTime: z.string().optional().describe('Override for request.time (ISO-8601). Defaults to wallclock.'),
  /**
   * Optional explicit write semantics (REBUILD_PLAN.md Item 0.D / Item 7).
   * When set, the simulator runs `projectAfterState(writeMode, resource, data)`
   * to derive both `request.resource.data` AND the value `getAfter(path)`
   * returns. When omitted, the simulator preserves legacy behavior:
   * `tc.data` IS the after-state.
   */
  writeMode: WriteModeSchema.optional().describe('Optional write-mode override; controls update merge semantics and getAfter() projection.'),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

// ---- Result types ----

/**
 * Per-rule evaluation entry produced by the local simulator. Each entry
 * corresponds to one `allow` declaration the simulator evaluated, in
 * source order.
 *
 * Populated only by `SimulateFirestoreRulesHandler` (which has the parsed
 * AST in hand); the production Test API client (`TestFirestoreRulesHandler`)
 * returns an empty `trace` and surfaces the wire text on `TestResult.notes`.
 */
export interface RuleEvaluation {
  /** Position of the `allow` declaration within its match block, 0-indexed
   *  in source order. */
  ruleIndex: number;
  /** Operations declared on the allow rule (`read`, `write`, `get`, ...). */
  operations: Array<'read' | 'write' | 'get' | 'list' | 'create' | 'update' | 'delete'>;
  /**
   * Outcome for this single rule. The TestResult's overall `decision` is
   * derived from the trace under OR semantics (any `'ALLOW'` ⇒ ALLOW,
   * else any `'UNSUPPORTED'` ⇒ UNSUPPORTED, else DENY).
   */
  verdict: 'ALLOW' | 'DENY' | 'UNSUPPORTED' | 'ERROR';
  /** Pretty-printed condition expression. Use this verbatim in agent-facing
   *  summaries — derived from the AST via `printExpression`, so it survives
   *  comment removal and whitespace re-flow in the source. */
  conditionText?: string;
  /** 1-indexed source line of the `allow` keyword. Populated when the
   *  rule's `loc` was set by the parser. */
  line?: number;
  /**
   * Source-rendered path of the `match` block this rule belongs to, e.g.
   * `'/docs/{docId}'` or `'/{document=**}'`. Populated when the request
   * path matches MORE THAN ONE overlapping `match` block: allows OR-combine
   * across every matching block (production semantics — there is no
   * first-match-wins), so a DENY trace can carry entries from several
   * blocks. This field keeps them unambiguous — which block did this rule
   * live in. Absent for the common single-block case.
   */
  matchPath?: string;
  /** Human-readable diagnostic — populated for `UNSUPPORTED` (which sim
   *  surface is missing) and `ERROR` (which runtime error caused the
   *  rule to abort). */
  message?: string;
  /**
   * Per-sub-expression evaluation trace for this rule's condition.
   * Flat, in evaluation order; reconstruct the tree via the `parent`
   * index on each entry. Populated by the local simulator when the
   * caller enables tracing — currently always on for
   * `SimulateFirestoreRulesHandler.simulate()` so agents can see *why*
   * a rule's condition resolved as it did (which disjunct was true,
   * which `let` binding the value flowed through, which method call
   * threw). Absent on entries that came from the production Test API
   * client (no AST visibility).
   */
  expressionTrace?: ExprTraceEntry[];
}

/**
 * One `match` block the simulator considered while resolving the
 * request path. Together, `PathResolutionTrace.attempts` forms a
 * complete picture of "what did the resolver try, and where did
 * each attempt fall apart?" — useful for the agent when a request
 * lands in the default-deny path because no block matched.
 *
 * Recorded only by the local simulator; the production Test API
 * client doesn't expose path-resolution internals.
 */
export interface PathResolutionEntry {
  /** Source line of the `match` keyword. Absent when the parser
   *  didn't populate `loc` (programmatically-constructed blocks). */
  line?: number;
  /** Raw match path as written in the source, e.g.
   *  `'/users/{uid}/messages/{mId}'`. */
  blockPath: string;
  /** How many of the block's path segments matched against the
   *  request path before the resolver gave up or completed. */
  matchedSegments: number;
  /** Total segments in the block's path pattern. */
  totalSegments: number;
  /** Wildcard / recursive bindings the block produced (even when
   *  the overall match failed — the partial bindings are still
   *  diagnostic). */
  bindings: Record<string, string>;
  /** True for a block that fully resolved (no remaining request
   *  segments AND every nested match either completed or wasn't
   *  needed). MULTIPLE entries may be `matched: true` in one trace:
   *  a request path can match several overlapping `match` blocks
   *  (e.g. `/docs/{doc}` and a sibling `/{document=**}`), and every
   *  matching block's allows OR-combine. Container blocks whose
   *  children completed the resolution are also flagged matched. */
  matched: boolean;
  /** Why the resolver moved on. Absent when `matched: true`.
   *   - `'literal-mismatch'` — a literal segment in the block
   *     didn't match the corresponding request segment.
   *   - `'request-shorter'` — block path had more segments than
   *     the request supplied (e.g. block is `/a/{b}/c`, request is `/a/x`).
   *   - `'no-matching-child'` — block matched its own segments but
   *     remaining request segments weren't covered by any child block. */
  reason?: 'literal-mismatch' | 'request-shorter' | 'no-matching-child';
}

export interface PathResolutionTrace {
  /** The request path that was resolved, verbatim from `TestCase.path`. */
  requestPath: string;
  /** One entry per match block the resolver considered, in the
   *  order it tried them. `attempts[i].matched: true` marks a
   *  block that fully resolved; one or more per trace, since
   *  overlapping blocks all match and OR-combine. */
  attempts: PathResolutionEntry[];
}

export interface TestResult {
  description: string;
  expectation: 'ALLOW' | 'DENY';
  /**
   * Expectation-relative state. `'UNSUPPORTED'` is emitted only by the
   * local simulator (`SimulateFirestoreRulesHandler`) when it hits a
   * feature it doesn't yet implement — see REBUILD_PLAN.md Item 0.A. The
   * production Test API (`TestFirestoreRulesHandler`) only ever returns
   * `'PASSED'` | `'FAILED'`.
   */
  state: 'PASSED' | 'FAILED' | 'UNSUPPORTED';
  /** Absolute decision (ignores expectation). Always set. */
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  /** Per-rule evaluation entries in source order. Empty when no allow rule
   *  was evaluated (e.g. no matching path, or method not declared by any
   *  allow rule); see `notes` for the reason in that case. Also empty when
   *  the result came from the production Test API client. */
  trace: RuleEvaluation[];
  /** Top-level diagnostic strings. From the local simulator, holds
   *  no-match / no-rule-found descriptions (e.g. `"No match block found
   *  for path 'X'"`). From the production Test API client, this is the
   *  raw `debugMessages` from the wire response. */
  notes: string[];
  /** Per-test-case path-resolution trace — which `match` blocks the
   *  resolver considered and where each one failed (or succeeded).
   *  Populated by the local simulator; absent on results from the
   *  production Test API client. Empty `attempts` is possible when
   *  the ruleset has no match blocks at all (degenerate, but valid). */
  pathResolution?: PathResolutionTrace;
  /** Diagnostics returned by Firebase's hosted Rules Test API. Local
   *  simulation leaves this absent because its structured diagnostics live
   *  in `trace` and `pathResolution`. */
  api?: RulesTestApiResultDetails;
}

export type TestFirestoreRulesResult =
  | { success: true; data: { passed: number; failed: number; unsupported: number; results: TestResult[]; issues?: RulesTestIssue[] } }
  | { success: false; error: { code: string; message: string; recoverable: boolean } };

/**
 * Render a `TestResult` as a flat `debugMessages: string[]` trail.
 *
 * Format mirrors what the simulator emitted before the structured trace
 * landed: per-rule lines `Rule #<i> (<ops>) → <verdict>` plus top-level
 * `notes` plus a final `Simulated: <decision>` summary line.
 *
 * Use this for the (small) set of consumers that still expect a flat
 * string trail — currently the sandbox's `RequestEvent.debugMessages`
 * surface, which propagates into the playground's traffic log UI. New
 * consumers should read `result.trace` + `result.notes` directly.
 */
/**
 * The DECIDING rule's source position + sub-expression trace, projected from a
 * {@link TestResult} — for BOTH verdicts: the `allow` rule that granted an
 * ALLOW, or the rule responsible for a DENY. Additive companion to
 * {@link renderLegacyDebugMessages}: that flattens the per-rule trace to
 * strings (dropping `line` and `expressionTrace`); this preserves the
 * structured detail a UI needs to point at the exact source line and step
 * through the evaluation ("show the work"). Position/trace fields are optional
 * so a partial trace projects honestly.
 */
export interface EvaluatedRuleInfo {
  /** The verdict the deciding rule produced for the op. */
  verdict: 'allow' | 'deny';
  /** 1-indexed source line of the deciding `allow` rule. */
  line?: number;
  /** Pretty-printed condition text of the deciding rule. */
  expression?: string;
  /** Per-sub-expression evaluation trace of the deciding rule. */
  expressionTrace?: ExprTraceEntry[];
}

/**
 * Project the DECIDING rule from a simulated {@link TestResult}.
 *
 * For an ALLOW, picks the `ALLOW` trace entry (evaluation short-circuits on the
 * first allowing rule, so it's unique). For a DENY, picks the rule the sandbox
 * would report as responsible: the first `DENY`/`ERROR` entry, falling back to
 * the last evaluated rule. Returns `undefined` when no rule was evaluated
 * (implicit deny — no matching `allow`) or the simulator abstained
 * (`UNSUPPORTED`). Never invents data: a missing line/trace stays absent.
 */
export function projectEvaluatedRule(result: TestResult): EvaluatedRuleInfo | undefined {
  if (result.decision === 'UNSUPPORTED') return undefined;
  const allowed = result.decision === 'ALLOW';
  const deciding = allowed
    ? result.trace.find((t) => t.verdict === 'ALLOW')
    : (result.trace.find((t) => t.verdict === 'DENY' || t.verdict === 'ERROR') ??
       result.trace[result.trace.length - 1]);
  if (!deciding) return undefined;
  const info: EvaluatedRuleInfo = { verdict: allowed ? 'allow' : 'deny' };
  if (deciding.line !== undefined) info.line = deciding.line;
  if (deciding.conditionText !== undefined) info.expression = deciding.conditionText;
  if (deciding.expressionTrace !== undefined) info.expressionTrace = deciding.expressionTrace;
  return info.line !== undefined || info.expression !== undefined || info.expressionTrace !== undefined
    ? info
    : undefined;
}

export function renderLegacyDebugMessages(result: TestResult): string[] {
  const out: string[] = [];
  for (const note of result.notes) out.push(note);
  for (const entry of result.trace) {
    const ops = entry.operations.join(',');
    const head = `Rule #${entry.ruleIndex} (${ops})`;
    if (entry.verdict === 'ALLOW') {
      out.push(`${head} → ALLOW`);
    } else if (entry.verdict === 'DENY') {
      out.push(`${head} → deny`);
    } else if (entry.verdict === 'UNSUPPORTED') {
      out.push(`${head} → unsupported: ${entry.message ?? ''}`);
    } else {
      out.push(`${head} → error: ${entry.message ?? ''}`);
    }
  }
  out.push(`Simulated: ${result.decision}`);
  return out;
}

// ---- API wire types (not exported to agents) ----

export interface ApiTestCase {
  expectation: 'ALLOW' | 'DENY';
  expressionReportLevel?: ExpressionReportLevel;
  request: {
    auth: { uid: string; token: Record<string, unknown> } | undefined;
    method: string;
    path: string;
    resource?: { data: Record<string, unknown> };
    query?: ListQuery;
    /** ISO-8601 — forwarded from `TestCase.requestTime` (Item 0.F). */
    time?: string;
  };
  resource?: { data: Record<string, unknown> };
  functionMocks?: ApiFunctionMock[];
}

export interface ApiFunctionMock {
  function: 'get' | 'exists';
  args: Array<{ exactValue: string }>;
  result: { value: { data: Record<string, unknown> } } | { value: boolean } | undefined;
}

// ---- Path normalization ----

const DB_PREFIX = '/databases/(default)/documents/';

export function normalizeDocPath(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${DB_PREFIX}${clean}`;
}

// ---- Simplified → API format conversion ----

export interface BuildApiTestCaseOptions {
  expressionReportLevel?: ExpressionReportLevel;
}

export function buildApiTestCase(tc: TestCase, opts: BuildApiTestCaseOptions = {}): ApiTestCase {
  const request: ApiTestCase['request'] = {
    auth: tc.auth === null || tc.auth === undefined
      ? undefined
      : { uid: tc.auth.uid, token: tc.auth.token ?? {} },
    // Firestore rules engine expects request.method as a short verb
    // ('get' | 'list' | 'create' | 'update' | 'delete'). Sending the full
    // gRPC method string (firestore.googleapis.com/.../GetDocument) makes
    // the engine fail to map the request to any allow rule, so every
    // ALLOW-expectation test case silently returns DENY. Discovered by
    // the production-parity smoke test against the live Rules Test API.
    method: tc.method,
    path: normalizeDocPath(tc.path),
  };

  if (tc.data) {
    request.resource = { data: tc.data };
  }

  if (tc.requestTime) {
    request.time = tc.requestTime;
  }

  if (tc.query) {
    request.query = tc.query;
  }

  const result: ApiTestCase = {
    expectation: tc.expectation,
    request,
  };

  if (opts.expressionReportLevel) {
    result.expressionReportLevel = opts.expressionReportLevel;
  }

  if (tc.resource) {
    result.resource = { data: tc.resource };
  }

  if (tc.functionMocks && tc.functionMocks.length > 0) {
    result.functionMocks = tc.functionMocks.map(buildFunctionMock);
  }

  return result;
}

export function buildFunctionMock(mock: FunctionMock): ApiFunctionMock {
  // Function name must be the short verb ('get' | 'exists') — the same class
  // of bug as request.method. The Rules Test API rejects 'firestore.get' /
  // 'firestore.exists' as not matching any service-declared function, so the
  // mock is ignored and the real get() returns null → rule denies.
  const fnName = mock.function === 'get' ? 'get' : 'exists';
  const normalizedPath = normalizeDocPath(mock.path);

  const result: ApiFunctionMock = {
    function: fnName,
    args: [{ exactValue: normalizedPath }],
    result: undefined,
  };

  if (mock.function === 'get') {
    result.result = { value: { data: mock.result as Record<string, unknown> } };
  } else {
    // exists() returns a bool, not a map. Sending the map shape used for
    // get() here — { value: { data: {} } } / undefined — makes the
    // production Rules Test API reject the mock with "Type error.
    // Received: [map] Expected: [bool]", which silently resolves to DENY
    // and poisons every observation that mocks exists() to true.
    // Live-verified fix: emit a bool value directly.
    result.result = { value: mock.result === true };
  }

  return result;
}
