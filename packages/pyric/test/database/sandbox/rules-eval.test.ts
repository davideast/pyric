import { describe, expect, test } from 'bun:test';
import { RulesEvaluator } from '../../../src/database/sandbox/rules-eval.js';

describe('01-rtdb-sandbox-auth-token-claims', () => {
  test('RulesEvaluator.evaluate projects standard user profile and JWT claims into auth.token', () => {
    const evaluator = new RulesEvaluator();
    evaluator.setRules({
      rules: {
        profile: {
          '.read':
            "auth.token.sub == 'user-1' && auth.token.user_id == 'user-1' && auth.token.email == 'alice@example.com' && auth.token.email_verified == true && auth.token.name == 'Alice' && auth.token.firebase.sign_in_provider == 'password' && auth.token.firebase.tenant == 'tenant-alpha'",
        },
      },
    });

    const allowed = evaluator.evaluate('read', '/profile', {
      auth: {
        uid: 'user-1',
        email: 'alice@example.com',
        emailVerified: true,
        displayName: 'Alice',
        providerId: 'password',
        tenant: 'tenant-alpha',
      },
      mockData: {},
    });
    expect(allowed.check).toBe('allow');

    const denied = evaluator.evaluate('read', '/profile', {
      auth: {
        uid: 'user-1',
        email: 'wrong@example.com',
        emailVerified: true,
        displayName: 'Alice',
        providerId: 'password',
        tenant: 'tenant-alpha',
      },
      mockData: {},
    });
    expect(denied.check).toBe('deny');
  });
});

describe('02-rtdb-deny-info-system-path-writes', () => {
  test('RulesEvaluator.evaluate denies write and validate operations on /.info and /.info/* even when rules are open', () => {
    const evaluator = new RulesEvaluator();

    // Open mode (no compiled rules loaded yet)
    expect(
      evaluator.evaluate('write', '/.info/connected', {
        auth: { uid: 'user-1' },
        mockData: {},
        newData: false,
      }).check,
    ).toBe('deny');
    expect(
      evaluator.evaluate('write', '/.info', {
        auth: { uid: 'user-1' },
        mockData: {},
        newData: {},
      }).check,
    ).toBe('deny');
    expect(
      evaluator.evaluate('validate', '/.info/serverTimeOffset', {
        auth: { uid: 'user-1' },
        mockData: {},
        newData: 123,
      }).check,
    ).toBe('deny');

    // Read on /.info/connected remains allowed in open mode
    expect(
      evaluator.evaluate('read', '/.info/connected', {
        auth: { uid: 'user-1' },
        mockData: {},
      }).check,
    ).toBe('allow');

    // Even when root .write and .validate are explicitly true
    evaluator.setRules({
      rules: {
        '.read': true,
        '.write': true,
        '.validate': true,
      },
    });
    expect(
      evaluator.evaluate('write', '/.info/connected', {
        auth: { uid: 'user-1' },
        mockData: {},
        newData: true,
      }).check,
    ).toBe('deny');
    expect(
      evaluator.evaluate('write', '.info/connected', {
        auth: { uid: 'user-1' },
        mockData: {},
        newData: true,
      }).check,
    ).toBe('deny');
    expect(
      evaluator.evaluate('read', '/.info/connected', {
        auth: { uid: 'user-1' },
        mockData: {},
      }).check,
    ).toBe('allow');
  });
});
