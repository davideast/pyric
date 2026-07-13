import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allow,
  buildRuleExpression,
  defineRtdbRules,
  parseExpression,
  RtdbMapper,
  SimulateHandler,
} from '../../src/rules/internal/rtdb.js';
import * as rtdb from '../../src/rules/internal/rtdb.js';

describe('pyric/rules/rtdb facade', () => {
  test('exports only the pure RTDB rules engine', () => {
    expect(parseExpression('auth !== null').valid).toBe(true);
    expect(buildRuleExpression('auth.uid === $uid', 'read', ['$uid']).parsed.valid).toBe(true);
    expect(SimulateHandler).toBeDefined();

    const productionOrStatefulExports = [
      'fetchDatabase',
      'createRtdbAdminTools',
      'createRtdbDataTools',
      'createRtdbRulesTools',
      'getRtdbTools',
      'initializeDatabaseApp',
      'GenerateIRHandler',
      'WriteRulesHandler',
    ];
    expect(productionOrStatefulExports.filter((name) => name in rtdb)).toEqual([]);
  });

  test('maps Firebase RTDB rules JSON to IR through the facade', () => {
    const databaseUrl = 'https://demo-default-rtdb.firebaseio.com';
    const ir = RtdbMapper.mapToIR({ rules: { users: { '$uid': { '.read': 'auth.uid === $uid' } } } }, null, databaseUrl);
    expect(ir.service).toBe('realtime-database');
    expect(ir.databaseUrl).toBe(databaseUrl);
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

    // The clean break removed the ./rules/rtdb, ./rules/rtdb/constraints, and
    // ./rules/rtdb-constraints public subpaths. The engine now lives on the
    // internal seam; the constraints DSL is re-exported from the public
    // ./rules front door.
    expect(pkg.exports['./rules/rtdb']).toBeUndefined();
    expect(pkg.exports['./rules/rtdb/constraints']).toBeUndefined();
    expect(pkg.exports['./rules/rtdb-constraints']).toBeUndefined();
    expect(pkg.exports['./rules/internal/rtdb']).toEqual({
      types: './dist/rules/internal/rtdb.d.ts',
      import: './dist/rules/internal/rtdb.js',
    });
  });
});
