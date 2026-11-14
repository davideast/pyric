import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { captureCheckpoint } from 'pyric/sandbox/checkpoints';
import { getAdminDatabase, ref, set } from 'pyric/database';
import { IdBindings, matchRecorded, normalize, TIME } from '../../../src/serve/repro/compare.js';
import { REPRO_SCHEMA, type ReproEntry, type ReproFile } from '../../../src/serve/repro/format.js';
import { replayRepro } from '../../../src/serve/repro/replay.js';
import { stripStandardTokenClaims, stripWireTokenClaims } from '../../../src/serve/repro/token-claims.js';

describe('repro timestamp normalization', () => {
  test('normalizes genuine numeric timestamp envelopes to TIME', () => {
    expect(normalize({ seconds: 12, nanoseconds: 340 })).toBe(TIME);
    expect(normalize({ seconds: 12, nanos: 340 })).toBe(TIME);
    expect(normalize({ type: 'firestore/timestamp/1.0', seconds: 12, nanoseconds: 340 })).toBe(TIME);
    expect(normalize({ __type: 'timestamp', seconds: 12, nanos: 340 })).toBe(TIME);
  });

  test('does not normalize non-numeric seconds/nanoseconds or objects with extra underscore or type fields', () => {
    const nonNumeric = {
      seconds: 'not-a-timestamp',
      nanoseconds: 'not-a-number',
      _status: 'active',
      _owner: 'u-1',
    };
    expect(normalize(nonNumeric)).toEqual(nonNumeric);

    const numericWithExtraUnderscore = {
      seconds: 10,
      nanoseconds: 20,
      _status: 'revoked',
    };
    expect(normalize(numericWithExtraUnderscore)).toEqual(numericWithExtraUnderscore);

    const numericWithUserType = {
      seconds: 10,
      nanoseconds: 20,
      type: 'duration-window',
    };
    expect(normalize(numericWithUserType)).toEqual(numericWithUserType);

    const bindings = new IdBindings();
    const recorded = {
      seconds: 'recorded-text',
      nanoseconds: false,
      _status: 'active',
      _owner: 'u-1',
    };
    const replayed = {
      seconds: 'actual-text',
      nanoseconds: 'other',
      _status: 'revoked',
      _owner: 'u-2',
    };
    expect(matchRecorded(recorded, replayed, bindings).matches).toBe(false);
  });

  test('replayRepro detects divergence in RTDB objects holding seconds, nanoseconds, and underscore fields', async () => {
    const sb = initializeSandbox();
    const adminDb = getAdminDatabase(sb);
    await set(ref(adminDb, '/docs/doc-1'), {
      seconds: 'actual-text',
      nanoseconds: 'other-text',
      _status: 'revoked',
      _owner: 'u-2',
    });
    const checkpoint = await captureCheckpoint(sb);
    sb.dispose();

    const actualDoc: Record<string, unknown> = {
      seconds: 'actual-text',
      nanoseconds: 'other-text',
      _status: 'revoked',
      _owner: 'u-2',
    };
    const entries = Object.keys(actualDoc)
      .sort()
      .map((k) => ({ key: k, value: actualDoc[k], exportValue: actualDoc[k], priority: null }));
    const recordedValue = {
      exists: true,
      key: 'doc-1',
      priority: null,
      size: entries.length,
      entries,
      value: {
        seconds: 'recorded-text',
        nanoseconds: false,
        _status: 'active',
        _owner: 'u-1',
      },
      exportValue: {
        seconds: 'recorded-text',
        nanoseconds: false,
        _status: 'active',
        _owner: 'u-1',
      },
    };
    const reproEntries: ReproEntry[] = [
      {
        kind: 'in',
        at: 1001,
        session: 's-1',
        frame: { t: 'op', id: 'op-1', method: 'rtdb.get', instance: undefined, path: '/docs/doc-1' },
      },
      {
        kind: 'out',
        at: 1002,
        session: 's-1',
        frame: { t: 'res', id: 'op-1', ok: true, value: recordedValue },
      },
    ];
    const file: ReproFile = {
      schema: REPRO_SCHEMA,
      createdAt: '2026-01-01T00:00:00.000Z',
      recordedBy: '0.1.0',
      truncated: false,
      base: {
        at: 1000,
        checkpoint,
        databaseInstances: {},
        rules: {
          firestore: null,
          database: { default: { rules: { '.read': true, '.write': true } } },
          storage: null,
        },
        defaultInstance: 'default',
        permissive: true,
        appOptions: { projectId: 'proj-1', apiKey: 'demo-key' },
        messaging: false,
        sessions: {},
        subscriptions: {},
      },
      entries: reproEntries,
    };

    const report = await replayRepro(file, { planes: ['worker'] });
    expect(report.ok).toBe(false);
    expect(report.planes.worker?.divergences.length).toBeGreaterThan(0);
  });
});

describe('token claim projection prototype safety', () => {
  test('stripStandardTokenClaims preserves own __proto__ custom claims without mutating prototype', () => {
    const tokenOnlyProto = JSON.parse(
      '{"uid":"u-1","iat":100,"__proto__":{"role":"admin","toString":"invalid"}}',
    ) as Record<string, unknown>;
    const onlyProto = stripStandardTokenClaims(tokenOnlyProto);
    expect(onlyProto).toBeDefined();
    expect(Object.getPrototypeOf(onlyProto)).toBe(Object.prototype);
    expect(Object.hasOwn(onlyProto!, '__proto__')).toBe(true);
    expect(() => String(onlyProto)).not.toThrow();
    expect(JSON.parse(JSON.stringify(onlyProto))).toEqual(
      JSON.parse('{"__proto__":{"role":"admin","toString":"invalid"}}'),
    );

    const tokenMixed = JSON.parse(
      '{"uid":"u-1","email":"u@example.com","tier":"pro","__proto__":{"nested":{"__proto__":{"flag":true}}}}',
    ) as Record<string, unknown>;
    const mixed = stripStandardTokenClaims(tokenMixed);
    expect(mixed).toBeDefined();
    expect(Object.getPrototypeOf(mixed)).toBe(Object.prototype);
    expect(Object.keys(mixed!).sort()).toEqual(['__proto__', 'tier']);
    const nested = (mixed!['__proto__'] as Record<string, unknown>).nested as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
  });

  test('stripWireTokenClaims preserves own __proto__ custom claims without mutating prototype', () => {
    const rawToken = JSON.parse(
      '{"uid":"u-1","name":"User One","email":"u@example.com","firebase":{"tenant":"t-1","sign_in_provider":"password","identities":{"email":["u@example.com"]}},"__proto__":{"scope":"write","valueOf":"invalid"}}',
    ) as Record<string, unknown>;
    const wire = stripWireTokenClaims(rawToken);
    expect(wire).toBeDefined();
    expect(Object.getPrototypeOf(wire)).toBe(Object.prototype);
    expect(Object.hasOwn(wire!, '__proto__')).toBe(true);
    expect(() => Number(wire)).not.toThrow();
    expect(Object.keys(wire!).sort()).toEqual(['__proto__', 'email', 'firebase']);
    expect(JSON.stringify(wire)).toContain('"__proto__":{"scope":"write","valueOf":"invalid"}');

    const rawOnlyProto = JSON.parse(
      '{"uid":"u-1","iat":100,"__proto__":{"scope":"read"}}',
    ) as Record<string, unknown>;
    const wireOnlyProto = stripWireTokenClaims(rawOnlyProto);
    expect(wireOnlyProto).toBeDefined();
    expect(Object.getPrototypeOf(wireOnlyProto)).toBe(Object.prototype);
    expect(Object.hasOwn(wireOnlyProto!, '__proto__')).toBe(true);
  });
});
