import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allow,
  buildRuleExpression,
  createRtdbRulesTools,
  defineRtdbRules,
  parseExpression,
  RtdbMapper,
} from '../../src/rules/rtdb.js';
import type { RtdbHost } from '../../src/rules/rtdb.js';

function host(): RtdbHost {
  return {
    projectId: 'demo',
    databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
    resolveAdminToken: async () => 'token',
    resolveUserToken: async () => 'user-token',
    getClientForUser: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('pyric/rules/rtdb facade', () => {
  test('exports the RTDB rules helpers and factory', () => {
    expect(parseExpression('auth !== null').valid).toBe(true);
    expect(buildRuleExpression('auth.uid === $uid', 'read', ['$uid']).parsed.valid).toBe(true);
    expect(createRtdbRulesTools({ host: host() }).map((t) => t.name).sort()).toEqual([
      'rtdb_build_expression',
      'rtdb_deploy_rules',
      'rtdb_get_rules',
      'rtdb_simulate_access',
    ]);
  });

  test('maps Firebase RTDB rules JSON to IR through the facade', () => {
    const ir = RtdbMapper.mapToIR({ rules: { users: { '$uid': { '.read': 'auth.uid === $uid' } } } }, null, host().databaseUrl);
    expect(ir.service).toBe('realtime-database');
    expect(ir.databaseUrl).toBe(host().databaseUrl);
  });

  test('exports the constraints document API through the facade', () => {
    const rules = defineRtdbRules({
      paths: { '/': { read: allow() } },
    });

    expect(rules.toJSON()).toEqual({ rules: { '.read': true } });
  });

  test('declares canonical and compatibility constraints package paths', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf-8'),
    ) as { exports: Record<string, unknown> };

    expect(pkg.exports['./rules/rtdb/constraints']).toEqual({
      types: './dist/database/constraints/index.d.ts',
      import: './dist/database/constraints/index.js',
    });
    expect(pkg.exports['./rules/rtdb-constraints']).toEqual({
      types: './dist/database/constraints/index.d.ts',
      import: './dist/database/constraints/index.js',
    });
  });
});
