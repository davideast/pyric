import type { ProjectScope } from '../../project-scope.js';
import type {
  ApiTestCase,
  ExpressionReportLevel,
  RulesTestApiResultDetails,
  RulesTestIssue,
  StorageApiTestCase,
  StorageTestCase,
  TestCase,
  TestFirestoreRulesResult,
  TestResult,
} from './spec.js';
import { buildApiTestCase, buildStorageApiTestCase } from './spec.js';

const RULES_API = 'https://firebaserules.googleapis.com/v1';

/**
 * Firebase Rules Test API client. The `execute` shape changed in
 * Slice 6 from `execute(app: AgentApp, …)` → `execute(scope: ProjectScope, …)`
 * — see pre-mortem M2. Any external caller still passing an
 * `AgentApp` should wrap it:
 *
 * ```ts
 * await handler.execute(
 *   { projectId: app.projectId, resolveToken: () => app.getRestToken() },
 *   source,
 *   testCases,
 * );
 * ```
 */
function oppositeOf(expectation: 'ALLOW' | 'DENY'): 'ALLOW' | 'DENY' {
  return expectation === 'ALLOW' ? 'DENY' : 'ALLOW';
}

export interface TestFirestoreRulesOptions {
  expressionReportLevel?: ExpressionReportLevel;
}

interface ApiTestResult {
  state: 'SUCCESS' | 'FAILURE';
  debugMessages?: string[];
  errorPosition?: unknown;
  functionCalls?: unknown[];
  visitedExpressions?: unknown[];
  expressionReports?: unknown[];
}

export class TestFirestoreRulesHandler {
  async execute(
    scope: ProjectScope,
    source: string,
    testCases: TestCase[],
    opts: TestFirestoreRulesOptions = {},
  ): Promise<TestFirestoreRulesResult> {
    try {
      const token = await scope.resolveToken();

      const apiTestCases: ApiTestCase[] = testCases.map((tc) =>
        buildApiTestCase(tc, { expressionReportLevel: opts.expressionReportLevel }));

      const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: { files: [{ name: 'firestore.rules', content: source }] },
          testSuite: { testCases: apiTestCases },
        }),
      });

      if (res.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Service account lacks permission to test Firestore rules', recoverable: false },
        };
      }

      if (res.status === 400) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          error: { code: 'INVALID_REQUEST', message: `Invalid request: ${body}`, recoverable: true },
        };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          error: { code: 'FETCH_FAILED', message: `Rules test failed: ${res.status} ${body}`, recoverable: false },
        };
      }

      const data = await res.json() as {
        issues?: RulesTestIssue[];
        testResults?: ApiTestResult[];
      };

      // If the API returns issues (rule syntax errors), report them
      if (data.issues && data.issues.length > 0 && (!data.testResults || data.testResults.length === 0)) {
        const messages = data.issues.map(i => i.description).join('; ');
        return {
          success: false,
          error: { code: 'RULES_ERROR', message: messages, recoverable: true },
        };
      }

      const testResults = data.testResults ?? [];
      const results: TestResult[] = testCases.map((tc, i) => {
        const apiResult = testResults[i];
        const state: 'PASSED' | 'FAILED' = apiResult?.state === 'SUCCESS' ? 'PASSED' : 'FAILED';
        // Production Test API doesn't surface a per-rule structured trace —
        // only opaque `debugMessages` text. Derive the absolute decision
        // from `state` + expectation (state=SUCCESS ⇒ matched expectation),
        // and surface the raw text on `notes` so callers that need detail
        // can still inspect it. `trace` stays empty for this code path.
        const decision: 'ALLOW' | 'DENY' = state === 'PASSED' ? tc.expectation : oppositeOf(tc.expectation);
        const details = apiDetails(apiResult);
        return {
          description: tc.description,
          expectation: tc.expectation,
          state,
          decision,
          trace: [],
          notes: apiResult?.debugMessages ?? [],
          ...(details ? { api: details } : {}),
        };
      });

      const passed = results.filter(r => r.state === 'PASSED').length;
      const failed = results.filter(r => r.state === 'FAILED').length;
      // Production Test API never emits UNSUPPORTED, but the result type
      // requires the field — see TestResult.state in spec.ts (Item 0.A).
      const unsupported = 0;

      return {
        success: true,
        data: {
          passed,
          failed,
          unsupported,
          results,
          ...(data.issues ? { issues: data.issues } : {}),
        },
      };
    } catch (e) {
      return {
        success: false,
        error: { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}

/**
 * Firebase Rules Test API client for `service firebase.storage` rulesets.
 *
 * A near-mirror of {@link TestFirestoreRulesHandler}: it POSTs to the SAME
 * `projects.test` endpoint (live-confirmed to accept Storage rulesets), but
 * uses {@link buildStorageApiTestCase} for the wire shape and a `storage.rules`
 * source filename. The result envelope is identical, so the oracle capture
 * runner and any caller can treat Firestore and Storage rule tests uniformly.
 */
export class TestStorageRulesHandler {
  async execute(
    scope: ProjectScope,
    source: string,
    testCases: StorageTestCase[],
  ): Promise<TestFirestoreRulesResult> {
    try {
      const token = await scope.resolveToken();

      const apiTestCases: StorageApiTestCase[] = testCases.map(buildStorageApiTestCase);

      const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: { files: [{ name: 'storage.rules', content: source }] },
          testSuite: { testCases: apiTestCases },
        }),
      });

      if (res.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Service account lacks permission to test Storage rules', recoverable: false },
        };
      }

      if (res.status === 400) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          error: { code: 'INVALID_REQUEST', message: `Invalid request: ${body}`, recoverable: true },
        };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          error: { code: 'FETCH_FAILED', message: `Rules test failed: ${res.status} ${body}`, recoverable: false },
        };
      }

      const data = await res.json() as {
        issues?: RulesTestIssue[];
        testResults?: ApiTestResult[];
      };

      if (data.issues && data.issues.length > 0 && (!data.testResults || data.testResults.length === 0)) {
        const messages = data.issues.map(i => i.description).join('; ');
        return {
          success: false,
          error: { code: 'RULES_ERROR', message: messages, recoverable: true },
        };
      }

      const testResults = data.testResults ?? [];
      const results: TestResult[] = testCases.map((tc, i) => {
        const apiResult = testResults[i];
        const state: 'PASSED' | 'FAILED' = apiResult?.state === 'SUCCESS' ? 'PASSED' : 'FAILED';
        const decision: 'ALLOW' | 'DENY' = state === 'PASSED' ? tc.expectation : oppositeOf(tc.expectation);
        const details = apiDetails(apiResult);
        return {
          description: tc.description,
          expectation: tc.expectation,
          state,
          decision,
          trace: [],
          notes: apiResult?.debugMessages ?? [],
          ...(details ? { api: details } : {}),
        };
      });

      const passed = results.filter(r => r.state === 'PASSED').length;
      const failed = results.filter(r => r.state === 'FAILED').length;

      return {
        success: true,
        data: {
          passed,
          failed,
          unsupported: 0,
          results,
          ...(data.issues ? { issues: data.issues } : {}),
        },
      };
    } catch (e) {
      return {
        success: false,
        error: { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}

function apiDetails(result: ApiTestResult | undefined): RulesTestApiResultDetails | undefined {
  if (!result) return undefined;
  const details: RulesTestApiResultDetails = {};
  if (result.errorPosition !== undefined) details.errorPosition = result.errorPosition;
  if (result.functionCalls !== undefined) details.functionCalls = result.functionCalls;
  if (result.visitedExpressions !== undefined) details.visitedExpressions = result.visitedExpressions;
  if (result.expressionReports !== undefined) details.expressionReports = result.expressionReports;
  return Object.keys(details).length > 0 ? details : undefined;
}
