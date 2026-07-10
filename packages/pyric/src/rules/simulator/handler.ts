/**
 * Firestore Rules Simulation Handler.
 *
 * Local simulation of Firestore security rules evaluation.
 * Same interface as TestFirestoreRulesHandler but runs entirely
 * in-process — no deployment, no propagation wait, no side effects.
 *
 * Consumes TestCase[] and returns TestResult[] in the same format
 * as the Rules Test API.
 */
import type {
  TestCase,
  TestResult,
  TestFirestoreRulesResult,
  RuleEvaluation,
  PathResolutionEntry,
  PathResolutionTrace,
} from '../test/spec.js';
import type { FirestoreRules, MatchBlock, AllowRule, FunctionDef, Expression } from '../grammar/FirestoreAST.js';
import { parseToAST } from '../grammar/FirestoreParser.js';
import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import { evaluate, UnsupportedError, TraceRecorder, type SimulationContext } from './evaluator.js';
import { Timestamp } from './wrappers/timestamp.js';
import { Path } from './wrappers/path.js';
import { projectAfterState } from './project-after-state.js';

type Decision = 'ALLOW' | 'DENY' | 'UNSUPPORTED';

// ═══ Match block resolution ═══

interface MatchResult {
  block: MatchBlock;
  pathVariables: Record<string, string>;
  parentFunctions: FunctionDef[];
}

/**
 * Collects per-block resolution attempts as `resolveMatch` walks the
 * match-block tree. Optional — when absent, `resolveMatch` is unchanged.
 * The handler instantiates one per test case and attaches the resulting
 * `attempts` array to the corresponding `TestResult.pathResolution`.
 *
 * Records both successful matches (the winning block) and every block
 * the resolver considered and rejected. Used by `debug_firestore_rules`
 * to surface "near-miss" blocks in PATH_MISMATCH diagnoses — without
 * this trace, the agent would have to manually walk the rule AST to
 * figure out which block was closest to the failing path.
 */
class PathResolutionRecorder {
  readonly attempts: PathResolutionEntry[] = [];
  push(entry: PathResolutionEntry): void {
    this.attempts.push(entry);
  }
}

/** Render a block's `PathPattern` back to source form for the trace
 *  entry. Literal segments pass through; wildcards become `{name}`;
 *  recursive segments become `{name=**}`. Matches the shape the agent
 *  sees in the rules file. */
function renderBlockPath(block: MatchBlock): string {
  const parts = block.path.segments.map(seg => {
    if (seg.type === 'literal') return seg.value;
    if (seg.type === 'wildcard') return `{${seg.name}}`;
    return `{${seg.name}=**}`;
  });
  return '/' + parts.join('/');
}

/**
 * Given a document path like "chess/game1", find EVERY match block in the
 * AST whose path pattern fully resolves the request path. Resolves
 * wildcards and binds path variables per block.
 *
 * Why every block, not the first: production Firestore OR-combines `allow`
 * statements across ALL overlapping `match` blocks. When two sibling
 * blocks both match a path (e.g. `match /docs/{doc}` and a sibling
 * `match /{document=**}`), the request is granted if EITHER block's
 * applicable allow evaluates true — there is no first-match-wins and no
 * way for one block to revoke another's grant. Returning only the first
 * match (the previous behavior) produced a false DENY whenever the first
 * block in source order denied but a later overlapping block would have
 * allowed. Each returned block carries its OWN wildcard bindings, so a
 * block's variable names bind independently of its siblings.
 *
 * When `recorder` is supplied, every block the function considers
 * (matched or not) is logged as a `PathResolutionEntry`. Tests +
 * `debug_firestore_rules` rely on this trace; production callers can
 * omit it and pay zero cost.
 */
function collectMatches(
  block: MatchBlock,
  pathSegments: string[],
  parentFunctions: FunctionDef[],
  recorder?: PathResolutionRecorder,
): MatchResult[] {
  const allFunctions = [...parentFunctions, ...block.functions];

  // Check if this block's path pattern matches the remaining segments
  const pattern = block.path.segments;
  const bindings: Record<string, string> = {};
  let consumed = 0;
  // Track WHY we stopped — needed for the resolution trace. Default
  // 'literal-mismatch' is overwritten before the early-return paths
  // that have a more specific reason.
  let failureReason: PathResolutionEntry['reason'] | undefined;

  for (const seg of pattern) {
    if (seg.type === 'literal') {
      if (consumed >= pathSegments.length) {
        // The block path has more segments than the request supplied
        // — distinct from a literal-mismatch even though we technically
        // ran out of input mid-loop. Flag it for the trace before the
        // early-return below.
        failureReason = 'request-shorter';
        break;
      }
      if (pathSegments[consumed] !== seg.value) {
        failureReason = 'literal-mismatch';
        break;
      }
      consumed++;
    } else if (seg.type === 'wildcard') {
      if (consumed >= pathSegments.length) {
        failureReason = 'request-shorter';
        break;
      }
      bindings[seg.name] = pathSegments[consumed];
      consumed++;
    } else if (seg.type === 'recursive') {
      // {document=**} matches all remaining segments
      bindings[seg.name] = pathSegments.slice(consumed).join('/');
      consumed = pathSegments.length;
    }
  }

  // If we exited the loop early with a failureReason set, this block
  // didn't fully consume its own pattern — record + bail.
  if (failureReason !== undefined) {
    recorder?.push({
      ...(block.loc ? { line: block.loc.line } : {}),
      blockPath: renderBlockPath(block),
      matchedSegments: consumed,
      totalSegments: pattern.length,
      bindings,
      matched: false,
      reason: failureReason,
    });
    return [];
  }

  const remaining = pathSegments.slice(consumed);

  // If all segments consumed, this block matches directly. Its own allow
  // rules apply to the document at this path; nested children can't match
  // (there are no remaining segments for them to consume), so we stop here.
  if (remaining.length === 0) {
    recorder?.push({
      ...(block.loc ? { line: block.loc.line } : {}),
      blockPath: renderBlockPath(block),
      matchedSegments: consumed,
      totalSegments: pattern.length,
      bindings,
      matched: true,
    });
    return [{ block, pathVariables: bindings, parentFunctions: allFunctions }];
  }

  // Otherwise descend into EVERY child and collect all matches — this block
  // is a container for the deeper document, so its own allow rules do NOT
  // apply, but multiple children (and their descendants) may each match and
  // must all be OR-combined.
  const results: MatchResult[] = [];
  for (const child of block.children) {
    for (const childResult of collectMatches(child, remaining, allFunctions, recorder)) {
      // Merge this block's bindings into each descendant match.
      childResult.pathVariables = { ...bindings, ...childResult.pathVariables };
      results.push(childResult);
    }
  }

  // Record THIS block's own attempt: matched (as a container) when at least
  // one descendant completed the resolution, else the near-miss reason.
  recorder?.push({
    ...(block.loc ? { line: block.loc.line } : {}),
    blockPath: renderBlockPath(block),
    matchedSegments: consumed,
    totalSegments: pattern.length,
    bindings,
    ...(results.length > 0
      ? { matched: true }
      : { matched: false, reason: 'no-matching-child' as const }),
  });
  return results;
}

// ═══ Operation mapping ═══

function methodToOperations(method: string): string[] {
  switch (method) {
    case 'get': return ['get', 'read'];
    case 'list': return ['list', 'read'];
    case 'create': return ['create', 'write'];
    case 'update': return ['update', 'write'];
    case 'delete': return ['delete', 'write'];
    default: return [method];
  }
}

// ═══ Rule evaluation ═══

/**
 * Evaluate all allow rules in a match block for a given operation.
 * Uses OR semantics — if any matching rule allows, access is granted.
 *
 * Decision logic:
 *   - any rule ALLOW → ALLOW (short-circuit)
 *   - else if any rule threw UnsupportedError → UNSUPPORTED (sim abstains)
 *   - else → DENY
 *
 * Real evaluation errors (EvalError, type mismatches) are *not* lifted to
 * UNSUPPORTED — they're caught and counted as deny, matching production's
 * "runtime errors deny the request" behavior.
 */
function evaluateRules(
  block: MatchBlock,
  operation: string,
  ctx: SimulationContext,
): { decision: Decision; trace: RuleEvaluation[]; notes: string[] } {
  const ops = methodToOperations(operation);
  const trace: RuleEvaluation[] = [];
  const notes: string[] = [];

  // Find allow rules that match this operation
  const matchingRules: { rule: AllowRule; index: number }[] = [];
  for (let i = 0; i < block.allows.length; i++) {
    const rule = block.allows[i];
    if (rule.operations.some(op => ops.includes(op))) {
      matchingRules.push({ rule, index: i });
    }
  }

  if (matchingRules.length === 0) {
    notes.push(`No allow rules found for operation '${operation}'`);
    return { decision: 'DENY', trace, notes };
  }

  // Evaluate each matching rule (OR semantics). Each rule gets its own
  // TraceRecorder so the per-rule expressionTrace stays isolated even
  // when multiple rules evaluate before a verdict lands. We attach via
  // mutation+restore on the shared ctx — cheaper than cloning ctx for
  // every rule and keeps wrappers' identity (Timestamp etc.) stable
  // across the loop.
  let sawUnsupported = false;
  const priorRecorder = ctx.trace;
  for (const { rule, index } of matchingRules) {
    const entry = newEntry(rule, index);
    const recorder = new TraceRecorder();
    ctx.trace = recorder;
    try {
      const result = evaluate(rule.condition, ctx);
      entry.expressionTrace = recorder.entries;
      if (result) {
        entry.verdict = 'ALLOW';
        trace.push(entry);
        ctx.trace = priorRecorder;
        return { decision: 'ALLOW', trace, notes };
      }
      entry.verdict = 'DENY';
      trace.push(entry);
    } catch (e) {
      entry.expressionTrace = recorder.entries;
      if (e instanceof UnsupportedError) {
        sawUnsupported = true;
        entry.verdict = 'UNSUPPORTED';
        entry.message = e.message;
      } else {
        entry.verdict = 'ERROR';
        entry.message = e instanceof Error ? e.message : String(e);
      }
      trace.push(entry);
    }
  }
  ctx.trace = priorRecorder;

  // No rule allowed. If at least one rule abstained on a sim gap, escalate
  // to UNSUPPORTED so the agent sees "sim couldn't decide" rather than a
  // misleading DENY. If every failure was a real eval error, return DENY
  // (production would also deny on runtime errors).
  return { decision: sawUnsupported ? 'UNSUPPORTED' : 'DENY', trace, notes };
}

function newEntry(rule: AllowRule, index: number): RuleEvaluation {
  const entry: RuleEvaluation = {
    ruleIndex: index,
    operations: [...rule.operations],
    verdict: 'DENY',
    conditionText: assembleExpression(rule.condition),
  };
  if (rule.loc) entry.line = rule.loc.line;
  return entry;
}

// ═══ Build simulation context from TestCase ═══

// ═══ Server timestamp sentinel ═══

/** Sentinel value for FieldValue.serverTimestamp() in test data. */
export const SERVER_TIMESTAMP = { __type: 'serverTimestamp' } as const;

function isServerTimestampSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).__type === 'serverTimestamp';
}

/**
 * Recursively replace serverTimestamp sentinels with the actual server time.
 * Item 1.3: `serverTime` is now a Timestamp wrapper (was ISO string). The
 * SAME instance is reused across every sentinel hit so `data.createdAt ==
 * request.time` succeeds via rulesValuesEqual -> Timestamp.equals (field
 * compare). Without instance reuse, two distinct Timestamp instances would
 * still equate via field compare — but the single-instance invariant is
 * documented here so future refactors don't break it accidentally.
 */
export function resolveServerTimestamps(
  data: Record<string, unknown>,
  serverTime: Timestamp,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isServerTimestampSentinel(value)) {
      resolved[key] = serverTime;
    } else if (isPlainObject(value)) {
      // Only descend into plain objects ({} / Object.create(null)). After
      // Item 1 the value tree may legitimately contain class instances
      // (Timestamp, Bytes, LatLng, future DocumentReference) — walking
      // them as maps would shred their prototype and break `is timestamp`,
      // `is reference`, etc.
      resolved[key] = resolveServerTimestamps(value as Record<string, unknown>, serverTime);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Populate `request.query` for `list` operations from the optional
 * TestCase.query payload (REBUILD_PLAN.md Item 6 follow-up).
 *
 * Production's `request.query` exposes `limit / offset / orderBy` as
 * always-present, NULLABLE fields on a `list` request — `request.query.limit
 * == null` is the documented way to assert "no limit clause." So we ALWAYS
 * expose the three keys (null when the test omits them) rather than omitting
 * them; otherwise, after RULES-B2 (dotted-field access of a MISSING key
 * errors), `request.query.limit` would error instead of reading null, breaking
 * the legitimate `== null` guard. For non-list methods `request.query` is the
 * empty map (the fields don't apply), matching production.
 */
function buildRequestQuery(tc: TestCase): Record<string, unknown> {
  if (tc.method !== 'list') return {};
  return {
    limit: tc.query?.limit ?? null,
    offset: tc.query?.offset ?? null,
    orderBy: tc.query?.orderBy ?? null,
  };
}

function buildContext(
  tc: TestCase,
  functions: FunctionDef[],
  pathVariables: Record<string, string>,
  getDoc?: (path: string) => Record<string, unknown> | null,
  batchProjection?: Map<string, Record<string, unknown> | null>,
): SimulationContext {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of functions) fnMap.set(fn.name, fn);

  const mockDocs = new Map<string, Record<string, unknown>>();
  if (tc.functionMocks) {
    for (const mock of tc.functionMocks) {
      if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
        mockDocs.set(mock.path, mock.result as Record<string, unknown>);
      } else if (mock.function === 'exists') {
        if (mock.result === true) mockDocs.set(mock.path, {});
      }
    }
  }

  // request.time defaults to wallclock; tc.requestTime (Item 0.F) lets
  // tests pin a deterministic value for date-gated rules. Item 1.3
  // flipped the in-evaluator type from ISO string to Timestamp wrapper
  // (REBUILD_PLAN Risk 1) — `tc.requestTime` stays an ISO string for
  // backwards-compat with the prod Test API, parsed here.
  const serverTime = tc.requestTime
    ? Timestamp.fromIsoString(tc.requestTime)
    : Timestamp.fromMillis(Date.now());

  // Item 6: build the full document path for request.path / __name__.
  // tc.path arrives as a relative path like "users/alice"; the spec form
  // is /databases/(default)/documents/<rel>. Strip a leading slash so we
  // don't end up with a double slash.
  const relPath = tc.path.startsWith('/') ? tc.path.slice(1) : tc.path;
  const fullPathSegs = ['databases', '(default)', 'documents', ...relPath.split('/').filter(Boolean)];
  // Pass pathVariables as bindings so `request.path.<name>` (where <name> is
  // a wildcard from the matched rule, e.g. {uid}) returns the bound segment
  // value instead of null. Without this, named-field access on request.path
  // silently DENYs any rule that reads it.
  const fullPath = new Path(fullPathSegs, pathVariables);
  // resource.id = last segment of the relative path
  const relSegs = relPath.split('/').filter(Boolean);
  const docId = relSegs.length > 0 ? relSegs[relSegs.length - 1] : '';

  // Item 7 — project the after-state.
  //
  // If tc.writeMode is set (Item 0.D), run projectAfterState to derive both
  // request.resource.data and what getAfter() returns. Otherwise preserve
  // legacy behavior where tc.data IS the after-state for create/update,
  // tc.resource for read methods, and null for delete. The legacy fallback
  // keeps every existing test passing while letting new tests opt into
  // proper merge semantics.
  const payload = tc.data ?? {};
  const existing = tc.resource ?? null;
  let afterState: Record<string, unknown> | null;
  let existsAfter: boolean;
  if (tc.writeMode) {
    afterState = projectAfterState(tc.writeMode, existing, payload);
    existsAfter = afterState !== null;
  } else {
    switch (tc.method) {
      case 'create':
      case 'update':
        // RULES-B10: the prod-faithful update post-state is `existing` merged
        // with the payload. That merge IS implemented and correct on the
        // `writeMode: { kind: 'update' }` path above (`projectAfterState`),
        // which agent-facing `simulate()` callers should use. The legacy
        // no-writeMode default keeps `afterState = payload`: the sandbox
        // LocalEnvironment path ALREADY pre-merges + pre-applies deleteField()
        // and hands us the FULL post-write doc, so re-merging here would
        // resurrect deleted keys (RULES-B10 step doc records this cross-track
        // coupling — making merge the unconditional default needs a coordinated
        // T2 change to have LocalEnvironment declare its writeMode).
        afterState = payload;
        existsAfter = true;
        break;
      case 'delete':
        afterState = null;
        existsAfter = false;
        break;
      case 'get':
      case 'list':
      default:
        afterState = existing; // no write happens
        existsAfter = existing !== null;
        break;
    }
  }
  const projectedAfter = afterState !== null
    ? resolveServerTimestamps(afterState, serverTime)
    : null;

  // request.resource.data: for non-write methods (get/list) Firestore exposes
  // null. For writes, it's the projected after-state. We keep the legacy
  // shape (`{}` when tc.data is absent) for backwards-compat — the parity
  // packs that exercise this surface explicitly set tc.data.
  const reqResourceData = projectedAfter ?? {};

  return {
    request: {
      auth: tc.auth ? { uid: tc.auth.uid, token: tc.auth.token ?? {} } : null,
      resource: { data: reqResourceData },
      method: tc.method,
      path: fullPath,        // Item 6: Path wrapper, full /databases/.../documents/... form
      query: buildRequestQuery(tc),
      time: serverTime,
    },
    resource: {
      data: existing ?? {},  // NOT resolved — resource is pre-write, no sentinels
      id: docId,             // Item 6
      __name__: fullPath,    // Item 6
    },
    mockDocuments: mockDocs,
    getDoc,
    pathVariables,
    functions: fnMap,
    database: '(default)',
    // Item 7 — projected post-write state for the request target.
    //   afterStatePath: full Path being written to (matches request.path)
    //   afterState: post-write doc data, or null when deleted
    //   existsAfter: false when method is delete (or projectAfterState → null)
    afterStatePath: fullPath,
    afterState: projectedAfter,
    existsAfter,
    // getafter-batch fix — shared batch/transaction projection, when the
    // caller supplied one. Absent for single-op evaluation.
    ...(batchProjection ? { batchProjection } : {}),
  };
}

// ═══ Main handler ═══

export class SimulateFirestoreRulesHandler {
  /**
   * Simulate Firestore rules evaluation locally.
   * Same interface as TestFirestoreRulesHandler.execute().
   */
  simulate(
    source: string,
    testCases: TestCase[],
    opts?: {
      getDoc?: (path: string) => Record<string, unknown> | null;
      /**
       * getafter-batch fix — shared post-commit projection for a batch or
       * transaction. Keyed by normalized relative path (same shape as
       * `getDoc`'s input); value is the post-write document, or `null` for
       * a path the batch/transaction deletes. Every per-op simulate() call
       * for the SAME batch/transaction passes the SAME map, built once by
       * the caller (LocalEnvironment.batch()/transaction()) up front —
       * mirrors how the RTDB rules projection covers a multi-path update
       * in one shared tree. Omit for single-op evaluation.
       */
      batchProjection?: Map<string, Record<string, unknown> | null>;
    },
  ): TestFirestoreRulesResult {
    // Parse rules. Give the empty-input case a distinct, actionable
    // error — agents that see "Failed to parse rules source" otherwise
    // hex-dump the rules file looking for invisible characters before
    // realizing the source string is just empty (see
    // CLAUDE_DEBUG_SESSION.md).
    if (!source || source.trim().length === 0) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message:
            'Empty rules source — call sandbox.setRules(rules) before operating, '
            + 'or initialize without rules to use the open-by-default ruleset. '
            + 'See pyric/sandbox docs.',
          recoverable: true,
        },
      };
    }
    const ast = parseToAST(source);
    if (!ast) {
      return {
        success: false,
        error: { code: 'PARSE_FAILED', message: 'Failed to parse rules source', recoverable: true },
      };
    }

    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let unsupported = 0;

    // Resolve any wildcards on the root match (typically just one for
    // the database segment) and bind each to '(default)'. The root
    // wildcard can be named anything in production — `database`, `db`,
    // `dbId` are all valid — and `get(/databases/$(name)/...)` paths
    // inside rules expect that exact name to resolve. Previously we
    // hardcoded `database` only, so any other name silently became
    // `undefined` inside path interpolation and broke every `get()` /
    // `exists()` call.
    //
    // `database` stays seeded as a default so rules that don't use a
    // wildcard on the root match (or that hardcode `$(database)` in a
    // `get()` path) still work.
    const rootBindings: Record<string, string> = { database: '(default)' };
    for (const seg of ast.service.match.path.segments) {
      if (seg.type === 'wildcard') {
        rootBindings[seg.name] = '(default)';
      }
    }

    for (const tc of testCases) {
      // Resolve the match block for this path.
      // The root match is /databases/{database}/documents — skip it,
      // start matching from its children directly.
      const pathSegments = tc.path.split('/').filter(Boolean);
      const rootFunctions = ast.service.match.functions;
      // Collect EVERY match block that resolves this path (not just the
      // first). Production OR-combines allows across all overlapping
      // blocks, so we must evaluate them all. Order is preserved in source
      // order for deterministic, readable traces.
      let matches: MatchResult[] = [];
      // Fresh recorder per test case so each `TestResult.pathResolution`
      // captures only its own resolution attempts.
      const pathRecorder = new PathResolutionRecorder();
      for (const child of ast.service.match.children) {
        matches.push(...collectMatches(child, pathSegments, rootFunctions, pathRecorder));
      }
      // `list` targets a COLLECTION, but rules match blocks are document-
      // level: real Firestore evaluates a query against the doc block with
      // the document wildcard hypothetical (and `resource` undefined). When
      // a collection path resolves no block directly, retry with a
      // synthetic trailing document segment so `list menuItems` evaluates
      // `match /menuItems/{id}` exactly like the emulator does. Doc-style
      // list paths (`menuItems/any`) keep resolving on the first attempt,
      // so existing call sites are unaffected. (RULES-LIST parity pack.)
      let syntheticListDoc = false;
      if (matches.length === 0 && tc.method === 'list') {
        const widened = [...pathSegments, '__hypothetical_doc__'];
        for (const child of ast.service.match.children) {
          matches.push(...collectMatches(child, widened, rootFunctions, pathRecorder));
        }
        if (matches.length > 0) syntheticListDoc = true;
      }
      const pathResolution: PathResolutionTrace = {
        requestPath: tc.path,
        attempts: pathRecorder.attempts,
      };

      if (matches.length === 0) {
        // No match block at all → production default-DENY. Expectation
        // 'DENY' agrees → PASSED; expectation 'ALLOW' disagrees → FAILED.
        const state = tc.expectation === 'DENY' ? 'PASSED' : 'FAILED';
        if (state === 'PASSED') passed++; else failed++;
        results.push({
          description: tc.description,
          expectation: tc.expectation,
          state,
          decision: 'DENY',
          trace: [],
          notes: [`No match block found for path '${tc.path}'`],
          pathResolution,
        });
        continue;
      }

      // OR-combine every matching block. Production grants the request if
      // ANY matching block's applicable allow evaluates true; there is no
      // first-match-wins and no way for one block to revoke another's
      // grant. So we evaluate each block independently and short-circuit on
      // the first ALLOW. Each block builds its OWN context with its OWN
      // wildcard bindings (`rootBindings` carries the root-match wildcards
      // like `db`/`database` so `$(name)` interpolation inside
      // get()/exists() paths resolves; the block's own bindings override on
      // collision). Every rule-evaluation entry is tagged with its block's
      // path so a multi-block DENY trace stays unambiguous.
      //
      // Decision combine: ALLOW (any block) > UNSUPPORTED (any block
      // abstained on a sim gap, and nothing granted) > DENY (default —
      // nothing matched or nothing granted). ALLOW wins even over an
      // UNSUPPORTED sibling: a definite grant is not weakened by a sim gap
      // elsewhere. Only when NO block grants do we escalate to UNSUPPORTED,
      // so the agent sees "sim couldn't decide" rather than a false DENY.
      let decision: Decision = 'DENY';
      const trace: RuleEvaluation[] = [];
      const notes: string[] = [];
      let sawUnsupported = false;
      let grantingBlockPath: string | undefined;
      for (const match of matches) {
        const allFunctions = [...match.parentFunctions, ...match.block.functions];
        const pathVars = { ...rootBindings, ...match.pathVariables };
        const ctx = buildContext(tc, allFunctions, pathVars, opts?.getDoc, opts?.batchProjection);

        const blockPath = renderBlockPath(match.block);
        const res = evaluateRules(match.block, tc.method, ctx);
        for (const entry of res.trace) entry.matchPath = blockPath;
        trace.push(...res.trace);
        notes.push(...res.notes);

        if (res.decision === 'ALLOW') {
          decision = 'ALLOW';
          grantingBlockPath = blockPath;
          break;
        }
        if (res.decision === 'UNSUPPORTED') sawUnsupported = true;
      }
      if (decision !== 'ALLOW' && sawUnsupported) decision = 'UNSUPPORTED';
      if (decision === 'ALLOW' && grantingBlockPath) {
        notes.push(`Allowed by match block '${grantingBlockPath}'`);
      }
      if (syntheticListDoc) {
        notes.push(
          `list on collection path '${tc.path}' evaluated against the document-level match block (document wildcard hypothetical, resource undefined) — emulator-faithful`,
        );
      }

      // Compare with expectation. UNSUPPORTED is its own terminal state —
      // not PASSED (we didn't agree, we abstained) and not FAILED (the
      // failure is on the simulator's side, not the rule's).
      let state: 'PASSED' | 'FAILED' | 'UNSUPPORTED';
      if (decision === 'UNSUPPORTED') {
        state = 'UNSUPPORTED';
        unsupported++;
      } else if (decision === tc.expectation) {
        state = 'PASSED';
        passed++;
      } else {
        state = 'FAILED';
        failed++;
      }

      results.push({
        description: tc.description,
        expectation: tc.expectation,
        state,
        decision,
        trace,
        notes,
        pathResolution,
      });
    }

    return { success: true, data: { passed, failed, unsupported, results } };
  }
}
