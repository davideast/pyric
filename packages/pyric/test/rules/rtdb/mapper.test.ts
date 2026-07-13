import { describe, test, expect } from 'bun:test';
import { RtdbMapper, buildRuleExpression } from '../../../src/rules/rtdb/mapper.js';

const DB_URL = 'https://test-default-rtdb.firebaseio.com';

describe('RtdbMapper.mapToIR', () => {
  test('maps simple rules to IR structure', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.read': 'auth !== null', '.write': 'false' } },
      null,
      DB_URL,
    );
    expect(ir.service).toBe('realtime-database');
    expect(ir.databaseUrl).toBe(DB_URL);
    expect(ir.rules.path).toBe('/');
    expect(ir.rules.read?.raw).toBe('auth !== null');
    expect(ir.rules.write?.raw).toBe('false');
  });

  test('maps nested children correctly', () => {
    const ir = RtdbMapper.mapToIR(
      {
        rules: {
          users: {
            $userId: {
              '.read': 'auth.uid === $userId',
              '.write': 'auth.uid === $userId',
            },
          },
        },
      },
      null,
      DB_URL,
    );

    const usersNode = ir.rules.children.find((c: any) => c.path === '/users');
    expect(usersNode).toBeDefined();

    const userIdNode = usersNode?.children.find((c: any) => c.path === '/users/$userId');
    expect(userIdNode).toBeDefined();
    expect(userIdNode?.pathVariables).toContain('$userId');
    expect(userIdNode?.read?.raw).toBe('auth.uid === $userId');
  });

  test('extracts pathVariables from $ segments', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { $postId: { '.read': 'true' } } },
      null,
      DB_URL,
    );
    const postNode = ir.rules.children[0];
    expect(postNode.pathVariables).toContain('$postId');
  });

  test('marks exists=true for top-level keys in shallowData', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { users: { '.read': 'true' } } },
      { users: true },
      DB_URL,
    );
    const usersNode = ir.rules.children.find((c: any) => c.path === '/users');
    expect(usersNode?.exists).toBe(true);
  });

  test('marks exists=false when shallowData is null', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { users: { '.read': 'true' } } },
      null,
      DB_URL,
    );
    const usersNode = ir.rules.children.find((c: any) => c.path === '/users');
    expect(usersNode?.exists).toBe(false);
  });

  test('stringifies boolean true rule values', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.read': true } },
      null,
      DB_URL,
    );
    expect(ir.rules.read?.raw).toBe('true');
    expect(ir.rules.read?.parsed.valid).toBe(true);
  });

  test('stringifies boolean false rule values', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.write': false } },
      null,
      DB_URL,
    );
    expect(ir.rules.write?.raw).toBe('false');
    expect(ir.rules.write?.parsed.valid).toBe(true);
  });

  test('invalid expression sets valid=false without throwing', () => {
    expect(() => {
      const ir = RtdbMapper.mapToIR(
        { rules: { '.read': 'auth ===' } },
        null,
        DB_URL,
      );
      expect(ir.rules.read?.parsed.valid).toBe(false);
    }).not.toThrow();
  });

  test('normalizes .indexOn to array', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.indexOn': 'name' } },
      null,
      DB_URL,
    );
    expect(ir.rules.indexOn).toEqual(['name']);
  });

  test('.indexOn array is preserved', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.indexOn': ['name', 'age'] } },
      null,
      DB_URL,
    );
    expect(ir.rules.indexOn).toEqual(['name', 'age']);
  });

  test('throws when rulesJson is null', () => {
    expect(() => RtdbMapper.mapToIR(null, null, DB_URL)).toThrow();
  });

  test('throws when rulesJson has no "rules" key', () => {
    expect(() => RtdbMapper.mapToIR({}, null, DB_URL)).toThrow();
  });

  test('maps .validate rule', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.validate': 'newData.isString()' } },
      null,
      DB_URL,
    );
    expect(ir.rules.validate?.raw).toBe('newData.isString()');
  });
});

describe('buildRuleExpression', () => {
  test('returns a valid RtdbRuleExpression for a valid read expression', () => {
    const result = buildRuleExpression('auth !== null', 'read');
    expect(result.raw).toBe('auth !== null');
    expect(result.parsed.valid).toBe(true);
    expect(result.parsed.errors).toHaveLength(0);
    expect(Array.isArray(result.parsed.referencedIdentifiers)).toBe(true);
    expect(result.parsed.referencedIdentifiers).toContain('auth');
  });

  test('includes warnings from linter', () => {
    const result = buildRuleExpression('true', 'read');
    expect(result.parsed.warnings.length).toBeGreaterThan(0);
    expect(result.parsed.warnings[0].code).toBe('HARDCODED_TRUE');
  });

  test('passes pathVariables through to validator without errors', () => {
    const result = buildRuleExpression('auth.uid === $userId', 'read', ['$userId']);
    expect(result.parsed.valid).toBe(true);
    // $userId should not trigger UNKNOWN_IDENTIFIER since it starts with $
    expect(result.parsed.errors.filter(e => e.message.includes('$userId'))).toHaveLength(0);
  });
});

describe('RtdbMapper.mapToRulesJSON', () => {
  test('converts root read rule to JSON', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.read': 'auth !== null' } },
      null,
      DB_URL,
    );
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json).toEqual({ rules: { '.read': 'auth !== null' } });
  });

  test('converts boolean false back to boolean in JSON', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.read': false, '.write': false } },
      null,
      DB_URL,
    );
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json.rules['.read']).toBe(false);
    expect(json.rules['.write']).toBe(false);
  });

  test('converts boolean true back to boolean in JSON', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.read': true } },
      null,
      DB_URL,
    );
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json.rules['.read']).toBe(true);
  });

  test('converts nested children to correct structure', () => {
    const input = {
      rules: {
        users: {
          $userId: {
            '.read': 'auth.uid === $userId',
            '.write': 'auth.uid === $userId',
          },
        },
      },
    };
    const ir = RtdbMapper.mapToIR(input, null, DB_URL);
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json.rules).toHaveProperty('users');
    expect((json.rules as any).users).toHaveProperty('$userId');
    expect((json.rules as any).users.$userId['.read']).toBe('auth.uid === $userId');
    expect((json.rules as any).users.$userId['.write']).toBe('auth.uid === $userId');
  });

  test('preserves .indexOn array', () => {
    const ir = RtdbMapper.mapToIR(
      { rules: { '.indexOn': ['name', 'age'] } },
      null,
      DB_URL,
    );
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json.rules['.indexOn']).toEqual(['name', 'age']);
  });

  test('round-trip produces equivalent rules JSON', () => {
    const original = {
      rules: {
        '.read': false,
        '.write': false,
        users: {
          $userId: {
            '.read': 'auth.uid === $userId',
            '.write': 'auth.uid === $userId',
            '.validate': 'newData.isString()',
          },
        },
        posts: {
          '.indexOn': ['createdAt', 'author'],
          $postId: {
            '.read': true,
          },
        },
      },
    };
    const ir = RtdbMapper.mapToIR(original, null, DB_URL);
    const json = RtdbMapper.mapToRulesJSON(ir);
    expect(json).toEqual(original);
  });
});
