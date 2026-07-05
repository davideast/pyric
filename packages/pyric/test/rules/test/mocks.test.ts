import { describe, test, expect, afterEach } from 'bun:test';
import { TestFirestoreRulesHandler } from '../../../src/rules/test/handler.js';
import type { ProjectScope } from 'pyric-tools/deploy';
import type { TestCase, FunctionMock } from '../../../src/rules/test/spec.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

const MOCK_APP: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

const SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
  }
}`;

function captureBody(): { get: () => any } {
  let body: any;
  (global as any).fetch = async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });
  };
  return { get: () => body };
}

describe('Function mock translation', () => {
  const handler = new TestFirestoreRulesHandler();

  test('get mock produces correct API shape', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'admin can read',
      expectation: 'ALLOW',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      functionMocks: [{ function: 'get', path: 'users/user1', result: { role: 'admin' } }],
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const apiMock = captured.get().testSuite.testCases[0].functionMocks[0];
    expect(apiMock.function).toBe('get');
    expect(apiMock.result).toEqual({ value: { data: { role: 'admin' } } });
  });

  test('exists mock with true produces correct API shape', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'exists check',
      expectation: 'ALLOW',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      functionMocks: [{ function: 'exists', path: 'users/user1', result: true }],
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const apiMock = captured.get().testSuite.testCases[0].functionMocks[0];
    expect(apiMock.function).toBe('exists');
    expect(apiMock.result).toEqual({ value: { data: {} } });
  });

  test('exists mock with false produces undefined result', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'not exists',
      expectation: 'DENY',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      functionMocks: [{ function: 'exists', path: 'users/user1', result: false }],
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const apiMock = captured.get().testSuite.testCases[0].functionMocks[0];
    expect(apiMock.result).toBeUndefined();
  });

  test('mock path gets normalized with database prefix', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'path normalization',
      expectation: 'ALLOW',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      functionMocks: [{ function: 'get', path: 'users/user1', result: { role: 'admin' } }],
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const apiMock = captured.get().testSuite.testCases[0].functionMocks[0];
    expect(apiMock.args[0].exactValue).toBe('/databases/(default)/documents/users/user1');
  });

  test('multiple mocks on same test case', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'multiple mocks',
      expectation: 'ALLOW',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      functionMocks: [
        { function: 'get', path: 'users/user1', result: { role: 'admin' } },
        { function: 'exists', path: 'profiles/user1', result: true },
      ],
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const mocks = captured.get().testSuite.testCases[0].functionMocks;
    expect(mocks).toHaveLength(2);
    expect(mocks[0].function).toBe('get');
    expect(mocks[1].function).toBe('exists');
  });

  test('no mocks → functionMocks omitted from API request', async () => {
    const captured = captureBody();
    const tc: TestCase = {
      description: 'no mocks',
      expectation: 'ALLOW',
      method: 'get',
      path: 'posts/abc',
      auth: { uid: 'user1' },
    };
    await handler.execute(MOCK_APP, SOURCE, [tc]);
    const apiTc = captured.get().testSuite.testCases[0];
    expect(apiTc.functionMocks).toBeUndefined();
  });
});
