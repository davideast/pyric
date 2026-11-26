/**
 * Firestore Rules Simulation Handler.
 *
 * Local simulation of Firestore security rules evaluation.
 * Same interface as TestFirestoreRulesHandler but runs entirely
 * in-process -- no deployment, no propagation wait, no side effects.
 *
 * Consumes TestCase[] and returns TestResult[] in the same format
 * as the Rules Test API.
 */
import { normalizeAuthState } from '../auth/auth-state.js';
import type { FirestoreRules, ImportDecl } from '../grammar/FirestoreAST.js';
import { checkRulesSource } from '../grammar/source-compile-limits.js';
import { readAuthoredSourceMap, type AuthoredSourceMap } from '../modules/resolver-core.js';
import { requestTimeRefusal, safeErrorMessage, safeReadProp } from '../test/case-refusals.js';
import { caseShapeRefusal } from '../test/case-shape.js';
import type {
  PathResolutionEntry,
  PathResolutionTrace,
  RuleEvaluation,
  RulesResourceLimit,
  TestCase,
  TestFirestoreRulesResult,
  TestResult,
} from '../test/spec.js';
import { ExpressionLimitError } from './eval-error.js';
import type { SimulationContext } from './evaluator.js';
import { ExpressionBudget } from './expression-budget.js';
import { reviveCaseLiterals, reviveFirestoreNumbers } from './firestore-values.js';
import {
  listQueryToConstraints,
  proveListQuery,
  renderQueryRemediation,
  type ListQueryProofReport,
  type QueryProofFailure,
} from './list-query-proof.js';
import { LookupBudget } from './lookup-budget.js';
import { indexRulesetScopes, renderMatchBlockPath, type MatchResult } from './match-resolution.js';
import { documentRelativePath, requestDatabaseId } from './request-path.js';
import { collectRootMatches, noMatchNotes } from './root-match.js';
import { evaluateRules, type Decision } from './rule-block-evaluator.js';
import { buildContext, type CaseReviver } from './simulation-context.js';

export { SERVER_TIMESTAMP } from './firestore-values.js';

/**
 * Collects per-block resolution attempts as `resolveMatch` walks the
 * match-block tree. The handler instantiates one per test case and attaches
 * the resulting `attempts` array to `TestResult.pathResolution`.
 */
class PathResolutionRecorder {
  readonly attempts: PathResolutionEntry[] = [];
  push(entry: PathResolutionEntry): void {
    this.attempts.push(entry);
  }
}

export interface SimulateOptions {
  getDoc?: SimulationContext['getDoc'];
  /**
   * Shared post-commit projection for a batch or transaction. Keyed by
   * normalized relative path; value is the post-write document, or `null`
   * for a path the batch/transaction deletes. Omit for single-op evaluation.
   */
  batchProjection?: Map<string, Record<string, unknown> | null>;
  /**
   * The cases come from a caller of the public API (`simulate()`, the MCP
   * `firestore_simulate_rules` tool), not from pyric's own data plane. Each
   * case's shape is checked first, and one the Rules Test API would read as a
   * different request is UNSUPPORTED with the reason (`caseShapeRefusal`).
   */
  publicCases?: boolean;
  /**
   * Active Firestore database id for root matching, `request.path`, and
   * cross-database lookup checks. When omitted, inferred from a full
   * `/databases/<database>/documents/...` request path or defaulted to
   * `'(default)'`. If both are provided and differ, the case is refused.
   */
  database?: string;
}

function resolveTargetDatabase(tcPath: string, optionDatabase?: string): string {
  const pathDb = requestDatabaseId(tcPath);
  if (pathDb === '.' || pathDb === '..') {
    throw new Error(`Invalid database id '${pathDb}' in request path '${tcPath}'.`);
  }
  let explicitDb: string | undefined;
  if (optionDatabase !== undefined && optionDatabase.length > 0) {
    if (optionDatabase === '.' || optionDatabase === '..') {
      throw new Error(`Invalid database id '${optionDatabase}'.`);
    }
    explicitDb = optionDatabase;
  }
  if (explicitDb !== undefined && pathDb !== undefined && explicitDb !== pathDb) {
    throw new Error(
      `Request path database '${pathDb}' does not match target database '${explicitDb}'.`,
    );
  }
  return explicitDb ?? pathDb ?? '(default)';
}

/** Why the simulator cannot run `tc` as it stands, or `undefined`. */
function intakeRefusal(tc: TestCase, publicCases: boolean): string | undefined {
  if (publicCases) return caseShapeRefusal(tc);
  return requestTimeRefusal(tc.requestTime);
}

/** The result for a case intake refused: UNSUPPORTED, with the reason. */
function refusedResult(tc: TestCase, reason: string): TestResult {
  const desc = safeReadProp(tc, 'description');
  const exp = safeReadProp(tc, 'expectation');
  return {
    description: typeof desc === 'string' ? desc : '',
    expectation: exp === 'ALLOW' ? 'ALLOW' : 'DENY',
    state: 'UNSUPPORTED',
    decision: 'UNSUPPORTED',
    evaluatedExpressions: 0,
    trace: [],
    notes: [reason],
  };
}

function unprovableReportFromFailure(
  failures: QueryProofFailure[],
  primary: QueryProofFailure,
): ListQueryProofReport {
  const remediation = renderQueryRemediation(primary.residual);
  return {
    verdict: 'UNPROVABLE',
    provable: false,
    kind: primary.kind,
    failures,
    reason: primary.reason,
    residual: primary.residual,
    ...(remediation ? { remediation } : {}),
    ...(primary.rule ? { rule: { ...primary.rule, verdict: 'deny' as const } } : {}),
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
    if (!source || source.trim().length === 0) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message:
            'Empty rules source \u2014 call setRules(sandbox, rules) from pyric/sandbox/firestore before operating, '
            + 'or initialize without rules to use the open-by-default ruleset. '
            + 'See pyric/sandbox docs.',
          recoverable: true,
        },
      };
    }
    const checked = checkRulesSource(source);
    if (!checked.ok) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message: `Firestore ${checked.rejection.message}`,
          recoverable: true,
        },
      };
    }
    return this.simulateParsed(checked.ast, source, testCases, opts);
  }

  /**
   * Evaluate test cases against an already parsed ruleset.
   */
  simulateParsed(
    ast: FirestoreRules,
    source: string,
    testCases: TestCase[],
    opts?: SimulateOptions & {
      /** The source map read from `source`, when the caller keeps it. */
      sourceMap?: AuthoredSourceMap;
      /** Authored `2+modules` imports when `source` was lowered in-process from `2+modules`. */
      authoredImports?: readonly ImportDecl[];
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

    const publicCases = opts?.publicCases === true;
    const revive: CaseReviver = publicCases ? reviveCaseLiterals : reviveFirestoreNumbers;
    for (const tc of testCases) {
      try {
        const refusal = intakeRefusal(tc, publicCases);
        if (refusal !== undefined) {
          unsupported++;
          results.push(refusedResult(tc, refusal));
          continue;
        }

        const targetDatabase = resolveTargetDatabase(tc.path, opts?.database);
        const requestPath = documentRelativePath(tc.path);
        const pathSegments = requestPath.split('/').filter(Boolean);
        const isListMethod = tc.method === 'list';
        const isCollectionPath = pathSegments.length % 2 === 1;

        let queryProof: ListQueryProofReport | undefined;
        let evalAst = ast;
        let evalTc = tc;
        if (isListMethod && !opts?.skipQueryProof) {
          let proofPath: string;
          if (pathSegments.length === 0) {
            proofPath = '__listPlaceholder__';
          } else if (isCollectionPath) {
            proofPath = `${requestPath}/__listPlaceholder__`;
          } else {
            proofPath = requestPath;
          }
          const constraints = listQueryToConstraints(tc.query);
          const rawProof = proveListQuery(
            ast,
            proofPath,
            tc.auth ? normalizeAuthState(tc.auth) : null,
            constraints,
            source,
            targetDatabase,
          );
          if (rawProof.kind === 'no-rule') {
            queryProof = {
              verdict: 'NO_RULE',
              provable: false,
              kind: 'no-rule',
              failures: [],
            };
          } else if (rawProof.kind === 'unprovable') {
            const primary =
              rawProof.failures.find((f) => f.kind !== 'constraints-not-satisfied')
              ?? rawProof.failures[0];
            if (primary !== undefined) {
              queryProof = unprovableReportFromFailure(rawProof.failures, primary);
            }
          } else {
            let mergedResource: Record<string, unknown> = rawProof.syntheticResource;
            if (tc.resource !== undefined) {
              mergedResource = { ...rawProof.syntheticResource, ...tc.resource };
            }
            const residualCheck = this.simulateParsed(
              rawProof.evaluationAst,
              source,
              [{ ...tc, path: proofPath, resource: mergedResource, expectation: 'ALLOW' }],
              { ...opts, database: targetDatabase, sourceMap, skipQueryProof: true },
            );
            let residualResult: TestResult | undefined;
            if (residualCheck.success) {
              residualResult = residualCheck.data.results[0];
            }
            const hitLimit = residualResult?.resourceLimit;
            const fallbackDenied =
              rawProof.failures.length > 0 &&
              residualResult !== undefined &&
              residualResult.decision !== 'ALLOW';

            if (hitLimit !== undefined) {
              const primary =
                rawProof.failures.find((f) => f.kind !== 'constraints-not-satisfied')
                ?? rawProof.failures[0];
              const remediation = primary ? renderQueryRemediation(primary.residual) : undefined;
              queryProof = {
                verdict: 'UNPROVABLE',
                provable: false,
                kind: primary?.kind ?? 'unsupported-predicate',
                failures: rawProof.failures,
                reason: hitLimit.message,
                residual: primary?.residual ?? { missing: [], mismatched: [], outOfScope: true },
                ...(remediation ? { remediation } : {}),
                ...(primary?.rule ? { rule: { ...primary.rule, verdict: 'deny' as const } } : {}),
              };
            } else if (fallbackDenied) {
              const primary =
                rawProof.failures.find((f) => f.kind !== 'constraints-not-satisfied')
                ?? rawProof.failures[0];
              if (primary !== undefined) {
                queryProof = unprovableReportFromFailure(rawProof.failures, primary);
              }
            } else {
              queryProof = {
                verdict: 'PROVABLE',
                provable: true,
                kind: 'provable',
                failures: rawProof.failures,
              };
            }
            if (isCollectionPath || tc.resource === undefined) {
              evalAst = rawProof.evaluationAst;
              evalTc = { ...tc, resource: mergedResource };
            }
          }
        }

        const rootFunctions = [
          ...(evalAst.functions ?? []),
          ...(evalAst.service.functions ?? []),
        ];
        let matches: MatchResult[] = [];
        const pathRecorder = new PathResolutionRecorder();
        matches.push(
          ...collectRootMatches(evalAst, requestPath, rootFunctions, pathRecorder, targetDatabase),
        );

        let syntheticListDoc = false;
        if (isListMethod && isCollectionPath) {
          const widened = [...pathSegments, '__hypothetical_doc__'];
          const widenedMatches = collectRootMatches(
            evalAst,
            widened.join('/'),
            rootFunctions,
            pathRecorder,
            targetDatabase,
          );
          if (widenedMatches.length > 0) {
            matches = widenedMatches;
            syntheticListDoc = true;
          }
        }
        const pathResolution: PathResolutionTrace = {
          requestPath,
          attempts: pathRecorder.attempts,
        };

        if (matches.length === 0) {
          const state = tc.expectation === 'DENY' ? 'PASSED' : 'FAILED';
          if (state === 'PASSED') passed++; else failed++;
          results.push({
            description: tc.description,
            expectation: tc.expectation,
            state,
            decision: 'DENY',
            evaluatedExpressions: 0,
            trace: [],
            notes: noMatchNotes(evalAst, requestPath, targetDatabase),
            pathResolution,
            ...(queryProof ? { queryProof } : {}),
          });
          continue;
        }

        let decision: Decision = 'DENY';
        const trace: RuleEvaluation[] = [];
        const notes: string[] = [];
        let sawUnsupported = false;
        let grantingBlockPath: string | undefined;
        let resourceLimit: RulesResourceLimit | undefined;
        let stoppedByLimit = false;
        const lookupBudget = new LookupBudget();
        const expressionBudget = new ExpressionBudget(
          (message, position) => new ExpressionLimitError(message, position),
        );
        for (const match of matches) {
          const ctx = buildContext(
            evalTc,
            match.functions,
            match.pathVariables,
            opts?.getDoc,
            opts?.batchProjection,
            lookupBudget,
            expressionBudget,
            revive,
            match.recursiveVariables,
            match.functionScopes,
            targetDatabase,
          );

          const blockPath = renderMatchBlockPath(match.block);
          const res = evaluateRules(match.block, tc.method, ctx, sourceMap, opts?.authoredImports);
          for (const entry of res.trace) {
            entry.matchPath = blockPath;
          }
          trace.push(...res.trace);
          notes.push(...res.notes);

          const hitBlockLimit = res.resourceLimit;
          if (hitBlockLimit !== undefined) {
            decision = 'DENY';
            stoppedByLimit = true;
            const earlierError = trace.slice(0, -1).find((t) => t.verdict === 'ERROR');
            if (hitBlockLimit.kind === 'expressions' && earlierError) {
              notes.push(
                `The request reached the limit (${hitBlockLimit.message}) after an earlier allow rule raised an error; `
                + `production reports that earlier error: ${earlierError.message ?? 'evaluation error'}`,
              );
            } else {
              resourceLimit = hitBlockLimit;
            }
            break;
          }
          if (res.decision === 'ALLOW') {
            decision = 'ALLOW';
            grantingBlockPath = blockPath;
            break;
          }
          if (res.decision === 'UNSUPPORTED') {
            sawUnsupported = true;
          }
        }

        if (decision !== 'ALLOW' && !stoppedByLimit && sawUnsupported) {
          decision = 'UNSUPPORTED';
        }
        if (decision === 'ALLOW' && grantingBlockPath !== undefined) {
          notes.push(`Allowed by match block '${grantingBlockPath}'`);
        }
        if (syntheticListDoc) {
          notes.push(
            `list on collection path '${tc.path}' evaluated against the document-level match block (document wildcard hypothetical, resource undefined) \u2014 emulator-faithful`,
          );
        }

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
      } catch (error) {
        unsupported++;
        results.push(refusedResult(tc, `Case refused: ${safeErrorMessage(error)}`));
      }
    }

    return { success: true, data: { passed, failed, unsupported, results } };
  }
}
