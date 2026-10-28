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
  RulesResourceLimit,
} from '../test/spec.js';
import type { FirestoreRules, MatchBlock, AllowRule, FunctionDef, Expression } from '../grammar/FirestoreAST.js';
import { checkRulesSource } from '../grammar/source-compile-limits.js';
import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import { readAuthoredSourceMap, resolveAuthoredLoc, type AuthoredSourceMap } from '../modules/resolver-core.js';
import { evaluate, requireBoolean, UnsupportedError, TraceRecorder, type SimulationContext } from './evaluator.js';

import { Timestamp } from './wrappers/timestamp.js';
import { Path } from './wrappers/path.js';
import { DOCUMENT_LOOKUP_LIMIT, LookupBudget } from './lookup-budget.js';
import { EXPRESSION_LIMIT, ExpressionBudget, describeExpressionLimit } from './expression-budget.js';
import { ExpressionLimitError, ResourceLimitError } from './eval-error.js';
import { projectAfterState } from './project-after-state.js';
import { documentRelativePath } from './request-path.js';
import { normalizeDocumentPath } from './document-lookups.js';
import {
  requestQuery,
  resolveServerTimestamps,
  reviveCaseLiterals,
  reviveFirestoreNumbers,
} from './firestore-values.js';
import { caseShapeRefusal } from '../test/case-shape.js';
import { requestTimeRefusal } from '../test/case-refusals.js';
export { SERVER_TIMESTAMP, resolveServerTimestamps, reviveFirestoreNumbers } from './firestore-values.js';
import { collectRootMatches, noMatchNotes } from './root-match.js';
import {
  indexRulesetScopes,
  renderMatchBlockPath,
  type MatchResult,
} from './match-resolution.js';
import {
  listQueryToConstraints,
  proveListQuery,
  renderQueryRemediation,
  type ListQueryProofReport,
} from './list-query-proof.js';

type Decision = 'ALLOW' | 'DENY' | 'UNSUPPORTED';

// ═══ Match block resolution ═══

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
 * One match block's contribution to the request verdict. `resourceLimit`
 * carries a per-request resource limit (the document access budget or the
 * expression budget) that the block ran into: it is not this block's
 * private failure, so the caller stops evaluating siblings and denies the
 * whole request.
 */
interface RuleBlockOutcome {
  decision: Decision;
  trace: RuleEvaluation[];
  notes: string[];
  resourceLimit?: RulesResourceLimit;
}

function describeResourceLimit(e: ResourceLimitError): RulesResourceLimit {
  if (e instanceof ExpressionLimitError) {
    return {
      kind: 'expressions',
      limit: EXPRESSION_LIMIT,
      message: e.message,
      ...(e.position === undefined ? {} : { line: e.position.line, column: e.position.column }),
    };
  }
  return { kind: 'document-lookups', limit: DOCUMENT_LOOKUP_LIMIT, message: e.message };
}

/**
 * Evaluate all allow rules in a match block for a given operation.
 * Uses OR semantics — if any matching rule allows, access is granted.
 *
 * Decision logic:
 *   - any rule ALLOW → ALLOW (short-circuit)
 *   - else if any rule hit a per-request resource limit → DENY, and the
 *     caller stops: the limit ends the request, not just this block
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
  sourceMap?: AuthoredSourceMap,
): RuleBlockOutcome {
  const ops = methodToOperations(operation);
  const trace: RuleEvaluation[] = [];
  const notes: string[] = [];

  // Find allow rules that match this operation
  const matchingRules: { rule: AllowRule; index: number }[] = [];
  for (let i = 0; i < block.allows.length; i++) {
    const rule = block.allows[i]!;
    const hasOp = rule.operations.some((op) => ops.includes(op));
    if (hasOp) {
      matchingRules.push({ rule, index: i });
    }
  }

  const isNoRules = matchingRules.length === 0;
  if (isNoRules) {
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
  // Each entry records the request's running expression count at the point
  // its rule's evaluation ended.
  const record = (entry: RuleEvaluation) => {
    if (ctx.expressionBudget) entry.evaluatedExpressions = ctx.expressionBudget.evaluated;
    trace.push(entry);
  };
  for (const { rule, index } of matchingRules) {
    const entry = newEntry(rule, index, sourceMap);
    const recorder = new TraceRecorder();
    ctx.trace = recorder;
    try {
      // The condition must be a bool: any other value is a type error, which
      // the catch below records as this rule's ERROR verdict.
      const isAllowed = requireBoolean(evaluate(rule.condition, ctx), rule.condition);
      entry.expressionTrace = recorder.entries;
      if (isAllowed) {
        entry.verdict = 'ALLOW';
        record(entry);
        ctx.trace = priorRecorder;
        return { decision: 'ALLOW', trace, notes };
      }
      entry.verdict = 'DENY';
      record(entry);
    } catch (e) {
      entry.expressionTrace = recorder.entries;
      // A per-request resource limit (the document access budget) is not a
      // failure of THIS rule: production stops the whole request there, so
      // no sibling allow rule and no other match block gets a chance to
      // grant. Abandon the loop and report the limit up to the caller.
      const isResourceLimit = e instanceof ResourceLimitError;
      if (isResourceLimit) {
        entry.verdict = 'ERROR';
        entry.message = (e as ResourceLimitError).message;
        record(entry);
        ctx.trace = priorRecorder;
        const resourceLimit = describeResourceLimit(e as ResourceLimitError);
        // Production reports the expression limit at the expression the
        // budget ran out on, so the note cites that position.
        const position = resourceLimit.line === undefined || resourceLimit.column === undefined
          ? undefined
          : { line: resourceLimit.line, column: resourceLimit.column };
        const cited = describeExpressionLimit(resourceLimit.message, position);
        notes.push(
          `Request denied by a rules resource limit: ${cited.endsWith('.') ? cited : `${cited}.`} `
          + 'The limit is per request, so no other allow rule or match block was evaluated.',
        );
        return {
          decision: 'DENY',
          trace,
          notes,
          resourceLimit,
        };
      }
      const isUnsupported = e instanceof UnsupportedError;
      if (isUnsupported) {
        sawUnsupported = true;
        entry.verdict = 'UNSUPPORTED';
        entry.message = (e as UnsupportedError).message;
      } else {
        entry.verdict = 'ERROR';
        const isErrorInstance = e instanceof Error;
        if (isErrorInstance) {
          entry.message = (e as Error).message;
        } else {
          entry.message = String(e);
        }
      }
      record(entry);
    }
  }
  ctx.trace = priorRecorder;

  // No rule allowed. If at least one rule abstained on a sim gap, escalate
  // to UNSUPPORTED so the agent sees "sim couldn't decide" rather than a
  // misleading DENY. If every failure was a real eval error, return DENY
  // (production would also deny on runtime errors).
  let finalDecision: Decision = 'DENY';
  if (sawUnsupported) {
    finalDecision = 'UNSUPPORTED';
  }
  return { decision: finalDecision, trace, notes };
}

function newEntry(rule: AllowRule, index: number, sourceMap?: AuthoredSourceMap): RuleEvaluation {
  const condText = assembleExpression(rule.condition);
  const entry: RuleEvaluation = {
    ruleIndex: index,
    operations: [...rule.operations],
    verdict: 'DENY',
    conditionText: condText,
  };
  const hasLoc = rule.loc !== undefined;
  if (hasLoc) {
    const loc = rule.loc!;
    entry.line = loc.line;
    entry.col = loc.col;
    entry.column = loc.col;
    const hasFile = loc.file !== undefined;
    if (hasFile) {
      entry.file = loc.file;
      entry.citation = `${loc.file}:${loc.line}:${loc.col}`;
    } else {
      entry.file = 'firestore.rules';
      entry.citation = `firestore.rules:${loc.line}:${loc.col}`;
    }
    const hasSourceMap = sourceMap !== undefined;
    if (hasSourceMap) {
      const authored = resolveAuthoredLoc(sourceMap!, loc.line, loc.col, loc.file, condText);
      const hasAuthored = authored !== undefined;
      if (hasAuthored) {
        entry.line = authored!.line;
        entry.col = authored!.col;
        entry.column = authored!.col;
        entry.file = authored!.file;
        entry.citation = authored!.citation;
        const hasExpr = authored!.expression !== undefined;
        if (hasExpr) {
          entry.conditionText = authored!.expression;
        }
      }
    }
  }
  return entry;
}

// ═══ Build simulation context from TestCase ═══

/** Reads a case's values into the simulator's value model. */
type CaseReviver = (value: unknown) => unknown;

function buildContext(
  tc: TestCase,
  functions: FunctionDef[],
  pathVariables: Record<string, string>,
  getDoc?: (path: string) => Record<string, unknown> | null,
  batchProjection?: Map<string, Record<string, unknown> | null>,
  lookupBudget?: LookupBudget,
  expressionBudget?: ExpressionBudget,
  revive: CaseReviver = reviveFirestoreNumbers,
): SimulationContext {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of functions) fnMap.set(fn.name, fn);

  // `get` and `exists` are separate Rules Test API functions with separate
  // mocks (FS-CON-6): a get mock seeds get()'s document, an exists mock only
  // answers exists(). Both key on the normalized document path, the form
  // lookups resolve and `buildFunctionMock` sends to production, so mock
  // order and path spelling do not change the verdict.
  const mockDocs = new Map<string, Record<string, unknown>>();
  const identitylessFunctionMocks = new Set<string>();
  const existsMocks = new Map<string, boolean>();
  for (const mock of tc.functionMocks ?? []) {
    const mockPath = normalizeDocumentPath(mock.path);
    if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
      mockDocs.set(mockPath, revive(mock.result) as Record<string, unknown>);
      identitylessFunctionMocks.add(mockPath);
    } else if (mock.function === 'exists') {
      existsMocks.set(mockPath, mock.result === true);
    }
  }

  // request.time defaults to wallclock; tc.requestTime (Item 0.F) lets
  // tests pin a deterministic value for date-gated rules. Item 1.3
  // flipped the in-evaluator type from ISO string to Timestamp wrapper
  // (REBUILD_PLAN Risk 1) — `tc.requestTime` stays an ISO string for
  // backwards-compat with the prod Test API, parsed here. Intake has
  // already refused one that is not an ISO-8601 instant with an offset.
  const serverTime = tc.requestTime
    ? Timestamp.fromIsoString(tc.requestTime)
    : Timestamp.fromMillis(Date.now());

  // Item 6: build the full document path for request.path / __name__.
  // tc.path arrives as a relative path like "users/alice" or as the full
  // resource name; both name one document, so both give the single spec
  // form /databases/(default)/documents/<rel> (FS2-CON-1).
  const relPath = documentRelativePath(tc.path);
  const fullPathSegs = ['databases', '(default)', 'documents', ...relPath.split('/').filter(Boolean)];
  // Pass pathVariables as bindings so `request.path.<name>` (where <name> is
  // a wildcard from the matched rule, e.g. {uid}) returns the bound segment
  // value instead of null. Without this, named-field access on request.path
  // silently DENYs any rule that reads it.
  const fullPath = new Path(fullPathSegs, pathVariables);
  // NOTE: no document id is derived here. Production does not expose one on
  // `resource` (see the `resource` construction below, RULES-B12) — the id a
  // rule can legitimately read comes from the match-path wildcard (`/{id}`).

  // Item 7 — project the after-state.
  //
  // If tc.writeMode is set (Item 0.D), run projectAfterState to derive both
  // request.resource.data and what getAfter() returns. Otherwise preserve
  // legacy behavior where tc.data IS the after-state for create/update,
  // tc.resource for read methods, and null for delete. The legacy fallback
  // keeps every existing test passing while letting new tests opt into
  // proper merge semantics.
  const payload = revive(tc.data ?? {}) as Record<string, unknown>;
  const existing = tc.resource === undefined || tc.resource === null
    ? null
    : revive(tc.resource) as Record<string, unknown>;
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
    ? revive(resolveServerTimestamps(afterState, serverTime)) as Record<string, unknown>
    : null;

  // request.resource is populated on create/update (from projectedAfter ?? {})
  // and on get/list/delete only when the caller explicitly supplied `tc.data`
  // (matching the Rules Test API wire format `if (tc.data) request.resource = { data }`).
  // On normal get, list, and delete requests (no `tc.data`), `resource` is absent
  // from `request` ("Property resource is undefined on object.").
  let reqResource: { data: Record<string, unknown> } | undefined;
  if (tc.method === 'create' || tc.method === 'update') {
    reqResource = { data: projectedAfter ?? {} };
  } else if (tc.data !== undefined) {
    const revivedTcData = revive(
      resolveServerTimestamps(tc.data, serverTime),
    ) as Record<string, unknown>;
    reqResource = { data: revivedTcData };
  }

  const request: SimulationContext['request'] = {
    auth: tc.auth ? { uid: tc.auth.uid, token: tc.auth.token ?? {} } : null,
    method: tc.method,
    path: fullPath,        // Item 6: Path wrapper, full /databases/.../documents/... form
    ...(requestQuery(tc) ? { query: requestQuery(tc) } : {}),
    time: serverTime,
  } as SimulationContext['request'];
  if (reqResource !== undefined) {
    request.resource = reqResource;
  }

  return {
    request,
    // `resource` is the PRE-WRITE stored document. When the request target does
    // not exist, production makes `resource` a null error value — reading or
    // comparing it then errors → DENY. Synthesizing a resource here (the
    // previous behavior) was a FALSE-ALLOW for common ownership/existence
    // idioms (`resource.data.owner == request.auth.uid`, `resource != null`).
    //
    // RULES-B12: for get/list/update/delete the resource carries `data` ONLY.
    // Production builds `resource` from the stored document alone and does NOT
    // derive an identity from the request path, so `resource.id` /
    // `resource.__name__` are ABSENT and reading either errors:
    //   "Property id is undefined on object."
    //   "Property __name__ is undefined on object."
    // → DENY (surviving negation, absorbed only by a determining `||`).
    // Synthesizing `id`/`__name__` from tc.path made `resource.id == id` ALLOW
    // where production DENIES — an OVER-PERMISSIVE divergence. Omitting the
    // keys hands the evaluator's absent-key error path the same verdict prod
    // gives. Note: `request.resource` (proposed data) is built separately above
    // and is likewise `{ data }` only — `request.resource.id` errors in prod too.
    resource: tc.method === 'create' || existing === null
      ? null
      : { data: revive(existing) as Record<string, unknown> },  // NOT resolved — resource is pre-write, no sentinels
    mockDocuments: mockDocs,
    identitylessFunctionMocks,
    existsMocks,
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
    // Per-request document access budget (10 distinct lookups). The SAME
    // instance is threaded into every match block's context for one test
    // case, because production's budget spans overlapping match blocks and
    // OR'd allow rules within one request evaluation. An absent budget and
    // an `undefined` one mean the same thing here: no budget is enforced.
    lookupBudget,
    // Per-request expression budget (1000 expressions), shared the same way.
    expressionBudget,
  };
}

// ═══ Main handler ═══

export interface SimulateOptions {
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
  /**
   * The cases come from a caller of the public API (`simulate()`, the MCP
   * `firestore_simulate_rules` tool), not from pyric's own data plane. Each
   * case's shape is checked first, and one the Rules Test API would read as a
   * different request is UNSUPPORTED with the reason (`caseShapeRefusal`). A
   * plain map with a `__type` key reads as the map it is, as production reads
   * it; only a value helper's value is a typed value (FS2-CON-5).
   */
  publicCases?: boolean;
}

/** Why the simulator can't run `tc` as it stands, or `undefined`. */
function intakeRefusal(tc: TestCase, publicCases: boolean): string | undefined {
  if (publicCases) return caseShapeRefusal(tc);
  return requestTimeRefusal(tc.requestTime);
}

/** The result for a case intake refused: UNSUPPORTED, with the reason. */
function refusedResult(tc: TestCase, reason: string): TestResult {
  const shape = (typeof tc === 'object' && tc !== null ? tc : {}) as Partial<TestCase>;
  return {
    description: typeof shape.description === 'string' ? shape.description : '',
    expectation: shape.expectation === 'ALLOW' ? 'ALLOW' : 'DENY',
    state: 'UNSUPPORTED',
    decision: 'UNSUPPORTED',
    evaluatedExpressions: 0,
    trace: [],
    notes: [reason],
  };
}

export class SimulateFirestoreRulesHandler {
  /**
   * Simulate Firestore rules evaluation locally.
   * Same interface as TestFirestoreRulesHandler.execute().
   */
  simulate(
    source: string,
    testCases: TestCase[],
    opts?: SimulateOptions,
  ): TestFirestoreRulesResult {
    // Parse rules. Give the empty-input case a distinct, actionable
    // error: agents that see a bare parse failure otherwise
    // hex-dump the rules file looking for invisible characters before
    // realizing the source string is just empty (see
    // CLAUDE_DEBUG_SESSION.md).
    if (!source || source.trim().length === 0) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message:
            'Empty rules source — call setRules(sandbox, rules) from pyric/sandbox/firestore before operating, '
            + 'or initialize without rules to use the open-by-default ruleset. '
            + 'See pyric/sandbox docs.',
          recoverable: true,
        },
      };
    }
    // Production rejects a ruleset that does not parse, or is past its
    // compile limits (call depth, `let` count, nesting), before evaluating
    // any request. The reason is the one every rules load path refuses with.
    const checked = checkRulesSource(source);
    if (!checked.ok) {
      return {
        success: false,
        error: { code: 'PARSE_FAILED', message: `Firestore ${checked.rejection.message}`, recoverable: true },
      };
    }
    return this.simulateParsed(checked.ast, source, testCases, opts);
  }

  /**
   * Evaluate test cases against an already parsed ruleset. Callers that
   * evaluate the same deployed rules on every request hold the parsed AST
   * and pass it here, so a request costs evaluation only, not a parse.
   *
   * `ast` is read, never mutated, so one AST can serve any number of
   * requests. `source` is the deployed source the AST came from: rule
   * locations resolve through the source map it carries, unless
   * `opts.sourceMap` supplies that map already read.
   */
  simulateParsed(
    ast: FirestoreRules,
    source: string,
    testCases: TestCase[],
    opts?: SimulateOptions & {
      /** The source map read from `source`, when the caller keeps it. */
      sourceMap?: AuthoredSourceMap;
      /** Internal flag to skip re-running static query proof during residual evaluation. */
      skipQueryProof?: boolean;
    },
  ): TestFirestoreRulesResult {
    indexRulesetScopes(ast);
    const sourceMap = opts?.sourceMap ?? readAuthoredSourceMap(source);
    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let unsupported = 0;

    // The root match is compared with each request below
    // (`collectRootMatches`), and its wildcard bindings reach every block it
    // resolves. `database` stays seeded so a rule that hardcodes
    // `$(database)` in a `get()` path still resolves under a root that names
    // its wildcard `db` or `dbId`.
    const rootBindings: Record<string, string> = { database: '(default)' };

    const publicCases = opts?.publicCases === true;
    const revive: CaseReviver = publicCases ? reviveCaseLiterals : reviveFirestoreNumbers;
    for (const tc of testCases) {
      // A case either engine would read as a different request, or one with
      // an instant that is not ISO-8601 with an offset, is refused here
      // rather than answered (FS2-CON-2, FS2-CON-3, FS2-CON-12).
      const refusal = intakeRefusal(tc, publicCases);
      if (refusal !== undefined) {
        unsupported++;
        results.push(refusedResult(tc, refusal));
        continue;
      }
      // Resolve the match blocks for this path. The root match is compared
      // with the request's full resource name first, and its children match
      // what it leaves (FS2-ENF-1).
      // Both the document-relative form and the full resource name the
      // console shows mean the same request, so the full form is reduced
      // before a block is resolved against it and every message about this
      // case names the reduced form.
      const requestPath = documentRelativePath(tc.path);
      const pathSegments = requestPath.split('/').filter(Boolean);
      const isListMethod = tc.method === 'list';
      const isCollectionPath = pathSegments.length % 2 === 1;

      // Static list-query provability (#371): for `list` cases, run
      // `proveListQuery` and report the proof verdict separately from
      // document-evaluation (`decision` / `state`).
      let queryProof: ListQueryProofReport | undefined;
      let evalAst = ast;
      let evalTc = tc;
      if (isListMethod && !opts?.skipQueryProof) {
        const proofPath = pathSegments.length === 0
          ? '__listPlaceholder__'
          : (isCollectionPath ? `${requestPath}/__listPlaceholder__` : requestPath);
        const constraints = listQueryToConstraints(tc.query);
        const rawProof = proveListQuery(ast, proofPath, tc.auth ?? null, constraints, source);
        if (rawProof.kind === 'no-rule') {
          queryProof = {
            verdict: 'NO_RULE',
            provable: false,
            kind: 'no-rule',
            failures: [],
          };
        } else if (rawProof.kind === 'unprovable') {
          const primary = rawProof.failures.find((f) => f.kind !== 'constraints-not-satisfied') ?? rawProof.failures[0]!;
          const remediation = renderQueryRemediation(primary.residual);
          queryProof = {
            verdict: 'UNPROVABLE',
            provable: false,
            kind: primary.kind,
            failures: rawProof.failures,
            reason: primary.reason,
            residual: primary.residual,
            ...(remediation ? { remediation } : {}),
            ...(primary.rule ? { rule: { ...primary.rule, verdict: 'deny' as const } } : {}),
          };
        } else {
          // `rawProof.kind === 'provable'`. When some rules were rejected by
          // static proof (`rawProof.failures.length > 0`) and only a subset
          // (such as a fallback `allow read: if false;` or an admin rule) was
          // statically doc-independent, check whether those provable rules
          // actually grant for this request. If they deny, no provable rule
          // granted and the query failed because of `rawProof.failures`.
          let fallbackDenied = false;
          if (rawProof.failures.length > 0) {
            const residualCheck = this.simulateParsed(
              rawProof.evaluationAst,
              source,
              [{ ...tc, path: proofPath, resource: rawProof.syntheticResource, expectation: 'ALLOW' }],
              { ...opts, sourceMap, skipQueryProof: true },
            );
            if (residualCheck.success && residualCheck.data.results[0]?.decision !== 'ALLOW') {
              fallbackDenied = true;
            }
          }
          if (fallbackDenied) {
            const primary = rawProof.failures.find((f) => f.kind !== 'constraints-not-satisfied') ?? rawProof.failures[0]!;
            const remediation = renderQueryRemediation(primary.residual);
            queryProof = {
              verdict: 'UNPROVABLE',
              provable: false,
              kind: primary.kind,
              failures: rawProof.failures,
              reason: primary.reason,
              residual: primary.residual,
              ...(remediation ? { remediation } : {}),
              ...(primary.rule ? { rule: { ...primary.rule, verdict: 'deny' as const } } : {}),
            };
          } else {
            queryProof = {
              verdict: 'PROVABLE',
              provable: true,
              kind: 'provable',
              failures: rawProof.failures,
            };
          }
          // When the caller did not mock a single document (`tc.resource === undefined`)
          // and supplied `query.where` constraints that proved the query, evaluate
          // the residual rules against the query-pinned synthetic resource.
          if (tc.resource === undefined && (tc.query?.where?.length ?? 0) > 0) {
            evalAst = rawProof.evaluationAst;
            evalTc = { ...tc, resource: rawProof.syntheticResource };
          }
        }
      }

      // Functions declared at GLOBAL scope (above `service`) and SERVICE
      // scope (inside `service`, outside the documents match) seed the walk
      // alongside the documents-match's own (#346). Declaration order
      // global → service → match preserves inner-shadows-outer resolution,
      // since a later same-named entry wins in the evaluation context.
      const rootFunctions = [
        ...(evalAst.functions ?? []),
        ...(evalAst.service.functions ?? []),
        ...evalAst.service.match.functions,
      ];
      // Collect EVERY match block that resolves this path (not just the
      // first). Production OR-combines allows across all overlapping
      // blocks, so we must evaluate them all. Order is preserved in source
      // order for deterministic, readable traces.
      let matches: MatchResult[] = [];
      // Fresh recorder per test case so each `TestResult.pathResolution`
      // captures only its own resolution attempts.
      const pathRecorder = new PathResolutionRecorder();
      matches.push(...collectRootMatches(evalAst, requestPath, rootFunctions, pathRecorder));
      // `list` targets a COLLECTION, but rules match blocks are document-
      // level: real Firestore evaluates a query against the doc block with
      // the document wildcard hypothetical (and `resource` undefined). When
      // a collection path resolves no block directly, retry with a
      // synthetic trailing document segment so `list menuItems` evaluates
      // `match /menuItems/{id}` exactly like the emulator does. Doc-style
      // list paths (`menuItems/any`) keep resolving on the first attempt,
      // so existing call sites are unaffected. (RULES-LIST parity scenario.)
      //
      // A collection path (odd segment count) always widens, not only when
      // nothing matched: a `{document=**}` block also matches the bare
      // collection path, and evaluating only that block let a sibling
      // recursive deny shadow `match /menuItems/{id}`'s list grant
      // (FS-COV-6b). The widened path's blocks are the ones the document-path
      // form `list menuItems/<id>` resolves, which production ORs (corpus
      // `simcase-mock-and-path-fidelity`). When the widened path matches
      // nothing, the direct matches stand.
      //
      // A document-style path (even segment count) is never widened: it
      // already names a document of the queried collection, and one segment
      // deeper reaches only blocks no document of that collection matches,
      // such as a version 1 `{document=**}` under `/cities/{city}` for the
      // sandbox's `cities/__listPlaceholder__` (#1428).
      let syntheticListDoc = false;
      const shouldWiden = isListMethod && isCollectionPath;
      if (shouldWiden) {
        const widened = [...pathSegments, '__hypothetical_doc__'];
        const widenedMatches = collectRootMatches(evalAst, widened.join('/'), rootFunctions, pathRecorder);
        const isWidenedNonZero = widenedMatches.length > 0;
        if (isWidenedNonZero) {
          matches = widenedMatches;
          syntheticListDoc = true;
        }
      }
      const pathResolution: PathResolutionTrace = {
        requestPath,
        attempts: pathRecorder.attempts,
      };

      const isNoMatches = matches.length === 0;
      if (isNoMatches) {
        // No match block at all → production default-DENY. Expectation
        // 'DENY' agrees → PASSED; expectation 'ALLOW' disagrees → FAILED.
        const state = tc.expectation === 'DENY' ? 'PASSED' : 'FAILED';
        if (state === 'PASSED') passed++; else failed++;
        results.push({
          description: tc.description,
          expectation: tc.expectation,
          state,
          decision: 'DENY',
          evaluatedExpressions: 0,
          trace: [],
          notes: noMatchNotes(evalAst, requestPath),
          pathResolution,
          ...(queryProof ? { queryProof } : {}),
        });
        continue;
      }

      // OR-combine every matching block. Production grants the request if
      // ANY matching block's applicable allow evaluates true; there is no
      // first-match-wins and no way for one block to revoke another's
      // grant. So we evaluate each block independently and short-circuit on
      // the first ALLOW. Each block builds its OWN context with its OWN
      // wildcard bindings (each match carries the root-match wildcards
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
      let resourceLimit: RulesResourceLimit | undefined;
      let stoppedByLimit = false;
      // One lookup budget per test case (one request evaluation), shared
      // across every matching block below and reset here between requests.
      // Production's single-request budget is 10 distinct document
      // accesses; transactions and batched writes additionally get a
      // 20-access aggregate that is NOT modeled, because each per-op
      // simulate() call in a batch (see WriteRuntime.buildBatchProjection)
      // gets its own fresh per-op budget of 10.
      const lookupBudget = new LookupBudget();
      // One expression budget per request, shared the same way: production
      // counts every allow rule and match block the request evaluates
      // toward one limit of 1000.
      const expressionBudget = new ExpressionBudget((message, position) => new ExpressionLimitError(message, position));
      for (const match of matches) {
        const pathVars = { ...rootBindings, ...match.pathVariables };
        const ctx = buildContext(evalTc, match.functions, pathVars, opts?.getDoc, opts?.batchProjection, lookupBudget, expressionBudget, revive);

        const blockPath = renderMatchBlockPath(match.block);
        const res = evaluateRules(match.block, tc.method, ctx, sourceMap);
        for (const entry of res.trace) {
          entry.matchPath = blockPath;
        }
        trace.push(...res.trace);
        notes.push(...res.notes);

        // A per-request resource limit ends the request: production stops
        // the whole evaluation, so a later match block cannot grant.
        const isResourceLimit = res.resourceLimit !== undefined;
        if (isResourceLimit) {
          decision = 'DENY';
          stoppedByLimit = true;
          // Production goes on to a method's later allow rules after one
          // raises an error, so the limit can be reached after that error.
          // It then reports the earlier error, not the limit; the trace
          // keeps the limit on the rule that reached it.
          const earlierError = trace.slice(0, -1).find((t) => t.verdict === 'ERROR');
          if (res.resourceLimit!.kind === 'expressions' && earlierError) {
            notes.push(
              `The request reached the limit (${res.resourceLimit!.message}) after an earlier allow rule raised an error; `
              + `production reports that earlier error: ${earlierError.message ?? 'evaluation error'}`,
            );
          } else {
            resourceLimit = res.resourceLimit;
          }
          break;
        }
        const isResAllow = res.decision === 'ALLOW';
        if (isResAllow) {
          decision = 'ALLOW';
          grantingBlockPath = blockPath;
          break;
        }
        const isUnsupported = res.decision === 'UNSUPPORTED';
        if (isUnsupported) {
          sawUnsupported = true;
        }
      }
      // A resource limit is a definite production DENY, so it outranks an
      // UNSUPPORTED abstention recorded by an earlier block.
      const isEscalatable = decision !== 'ALLOW' && !stoppedByLimit;
      if (isEscalatable) {
        if (sawUnsupported) {
          decision = 'UNSUPPORTED';
        }
      }
      const isDecisionAllow = decision === 'ALLOW';
      if (isDecisionAllow) {
        const hasGrantingBlock = grantingBlockPath !== undefined;
        if (hasGrantingBlock) {
          notes.push(`Allowed by match block '${grantingBlockPath}'`);
        }
      }
      const isSynthetic = syntheticListDoc === true;
      if (isSynthetic) {
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
        evaluatedExpressions: expressionBudget.evaluated,
        ...(resourceLimit ? { resourceLimit } : {}),
        ...(queryProof ? { queryProof } : {}),
        trace,
        notes,
        pathResolution,
      });
    }

    return { success: true, data: { passed, failed, unsupported, results } };
  }
}
