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
 * Populated only by the internal simulator (which has the parsed
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
   * the simulator so agents can see *why*
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
   * local simulator when it hits a
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

// ═══════════════════════════════════════════════════════════════
// Storage rules test surface
// ═══════════════════════════════════════════════════════════════
//
// Storage rules ride the SAME `projects.test` endpoint as Firestore
// (live-confirmed against firebaserules.googleapis.com/v1/projects/<p>:test),
// but the request shape is Storage-shaped, not Firestore-shaped:
//   - the ruleset header is `service firebase.storage`
//   - the path is a resource name `/b/{bucket}/o/{object}` (NOT the
//     `/databases/(default)/documents/...` Firestore prefix)
//   - `method` is a short verb (get/list/create/update/delete)
//   - `resource` carries `size`/`contentType`/`metadata` directly, with no
//     `.data` wrapper (production tolerates `size` as a string too)
//   - cross-service function mocks use the QUALIFIED names `firestore.get` /
//     `firestore.exists` (Firestore-internal mocks use the bare `get`/`exists`);
//     and — same fix as `buildFunctionMock` — an `exists()` mock must send a
//     bool `{ value: true/false }`, never a map, or the API rejects it and the
//     mock silently resolves to DENY.
//
// These builders live BESIDE the Firestore ones and share nothing mutable with
// them, so adding the Storage surface can't regress Firestore.

/** The rules methods a Storage test case may exercise — short verbs only.
 *  The coarse umbrellas (`read`/`write`) are a GRANT-side vocabulary; a
 *  request is always one precise granular verb. */
export const STORAGE_TEST_METHODS = ['get', 'list', 'create', 'update', 'delete'] as const;
export type StorageTestMethod = (typeof STORAGE_TEST_METHODS)[number];

/** Default bucket used when a case omits one. The bucket name is opaque to
 *  the rules engine (matched by the `{bucket}` path param), so any stable
 *  value works; keep it constant so observation paths are reproducible. */
export const DEFAULT_STORAGE_BUCKET = 'demo-pyric.appspot.com';

/**
 * `request.resource.*` / `resource.*` binding shape the Storage rules language
 * sees.
 *
 * This is ALSO the wire shape: the production Rules Test API takes the
 * `resource` field of a test case as a LITERAL MAP and derives nothing from the
 * request path — live-probed, a case that sends `{ size }` and whose rule reads
 * `resource.name` gets "Property name is undefined on object." and DENIES.
 * So every field a scenario's rule reads must be supplied here explicitly.
 *
 * Types follow production: `timeCreated` / `updated` are TIMESTAMPS and must be
 * ISO-8601 strings (sending epoch millis is rejected with "Unsupported
 * operation error. Received: int < timestamp"); `generation` /
 * `metageneration` are ints.
 */
export interface StorageResourceShape {
  size?: number;
  contentType?: string;
  metadata?: Record<string, string>;
  /** Full object path within the bucket (`uploads/pic.png`) — GCS object-name
   *  semantics, NOT the client SDK's last-path-segment `name`. */
  name?: string;
  bucket?: string;
  /** ISO-8601. Production types it `timestamp`. */
  timeCreated?: string;
  /** ISO-8601. Production types it `timestamp`. The language has NO
   *  `timeUpdated` field — this is the update-time field. */
  updated?: string;
  generation?: number;
  metageneration?: number;
}

export const StorageFunctionMockSchema = z.object({
  function: z.enum(['get', 'exists']).describe('Cross-service Firestore function to mock'),
  path: z.string().describe('Firestore document path in collection/doc form, e.g. "users/alice"'),
  result: z.union([z.record(z.unknown()), z.boolean()]).describe('Document fields for get, boolean for exists'),
});
export type StorageFunctionMock = z.infer<typeof StorageFunctionMockSchema>;

/**
 * A single Storage rules conformance case. Mirrors the Firestore {@link TestCase}
 * but with the Storage request shape. `path` is the OBJECT path within the
 * bucket (e.g. `"images/alice.png"`); `normalizeStoragePath` lifts it to the
 * `/b/{bucket}/o/{object}` resource name that BOTH the production API and the
 * in-process evaluator match against.
 */
export interface StorageTestCase {
  description: string;
  expectation: 'ALLOW' | 'DENY';
  method: StorageTestMethod;
  /** Object path within the bucket, e.g. `"images/alice.png"`. */
  path: string;
  /** Bucket name; defaults to {@link DEFAULT_STORAGE_BUCKET}. */
  bucket?: string;
  /** Auth context; `null`/omitted for anonymous. */
  auth?: TestIdentity | null;
  /** `request.resource` — the about-to-write object (writes only). */
  resource?: StorageResourceShape;
  /** `resource` — the existing object. `null`/omitted means no object yet
   *  (the create case), which the evaluator reads as `resource == null`. */
  existingResource?: StorageResourceShape | null;
  /** Override for `request.time` (ISO-8601). Set whenever the rule reads
   *  `request.time`, so date-gated cases are deterministic. */
  requestTime?: string;
  /** Cross-service `firestore.get()/exists()` mocks. */
  functionMocks?: StorageFunctionMock[];
  /**
   * Marks a case whose in-process EVALUATOR verdict is KNOWN to diverge from
   * production because the evaluator does not implement the feature the rule
   * uses (e.g. `resource.timeCreated`). The capture still records production's
   * real verdict; the replay suite records but does NOT assert these, exactly
   * as the Firestore replay skips its simulator's `UNSUPPORTED` abstentions.
   * The string is the reason, for the record.
   */
  knownGap?: string;
}

export interface StorageApiFunctionMock {
  /** QUALIFIED cross-service name: `firestore.get` / `firestore.exists`. */
  function: string;
  args: Array<{ exactValue: string }>;
  result: { value: { data: Record<string, unknown> } } | { value: boolean } | undefined;
}

export interface StorageApiTestCase {
  expectation: 'ALLOW' | 'DENY';
  request: {
    auth: { uid: string; token: Record<string, unknown> } | undefined;
    method: string;
    path: string;
    /** ISO-8601 — forwarded from `StorageTestCase.requestTime`. */
    time?: string;
    /** `request.resource` for writes. */
    resource?: StorageResourceShape;
  };
  /** Existing-object `resource`. */
  resource?: StorageResourceShape;
  functionMocks?: StorageApiFunctionMock[];
}

/**
 * Lift an object path to the Storage resource-name form the rules engine and
 * the evaluator both match against: `/b/{bucket}/o/{object}`. A path that is
 * already absolute has its leading slash stripped before the object segment so
 * `"images/x"` and `"/images/x"` normalize identically.
 */
export function normalizeStoragePath(objectPath: string, bucket: string = DEFAULT_STORAGE_BUCKET): string {
  const clean = objectPath.startsWith('/') ? objectPath.slice(1) : objectPath;
  return `/b/${bucket}/o/${clean}`;
}

/** Convert a {@link StorageTestCase} into the production Rules Test API wire
 *  shape. Symmetric with {@link buildApiTestCase} for Firestore. */
export function buildStorageApiTestCase(tc: StorageTestCase): StorageApiTestCase {
  const request: StorageApiTestCase['request'] = {
    auth: tc.auth === null || tc.auth === undefined
      ? undefined
      : { uid: tc.auth.uid, token: tc.auth.token ?? {} },
    // Short verb — same class of bug as Firestore's request.method: sending
    // anything but get/list/create/update/delete makes the engine map the
    // request to no allow rule, silently denying every ALLOW case.
    method: tc.method,
    path: normalizeStoragePath(tc.path, tc.bucket),
  };
  if (tc.resource) request.resource = tc.resource;
  if (tc.requestTime) request.time = tc.requestTime;

  const result: StorageApiTestCase = { expectation: tc.expectation, request };
  if (tc.existingResource) result.resource = tc.existingResource;
  if (tc.functionMocks && tc.functionMocks.length > 0) {
    result.functionMocks = tc.functionMocks.map(buildStorageFunctionMock);
  }
  return result;
}

/**
 * Build a cross-service Firestore function mock for a Storage ruleset. Unlike
 * the Firestore-internal {@link buildFunctionMock} (bare `get`/`exists`), a
 * Storage rule reaching into Firestore names the function with its service
 * QUALIFIER — `firestore.get` / `firestore.exists` — live-confirmed against the
 * production endpoint. The `exists()` result is a bool `{ value }`, never the
 * `{ value: { data } }` map shape (the same fix `buildFunctionMock` carries):
 * a map there is rejected with a bool/map type error and silently denies.
 */
export function buildStorageFunctionMock(mock: StorageFunctionMock): StorageApiFunctionMock {
  const fnName = mock.function === 'get' ? 'firestore.get' : 'firestore.exists';
  // The rule's path literal resolves to the full Firestore resource name
  // (/databases/(default)/documents/<doc>); the mock's exactValue must match
  // it. `normalizeDocPath` produces exactly that from the collection/doc form.
  const normalizedPath = normalizeDocPath(mock.path);
  const result: StorageApiFunctionMock = {
    function: fnName,
    args: [{ exactValue: normalizedPath }],
    result: undefined,
  };
  if (mock.function === 'get') {
    result.result = { value: { data: mock.result as Record<string, unknown> } };
  } else {
    result.result = { value: mock.result === true };
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
