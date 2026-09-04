import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allow,
  buildRuleExpression,
  compileRtdbRules,
  defineRtdbRules,
  parseExpression,
  serializeRtdbRules,
  simulateRtdbRules,
} from '../../src/rules/internal/rtdb.js';

describe('pyric/rules/rtdb facade', () => {
  test('exports the pure RTDB rules engine', () => {
    expect(parseExpression('auth != null').valid).toBe(true);
    expect(buildRuleExpression('auth.uid == $uid', 'read', ['$uid']).parsed.valid).toBe(true);
  });

  test('compiles, serializes, and simulates a rules tree without environment metadata', () => {
    const source = {
      rules: {
        users: {
          '$uid': {
            '.read': 'auth.uid == $uid',
          },
        },
      },
    };

    const compiled = compileRtdbRules(source);

    expect(compiled.path).toBe('/');
    expect(serializeRtdbRules(compiled)).toEqual(source);

    const result = simulateRtdbRules(compiled, {
      operation: 'read',
      path: '/users/alice',
      auth: { uid: 'alice', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.matchedPath).toBe('/users/$uid');
    }
  });

  test('exports the constraints document API through the facade', () => {
    const rules = defineRtdbRules({
      paths: { '/': { read: allow() } },
    });

    expect(rules.toJSON()).toEqual({ rules: { '.read': true } });
  });

  test('exposes the RTDB engine on the internal node seam, not a public subpath', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf-8'),
    ) as { exports: Record<string, unknown> };

    // The engine lives on the internal seam; the constraints DSL is
    // re-exported from the public ./rules front door.
    expect(pkg.exports['./rules/rtdb']).toBeUndefined();
    expect(pkg.exports['./rules/rtdb/constraints']).toBeUndefined();
    expect(pkg.exports['./rules/rtdb-constraints']).toBeUndefined();
    expect(pkg.exports['./rules/internal/rtdb']).toEqual({
      types: './dist/rules/internal/rtdb.d.ts',
      import: './dist/rules/internal/rtdb.js',
    });
  });
});
