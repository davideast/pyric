import { describe, expect, test } from 'bun:test';
import {
  buildRuleExpression,
  createRtdbRulesTools,
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
});
