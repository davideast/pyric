import type { ProjectScope } from '../../project-scope.js';
import type { TestCase, TestResult, TestFirestoreRulesResult, ApiTestCase } from './spec.js';
import { buildApiTestCase } from './spec.js';

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

export class TestFirestoreRulesHandler {
  async execute(
    scope: ProjectScope,
    source: string,
    testCases: TestCase[],
  ): Promise<TestFirestoreRulesResult> {
    try {
      const token = await scope.resolveToken();

      const apiTestCases: ApiTestCase[] = testCases.map(buildApiTestCase);

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
        issues?: Array<{ sourcePosition?: unknown; description: string; severity: string }>;
        testResults?: Array<{ state: 'SUCCESS' | 'FAILURE'; debugMessages?: string[] }>;
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
        return {
          description: tc.description,
          expectation: tc.expectation,
          state,
          decision,
          trace: [],
          notes: apiResult?.debugMessages ?? [],
        };
      });

      const passed = results.filter(r => r.state === 'PASSED').length;
      const failed = results.filter(r => r.state === 'FAILED').length;
      // Production Test API never emits UNSUPPORTED, but the result type
      // requires the field — see TestResult.state in spec.ts (Item 0.A).
      const unsupported = 0;

      return { success: true, data: { passed, failed, unsupported, results } };
    } catch (e) {
      return {
        success: false,
        error: { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}
