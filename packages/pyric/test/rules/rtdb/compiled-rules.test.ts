import { describe, expect, test } from 'bun:test';
import {
  buildRuleExpression,
  compileRtdbRules,
  serializeRtdbRules,
} from '../../../src/rules/rtdb/compiled-rules.js';

describe('compileRtdbRules', () => {
  test('compiles simple rules without service or database metadata', () => {
    const compiled = compileRtdbRules({
      rules: { '.read': 'auth !== null', '.write': false },
    });

    expect(compiled.path).toBe('/');
    expect(compiled.read?.raw).toBe('auth !== null');
    expect(compiled.write?.raw).toBe('false');
    expect(compiled).not.toHaveProperty('service');
    expect(compiled).not.toHaveProperty('databaseUrl');
    expect(compiled).not.toHaveProperty('exists');
  });

  test('compiles nested children and path variables', () => {
    const compiled = compileRtdbRules({
      rules: {
        users: {
          $userId: {
            '.read': 'auth.uid === $userId',
            '.write': 'auth.uid === $userId',
          },
        },
      },
    });

    const users = compiled.children.find((node) => node.path === '/users');
    const user = users?.children.find((node) => node.path === '/users/$userId');
    expect(user?.pathVariables).toContain('$userId');
    expect(user?.read?.raw).toBe('auth.uid === $userId');
  });

  test('normalizes .indexOn to an array', () => {
    expect(compileRtdbRules({ rules: { '.indexOn': 'name' } }).indexOn).toEqual(['name']);
    expect(compileRtdbRules({ rules: { '.indexOn': ['name', 'age'] } }).indexOn).toEqual(['name', 'age']);
  });

  test('keeps invalid expressions as findings instead of throwing', () => {
    const compiled = compileRtdbRules({ rules: { '.read': 'auth ===' } });
    expect(compiled.read?.parsed.valid).toBe(false);
    expect(compiled.read?.parsed.errors.length).toBeGreaterThan(0);
  });

  test('rejects invalid document shapes', () => {
    expect(() => compileRtdbRules(null)).toThrow();
    expect(() => compileRtdbRules({})).toThrow();
    expect(() => compileRtdbRules({ rules: null })).toThrow();
  });
});

describe('buildRuleExpression', () => {
  test('parses, validates, and lints a rule expression', () => {
    const result = buildRuleExpression('auth !== null', 'read');
    expect(result.raw).toBe('auth !== null');
    expect(result.parsed.valid).toBe(true);
    expect(result.parsed.errors).toHaveLength(0);
    expect(Array.isArray(result.parsed.warnings)).toBe(true);
    expect(result.parsed.referencedIdentifiers).toContain('auth');
  });

  test('passes path variables to validation', () => {
    const result = buildRuleExpression('auth.uid === $userId', 'read', ['$userId']);
    expect(result.parsed.valid).toBe(true);
    expect(result.parsed.errors.filter((error) => error.message.includes('$userId'))).toHaveLength(0);
  });
});

describe('serializeRtdbRules', () => {
  test('round-trips Firebase rules JSON', () => {
    const original = {
      rules: {
        '.read': false,
        '.write': false,
        users: {
          $userId: {
            '.read': 'auth.uid === $userId',
            '.validate': 'newData.isString()',
          },
        },
        posts: {
          '.indexOn': ['createdAt', 'author'],
          $postId: { '.read': true },
        },
      },
    };

    expect(serializeRtdbRules(compileRtdbRules(original))).toEqual(original);
  });
});
