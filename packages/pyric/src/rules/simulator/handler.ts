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
import { readAuthoredSourceMap, resolveAuthoredLoc, type AuthoredSourceMap } from '../modules/resolver-core.js';
import { evaluate, UnsupportedError, TraceRecorder, type SimulationContext } from './evaluator.js';

import { LookupBudget } from './lookup-budget.js';
import { ResourceLimitError } from './eval-error.js';
import { DOCUMENT_PATH_FORM, documentRelativePath } from './request-path.js';
import { buildContext } from './handler-context.js';
export { SERVER_TIMESTAMP, resolveServerTimestamps, reviveFirestoreNumbers } from './firestore-values.js';
import {
  collectMatches,
  renderMatchBlockPath,
  type MatchResult,
} from './match-resolution.js';

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
 * carries a per-request resource limit (the document access budget) that
 * the block ran into: it is not this block's private failure, so the caller
 * stops evaluating siblings and denies the whole request.
 */
interface RuleBlockOutcome {
  decision: Decision;
  trace: RuleEvaluation[];
  notes: string[];
  resourceLimit?: string;
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
  for (const { rule, index } of matchingRules) {
    const entry = newEntry(rule, index, sourceMap);
    const recorder = new TraceRecorder();
    ctx.trace = recorder;
    try {
      const result = evaluate(rule.condition, ctx);
      entry.expressionTrace = recorder.entries;
      const isAllowed = Boolean(result) === true;
      if (isAllowed) {
        entry.verdict = 'ALLOW';
        trace.push(entry);
        ctx.trace = priorRecorder;
        return { decision: 'ALLOW', trace, notes };
      }
      entry.verdict = 'DENY';
      trace.push(entry);
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
        trace.push(entry);
        ctx.trace = priorRecorder;
        notes.push(
          `Request denied by a rules resource limit: ${(e as ResourceLimitError).message}. `
          + 'The limit is per request, so no other allow rule or match block was evaluated.',
        );
        return {
          decision: 'DENY',
          trace,
          notes,
          resourceLimit: (e as ResourceLimitError).message,
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
      trace.push(entry);
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

// Context assembly delegated to handler-context.ts (buildContext)

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
            'Empty rules source — call setRules(sandbox, rules) from pyric/sandbox/firestore before operating, '
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
    return this.simulateParsed(ast, source, testCases, opts);
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
    },
  ): TestFirestoreRulesResult {
    const sourceMap = opts?.sourceMap ?? readAuthoredSourceMap(source);
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
      // Both the document-relative form and the full resource name the
      // console shows mean the same request, so the full form is reduced
      // before a block is resolved against it and every message about this
      // case names the reduced form.
      const requestPath = documentRelativePath(tc.path);
      const pathSegments = requestPath.split('/').filter(Boolean);
      // Functions declared at GLOBAL scope (above `service`) and SERVICE
      // scope (inside `service`, outside the documents match) seed the walk
      // alongside the documents-match's own (#346). Declaration order
      // global → service → match preserves inner-shadows-outer resolution,
      // since a later same-named entry wins in the evaluation context.
      const rootFunctions = [
        ...(ast.functions ?? []),
        ...(ast.service.functions ?? []),
        ...ast.service.match.functions,
      ];
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
      // so existing call sites are unaffected. (RULES-LIST parity scenario.)
      let syntheticListDoc = false;
      const isMatchesZero = matches.length === 0;
      const isListMethod = tc.method === 'list';
      if (isMatchesZero) {
        if (isListMethod) {
          const widened = [...pathSegments, '__hypothetical_doc__'];
          for (const child of ast.service.match.children) {
            matches.push(...collectMatches(child, widened, rootFunctions, pathRecorder));
          }
          const isMatchesNonZero = matches.length > 0;
          if (isMatchesNonZero) {
            syntheticListDoc = true;
          }
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
          trace: [],
          notes: [
            `No match block found for path '${requestPath}', so the request is denied by default.`,
            DOCUMENT_PATH_FORM,
          ],
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
      let hitResourceLimit = false;
      // One lookup budget per test case (one request evaluation), shared
      // across every matching block below and reset here between requests.
      // Production's single-request budget is 10 distinct document
      // accesses; transactions and batched writes additionally get a
      // 20-access aggregate that is NOT modeled, because each per-op
      // simulate() call in a batch (see WriteRuntime.buildBatchProjection)
      // gets its own fresh per-op budget of 10.
      const lookupBudget = new LookupBudget();
      for (const match of matches) {
        const pathVars = { ...rootBindings, ...match.pathVariables };
        const ctx = buildContext(tc, match.functions, pathVars, opts?.getDoc, opts?.batchProjection, lookupBudget);

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
          hitResourceLimit = true;
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
      const isEscalatable = decision !== 'ALLOW' && !hitResourceLimit;
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
        trace,
        notes,
        pathResolution,
      });
    }

    return { success: true, data: { passed, failed, unsupported, results } };
  }
}
