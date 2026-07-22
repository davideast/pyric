import { describe, test, expect, afterEach } from 'bun:test';
import { TestFirestoreRulesHandler, TestStorageRulesHandler } from '../../../src/rules/test/handler.js';
import type { ProjectScope } from '../../../src/project-scope.js';
import type { StorageTestCase, TestCase } from '../../../src/rules/test/spec.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

const MOCK_APP: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

const SAMPLE_SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId;
    }
  }
}`;

function makeTc(overrides: Partial<TestCase> = {}): TestCase {
  return {
    description: 'test case',
    expectation: 'ALLOW',
    method: 'get',
    path: 'users/alice',
    auth: { uid: 'alice' },
    ...overrides,
  };
}

function mockTestApi(response: object, status = 200) {
  (global as any).fetch = async () =>
    new Response(JSON.stringify(response), { status });
}

describe('TestFirestoreRulesHandler', () => {
  const handler = new TestFirestoreRulesHandler();

  test('all tests pass → correct passed/failed counts', async () => {
    mockTestApi({
      testResults: [
        { state: 'SUCCESS', debugMessages: [] },
        { state: 'SUCCESS', debugMessages: [] },
      ],
    });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc(), makeTc()]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(2);
      expect(result.data.failed).toBe(0);
      expect(result.data.results).toHaveLength(2);
    }
  });

  test('mixed results → 1 pass + 1 fail', async () => {
    mockTestApi({
      testResults: [
        { state: 'SUCCESS', debugMessages: [] },
        { state: 'FAILURE', debugMessages: ['Denied'] },
      ],
    });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [
      makeTc({ description: 'allow auth user' }),
      makeTc({ description: 'deny unauth', expectation: 'DENY', auth: null }),
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(1);
      expect(result.data.failed).toBe(1);
    }
  });

  test('all fail → 0 passed, 2 failed', async () => {
    mockTestApi({
      testResults: [
        { state: 'FAILURE', debugMessages: ['Denied'] },
        { state: 'FAILURE', debugMessages: ['Denied'] },
      ],
    });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc(), makeTc()]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(0);
      expect(result.data.failed).toBe(2);
    }
  });

  test.each([
    ['missing', []],
    ['extra', [{ state: 'SUCCESS' }, { state: 'SUCCESS' }]],
  ])('fails closed when the wire response has %s result rows', async (_label, testResults) => {
    mockTestApi({ testResults });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FETCH_FAILED');
      expect(result.error.message).toContain('for 1 test case(s)');
    }
  });

  test('sends POST to correct URL', async () => {
    let capturedUrl = '';
    (global as any).fetch = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });
    };
    await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(capturedUrl).toBe('https://firebaserules.googleapis.com/v1/projects/test-project:test');
  });

  test('sends correct auth header', async () => {
    let capturedHeaders: Record<string, string> = {};
    (global as any).fetch = async (_url: string, init: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });
    };
    await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(capturedHeaders['authorization']).toBe('Bearer mock-token');
  });

  test('request body has source + testSuite structure', async () => {
    let capturedBody: any = {};
    (global as any).fetch = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });
    };
    await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(capturedBody.source.files[0].name).toBe('firestore.rules');
    expect(capturedBody.source.files[0].content).toBe(SAMPLE_SOURCE);
    expect(capturedBody.testSuite.testCases).toHaveLength(1);
  });

  test('forwards query and expressionReportLevel to the API request', async () => {
    let capturedBody: any = {};
    (global as any).fetch = async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });
    };
    await handler.execute(
      MOCK_APP,
      SAMPLE_SOURCE,
      [makeTc({ method: 'list', path: 'users', query: { limit: 5 } })],
      { expressionReportLevel: 'VISITED' },
    );
    const apiCase = capturedBody.testSuite.testCases[0];
    expect(apiCase.expressionReportLevel).toBe('VISITED');
    expect(apiCase.request.query).toEqual({ limit: 5 });
  });

  test('preserves API diagnostics on successful results', async () => {
    mockTestApi({
      issues: [{ description: 'lint-ish warning', severity: 'WARNING' }],
      testResults: [
        {
          state: 'SUCCESS',
          debugMessages: ['ok'],
          errorPosition: { line: 4, column: 7 },
          functionCalls: [{ function: 'get' }],
          visitedExpressions: [{ sourcePosition: { line: 5 } }],
          expressionReports: [{ values: [] }],
        },
      ],
    });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([{ description: 'lint-ish warning', severity: 'WARNING' }]);
      expect(result.data.results[0].api?.errorPosition).toEqual({ line: 4, column: 7 });
      expect(result.data.results[0].api?.functionCalls).toEqual([{ function: 'get' }]);
      expect(result.data.results[0].api?.visitedExpressions).toEqual([{ sourcePosition: { line: 5 } }]);
      expect(result.data.results[0].api?.expressionReports).toEqual([{ values: [] }]);
    }
  });

  test('403 → PERMISSION_DENIED', async () => {
    mockTestApi({}, 403);
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
    }
  });

  test('400 → INVALID_REQUEST (recoverable)', async () => {
    mockTestApi({}, 400);
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.recoverable).toBe(true);
    }
  });

  test('network error → FETCH_FAILED', async () => {
    (global as any).fetch = async () => { throw new Error('Network down'); };
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FETCH_FAILED');
      expect(result.error.message).toContain('Network down');
    }
  });

  test('API returns issues (rule syntax error) → RULES_ERROR', async () => {
    mockTestApi({
      issues: [{ description: 'Unexpected token', severity: 'ERROR' }],
    });
    const result = await handler.execute(MOCK_APP, SAMPLE_SOURCE, [makeTc()]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RULES_ERROR');
      expect(result.error.message).toContain('Unexpected token');
    }
  });
});

describe('TestStorageRulesHandler wire result identity', () => {
  const handler = new TestStorageRulesHandler();
  const source = `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read: if true; } } }`;
  const testCase: StorageTestCase = {
    description: 'storage probe', expectation: 'ALLOW', method: 'get', path: 'a.txt', auth: null,
  };

  test.each([
    ['missing', []],
    ['extra', [{ state: 'SUCCESS' }, { state: 'SUCCESS' }]],
  ])('fails closed when the wire response has %s result rows', async (_label, testResults) => {
    mockTestApi({ testResults });
    const result = await handler.execute(MOCK_APP, source, [testCase]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FETCH_FAILED');
      expect(result.error.message).toContain('for 1 test case(s)');
    }
  });
});
