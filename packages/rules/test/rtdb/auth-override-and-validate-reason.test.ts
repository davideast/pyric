import { describe, expect, test } from 'bun:test';
import { assertCase, rtdbRules } from '../../src/index.js';
import { normalizeAuthState } from '../../src/auth/auth-state.js';

describe('RTDB auth overrides and validation refusal reasons (#3001, #3002)', () => {
  test('rtdbRules.simulate preserves top-level override fields on auth and does not synthesize ID-token claims', () => {
    const rules = rtdbRules({
      rules: {
        items: {
          $id: {
            '.read': "auth != null && auth.role == 'writer'",
            '.write':
              "auth != null && auth.uid == 'u1' && auth.role == 'writer' && auth.token == null && auth.token.sub == null && auth.token.iat == null && auth.token.firebase == null",
          },
        },
        scoped: {
          $id: {
            '.write':
              "auth != null && auth.role == 'writer' && auth.token.scope == 'items' && auth.token.sub == null && auth.token.iat == null && auth.token.firebase == null",
          },
        },
        providers: {
          $id: {
            '.write':
              "auth != null && auth.provider == 'anonymous' && auth.token.firebase.sign_in_provider == 'password'",
          },
        },
      },
    });

    const summary = rules.simulate([
      {
        description: 'top-level auth.role grants without synthesized auth.token',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/items/a',
        auth: { uid: 'u1', role: 'writer' },
        newData: { title: 'ok' },
      },
      {
        description: 'wrong top-level auth.role is denied',
        expectation: 'DENY',
        operation: 'read',
        path: '/items/a',
        auth: { uid: 'u1', role: 'reader' },
      },
      {
        description: 'override auth.token carries only its own claims',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/scoped/a',
        auth: { uid: 'u1', role: 'writer', token: { scope: 'items' } },
        newData: 1,
      },
      {
        description: 'explicit top-level auth.provider overrides token.firebase.sign_in_provider',
        expectation: 'ALLOW',
        operation: 'write',
        path: '/providers/a',
        auth: {
          uid: 'alice',
          provider: 'anonymous',
          token: { firebase: { sign_in_provider: 'password' } },
        },
        newData: 1,
      },
    ]);

    expect(summary.failed).toBe(0);
    expect(summary.unsupported).toBe(0);
    expect(summary.passed).toBe(4);
  });

  test('normalizeAuthState deep-clones extra top-level fields without mutating caller input', () => {
    const scopes = { write: ['items'] };
    const input = { uid: 'u1', role: 'writer', scopes };
    const normalized = normalizeAuthState(input);
    expect(normalized).toEqual({
      uid: 'u1',
      role: 'writer',
      scopes: { write: ['items'] },
    });
    expect('token' in (normalized ?? {})).toBe(false);
    scopes.write.push('tampered');
    expect((normalized?.scopes as { write: string[] }).write).toEqual(['items']);
  });

  test('validation refusal reason names the refusing rule path in single-path writes and multi-path updates (#3002)', () => {
    const rules = rtdbRules({
      rules: {
        items: {
          $id: {
            '.write': true,
            size: { '.validate': 'newData.isNumber() && newData.val() < 10' },
            name: { '.validate': 'newData.isString() && newData.val().length > 0' },
          },
        },
      },
    });

    const [updateDenial, validateDenial] = rules.simulate([
      {
        description: 'multi-path update names /items/$id/size when size exceeds 10',
        expectation: 'DENY',
        operation: 'update',
        path: '/',
        newData: { 'items/a/size': 20, 'items/a/name': 'x' },
      },
      {
        description: 'validate operation names /items/$id/name when name is empty',
        expectation: 'DENY',
        operation: 'validate',
        path: '/items/a/name',
        newData: '',
      },
    ]).cases;

    expect(updateDenial?.passed).toBe(true);
    expect(updateDenial?.matchedPath).toBe('/items/$id/size');
    expect(updateDenial?.reason).toBe("Validation rule at '/items/$id/size' evaluated to false");

    expect(validateDenial?.passed).toBe(true);
    expect(validateDenial?.matchedPath).toBe('/items/$id/name');
    expect(validateDenial?.reason).toBe("Validation rule at '/items/$id/name' evaluated to false");

    expect(() =>
      assertCase(rules, {
        description: 'oversized item in multi-path update',
        expectation: 'ALLOW',
        operation: 'update',
        path: '/',
        newData: { 'items/a/size': 20, 'items/a/name': 'x' },
      }),
    ).toThrow("reason: Validation rule at '/items/$id/size' evaluated to false");
  });
});
