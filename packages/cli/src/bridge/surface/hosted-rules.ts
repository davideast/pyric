/**
 * The surface's side of Firebase's hosted Rules Test API.
 *
 * `assurance.testRulesHosted` is the surface's first `production` method. The
 * call itself, and the credential discovery in front of it, belong to
 * `verify/`, which is where `pyric verify --engine rules-test-api` reaches
 * Google from too. What is left here is translation: turning that outcome into
 * the result shape every method on the surface returns.
 *
 * The order the boundary depends on is not translated, it is structural. The
 * effect gate refuses the call before this module is reached at all, the
 * confirmation is refused next, and `runHostedRulesTest` looks for credentials
 * before it builds a client. That is what lets a test prove a run without the
 * flag, without a confirmation, or without credentials never builds one.
 */
import {
  isMissingCredentials,
  runHostedRulesTest,
  type HostedRulesScope,
} from '../../verify/index.js';
import type { TestCase } from 'pyric/rules/internal';
import { operationFailure } from './context.js';
import type { OperationResult } from './types.js';

/**
 * Decide cases on the hosted API and report what came back in the surface's
 * own vocabulary: the credentials that were missing, the refusal Google
 * returned, or the counts one run produced.
 */
export async function hostedRulesTestResult(
  scope: HostedRulesScope,
  rules: string,
  cases: TestCase[],
): Promise<OperationResult> {
  const outcome = await runHostedRulesTest(scope, rules, cases);
  if (isMissingCredentials(outcome)) return operationFailure(outcome.missing);

  const { credentials, result } = outcome;
  if (!result.success) {
    return operationFailure(
      `The hosted Rules Test API refused the run: ${result.error.message}`,
      { code: result.error.code, project: credentials.scope.projectId },
    );
  }
  return {
    ok: result.data.failed === 0,
    summary: `The hosted Rules Test API passed ${result.data.passed} of ${cases.length} case(s) for project '${credentials.scope.projectId}'.`,
    data: {
      project: credentials.scope.projectId,
      credentials: credentials.source,
      passed: result.data.passed,
      failed: result.data.failed,
      unsupported: result.data.unsupported,
      results: result.data.results,
    },
  };
}
