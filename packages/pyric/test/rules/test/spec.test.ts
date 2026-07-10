import { describe, test, expect } from 'bun:test';
import {
  normalizeDocPath,
  buildApiTestCase,
  buildFunctionMock,
  renderLegacyDebugMessages,
} from '../../../src/rules/test/spec.js';
import type { TestCase, FunctionMock, TestResult } from '../../../src/rules/test/spec.js';

describe('normalizeDocPath', () => {
  test('converts simple path to full database path', () => {
    expect(normalizeDocPath('users/alice')).toBe(
      '/databases/(default)/documents/users/alice',
    );
  });

  test('strips leading slash before normalizing', () => {
    expect(normalizeDocPath('/users/alice')).toBe(
      '/databases/(default)/documents/users/alice',
    );
  });

  test('handles subcollection paths', () => {
    expect(normalizeDocPath('users/alice/posts/post1')).toBe(
      '/databases/(default)/documents/users/alice/posts/post1',
    );
  });
});

describe('buildApiTestCase', () => {
  test('forwards method as the short verb the Firestore rules engine expects', () => {
    const tc: TestCase = {
      description: 'test',
      expectation: 'ALLOW',
      method: 'get',
      path: 'users/alice',
      auth: { uid: 'user1' },
    };
    const api = buildApiTestCase(tc);
    expect(api.request.method).toBe('get');
  });

  test('wraps auth with uid and token', () => {
    const tc: TestCase = {
      description: 'test',
      expectation: 'ALLOW',
      method: 'get',
      path: 'users/alice',
      auth: { uid: 'user1', token: { admin: true } },
    };
    const api = buildApiTestCase(tc);
    expect(api.request.auth).toEqual({ uid: 'user1', token: { admin: true } });
  });

  test('wraps null auth as unauthenticated', () => {
    const tc: TestCase = {
      description: 'test',
      expectation: 'DENY',
      method: 'get',
      path: 'users/alice',
      auth: null,
    };
    const api = buildApiTestCase(tc);
    expect(api.request.auth).toBeUndefined();
  });

  test('wraps request.resource.data for write operations', () => {
    const tc: TestCase = {
      description: 'test',
      expectation: 'ALLOW',
      method: 'create',
      path: 'posts/new',
      auth: { uid: 'user1' },
      data: { title: 'Hello', author: 'user1' },
    };
    const api = buildApiTestCase(tc);
    expect(api.request.resource).toEqual({ data: { title: 'Hello', author: 'user1' } });
  });

  test('includes existing resource.data when provided', () => {
    const tc: TestCase = {
      description: 'test',
      expectation: 'ALLOW',
      method: 'update',
      path: 'posts/abc',
      auth: { uid: 'user1' },
      data: { title: 'Updated' },
      resource: { title: 'Original', author: 'user1' },
    };
    const api = buildApiTestCase(tc);
    expect(api.resource).toEqual({ data: { title: 'Original', author: 'user1' } });
  });

  test('forwards request.query for list cases', () => {
    const tc: TestCase = {
      description: 'bounded list',
      expectation: 'ALLOW',
      method: 'list',
      path: 'posts',
      auth: { uid: 'user1' },
      query: { limit: 10, orderBy: 'createdAt' },
    };
    const api = buildApiTestCase(tc);
    expect(api.request.query).toEqual({ limit: 10, orderBy: 'createdAt' });
  });

  test('forwards expression report level when requested', () => {
    const tc: TestCase = {
      description: 'trace',
      expectation: 'ALLOW',
      method: 'get',
      path: 'users/alice',
      auth: { uid: 'user1' },
    };
    const api = buildApiTestCase(tc, { expressionReportLevel: 'VISITED' });
    expect(api.expressionReportLevel).toBe('VISITED');
  });
});

describe('buildFunctionMock', () => {
  test('wraps get mock with correct path and data', () => {
    const mock: FunctionMock = {
      function: 'get',
      path: 'users/alice',
      result: { role: 'admin' },
    };
    const api = buildFunctionMock(mock);
    expect(api.function).toBe('get');
    expect(api.args[0].exactValue).toBe('/databases/(default)/documents/users/alice');
    expect(api.result).toEqual({ value: { data: { role: 'admin' } } });
  });

  test('wraps exists mock with true result as a bool value, not a map', () => {
    // exists() returns bool; the production Rules Test API rejects a
    // map-shaped mock result for it with "Type error. Received: [map]
    // Expected: [bool]", which silently resolves to DENY.
    const mock: FunctionMock = {
      function: 'exists',
      path: 'users/alice',
      result: true,
    };
    const api = buildFunctionMock(mock);
    expect(api.function).toBe('exists');
    expect(api.result).toEqual({ value: true });
  });

  test('wraps exists mock with false result as a bool value', () => {
    const mock: FunctionMock = {
      function: 'exists',
      path: 'users/bob',
      result: false,
    };
    const api = buildFunctionMock(mock);
    expect(api.result).toEqual({ value: false });
  });
});

describe('renderLegacyDebugMessages', () => {
  // The sandbox's RequestEvent / CommitOutcome surface consumes this output
  // verbatim (see packages/sandbox/src/firestore/local-environment.ts).
  // These tests pin the exact line format the sandbox depends on. Changes
  // here will break sandbox event consumers downstream — adjust those
  // explicitly, don't tweak this format casually.

  function baseResult(overrides: Partial<TestResult> = {}): TestResult {
    return {
      description: 'tc',
      expectation: 'ALLOW',
      state: 'PASSED',
      decision: 'ALLOW',
      trace: [],
      notes: [],
      ...overrides,
    };
  }

  test('ALLOW with a single matching rule renders rule line + final Simulated line', () => {
    const out = renderLegacyDebugMessages(baseResult({
      trace: [{ ruleIndex: 0, operations: ['read'], verdict: 'ALLOW' }],
    }));
    expect(out).toEqual([
      'Rule #0 (read) → ALLOW',
      'Simulated: ALLOW',
    ]);
  });

  test('DENY renders "deny" (lowercase) for each non-allowing rule', () => {
    // Verbatim spelling matches the pre-structured-trace simulator output.
    // The sandbox-side parser looks for `→ deny` and `→ unsupported`
    // tokens — capitalization differences would silently break it.
    const out = renderLegacyDebugMessages(baseResult({
      decision: 'DENY',
      state: 'FAILED',
      trace: [
        { ruleIndex: 0, operations: ['read'], verdict: 'DENY' },
        { ruleIndex: 1, operations: ['read'], verdict: 'DENY' },
      ],
    }));
    expect(out).toEqual([
      'Rule #0 (read) → deny',
      'Rule #1 (read) → deny',
      'Simulated: DENY',
    ]);
  });

  test('UNSUPPORTED renders the verdict + message inline', () => {
    const out = renderLegacyDebugMessages(baseResult({
      decision: 'UNSUPPORTED',
      state: 'UNSUPPORTED',
      trace: [{
        ruleIndex: 0,
        operations: ['read'],
        verdict: 'UNSUPPORTED',
        message: 'Unknown function: nonexistent',
      }],
    }));
    expect(out).toEqual([
      'Rule #0 (read) → unsupported: Unknown function: nonexistent',
      'Simulated: UNSUPPORTED',
    ]);
  });

  test('ERROR renders the verdict + message inline', () => {
    const out = renderLegacyDebugMessages(baseResult({
      decision: 'DENY',
      state: 'FAILED',
      trace: [{
        ruleIndex: 0,
        operations: ['update'],
        verdict: 'ERROR',
        message: 'Slice indices must be non-negative, got [-1:2]',
      }],
    }));
    expect(out).toEqual([
      'Rule #0 (update) → error: Slice indices must be non-negative, got [-1:2]',
      'Simulated: DENY',
    ]);
  });

  test('verdicts missing a `message` render with an empty tail (not "undefined")', () => {
    // Defensive — if a future codepath produces an UNSUPPORTED/ERROR entry
    // without a message, we don't want literal "undefined" leaking into
    // the sandbox event log.
    const out = renderLegacyDebugMessages(baseResult({
      decision: 'UNSUPPORTED',
      state: 'UNSUPPORTED',
      trace: [{ ruleIndex: 0, operations: ['read'], verdict: 'UNSUPPORTED' }],
    }));
    expect(out).toEqual([
      'Rule #0 (read) → unsupported: ',
      'Simulated: UNSUPPORTED',
    ]);
  });

  test('notes are emitted before per-rule lines and survive intact', () => {
    // No allow rule matched the operation — only the top-level note exists.
    // This is the "default deny" path that the playground UI surfaces as
    // a denial reason.
    const out = renderLegacyDebugMessages(baseResult({
      decision: 'DENY',
      state: 'FAILED',
      trace: [],
      notes: [`No allow rules found for operation 'list'`],
    }));
    expect(out).toEqual([
      `No allow rules found for operation 'list'`,
      'Simulated: DENY',
    ]);
  });

  test('multi-op rule renders operations comma-joined (no space)', () => {
    // `allow read, write: if ...` → ops joined as "read,write". The sandbox
    // splits on this token; a space would break it.
    const out = renderLegacyDebugMessages(baseResult({
      trace: [{ ruleIndex: 0, operations: ['read', 'write'], verdict: 'ALLOW' }],
    }));
    expect(out[0]).toBe('Rule #0 (read,write) → ALLOW');
  });

  test('always ends with `Simulated: <decision>` regardless of contents', () => {
    // Empty trace + empty notes still produces the trailing line — sandbox
    // consumers parse the last entry to extract the decision.
    const out = renderLegacyDebugMessages(baseResult({ decision: 'ALLOW' }));
    expect(out[out.length - 1]).toBe('Simulated: ALLOW');
  });
});
