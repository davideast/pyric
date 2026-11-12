import { describe, expect, test } from 'bun:test';
import { firestoreRules, RulesCompileError } from '../../src/index.js';
import { SimulateFirestoreRulesHandler } from '../../src/internal/index.js';

describe('firestoreRules() 2+modules stdlib lowering and getAfter() batch projections', () => {
  const MODULAR_AUTH_RULES = [
    "rules_version = '2+modules';",
    "import { isAuthenticated } from 'auth';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    '      allow read, write: if isAuthenticated();',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const MODULAR_STDLIB_PATH_RULES = [
    "rules_version = '2+modules';",
    "import { isOwner } from './stdlib/auth.rules';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    '      allow read, write: if isOwner(id);',
    '    }',
    '  }',
    '}',
  ].join('\n');

  test('lowers bundled stdlib imports (bare key and ./stdlib/<key>.rules) in firestoreRules()', () => {
    const authRules = firestoreRules(MODULAR_AUTH_RULES);
    const summary = authRules.simulate([
      {
        description: 'signed-in user allowed',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: { uid: 'u1' },
      },
      {
        description: 'anonymous user denied',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        auth: null,
      },
    ]);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.unsupported).toBe(0);
    expect(
      authRules.lint().filter((issue) => issue.origin === 'parse' || issue.code === 'UNDEFINED_FUNCTION'),
    ).toEqual([]);

    const ownerRules = firestoreRules(MODULAR_STDLIB_PATH_RULES);
    const ownerSummary = ownerRules.simulate([
      {
        description: 'owner reads matching id',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/u1',
        auth: { uid: 'u1' },
      },
      {
        description: 'non-owner denied',
        expectation: 'DENY',
        method: 'get',
        path: 'items/u2',
        auth: { uid: 'u1' },
      },
    ]);
    expect(ownerSummary.passed).toBe(2);
  });

  test('throws RulesCompileError on unknown stdlib exports and unresolved local relative imports', () => {
    const badExport = MODULAR_AUTH_RULES.replace('isAuthenticated', 'nonExistentHelper');
    expect(() => firestoreRules(badExport)).toThrow(RulesCompileError);

    const unresolvedLocal = MODULAR_AUTH_RULES.replace("'auth'", "'./custom-local.rules'");
    expect(() => firestoreRules(unresolvedLocal)).toThrow(RulesCompileError);
  });

  test('resolves serverTimestamp sentinels in batchProjection getAfter() lookups', () => {
    const rules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/b {',
      '      allow create: if request.auth != null',
      '        && getAfter(/databases/$(database)/documents/items/a).data.updatedAt == request.time',
      '        && getAfter(/databases/$(database)/documents/items/a).data.nested.touchedAt == request.time',
      '        && getAfter(/databases/$(database)/documents/items/a).data.stamps[0] == request.time;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const batchProjection = new Map<string, Record<string, unknown> | null>([
      [
        'items/a',
        {
          updatedAt: { __type: 'serverTimestamp' },
          nested: { touchedAt: { _methodName: 'serverTimestamp' } },
          stamps: [{ _methodName: 'FieldValue.serverTimestamp' }],
        },
      ],
    ]);

    const handler = new SimulateFirestoreRulesHandler();
    const res = handler.simulate(
      rules,
      [
        {
          expectation: 'ALLOW',
          method: 'create',
          path: 'items/b',
          auth: { uid: 'u1' },
          data: { ok: true },
          requestTime: '2026-01-02T03:04:05.000Z',
        },
      ],
      { batchProjection },
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.passed).toBe(1);
      expect(res.data.failed).toBe(0);
    }
  });

  test('preserves pyric/map/1.0 and unescapedMap user literals alongside serverTimestamp sentinels in getAfter()', () => {
    const rules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/a {',
      '      allow create: if request.auth != null',
      '        && request.resource.data.ts == request.time',
      '        && request.resource.data.payload is map',
      "        && request.resource.data.payload['__type'] == 'serverTimestamp'",
      '        && request.resource.data.floatMap is map',
      "        && request.resource.data.floatMap['__type'] == 'float'",
      '        && request.resource.data.floatMap.value is float',
      '        && request.resource.data.floatMap.value == 1.5',
      '        && getAfter(/databases/$(database)/documents/items/a).data.payload is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.payload['__type'] == 'serverTimestamp';",
      '    }',
      '    match /items/b {',
      '      allow create: if request.auth != null',
      '        && getAfter(/databases/$(database)/documents/items/a).data.ts == request.time',
      '        && getAfter(/databases/$(database)/documents/items/a).data.payload is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.payload['__type'] == 'serverTimestamp'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.floatMap is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.floatMap['__type'] == 'float'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.floatMap.value is float',
      '        && getAfter(/databases/$(database)/documents/items/a).data.floatMap.value == 1.5',
      '        && getAfter(/databases/$(database)/documents/items/a).data.taggedTs is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.taggedTs['__type'] == 'serverTimestamp'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.taggedFloat is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.taggedFloat['__type'] == 'float'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.taggedFloat.value is float',
      '        && getAfter(/databases/$(database)/documents/items/a).data.taggedFloat.value == 2.5;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const unescapedTag = Symbol.for('pyric.unescapedMap');
    const taggedTs: Record<string, unknown> = { __type: 'serverTimestamp' };
    Object.defineProperty(taggedTs, unescapedTag, { value: true });
    const taggedFloat: Record<string, unknown> = { __type: 'float', value: 2.5 };
    Object.defineProperty(taggedFloat, unescapedTag, { value: true });

    const batchProjection = new Map<string, Record<string, unknown> | null>([
      [
        'items/a',
        {
          ts: { __type: 'serverTimestamp' },
          payload: { type: 'pyric/map/1.0', fields: { __type: 'serverTimestamp' } },
          floatMap: { type: 'pyric/map/1.0', fields: { __type: 'float', value: 1.5 } },
          taggedTs,
          taggedFloat,
        },
      ],
      ['items/b', { ok: true }],
    ]);

    const handler = new SimulateFirestoreRulesHandler();
    const res = handler.simulate(
      rules,
      [
        {
          expectation: 'ALLOW',
          method: 'create',
          path: 'items/a',
          auth: { uid: 'u1' },
          data: batchProjection.get('items/a') ?? undefined,
          requestTime: '2026-01-02T03:04:05.000Z',
        },
        {
          expectation: 'ALLOW',
          method: 'create',
          path: 'items/b',
          auth: { uid: 'u1' },
          data: { ok: true },
          requestTime: '2026-01-02T03:04:05.000Z',
        },
      ],
      { batchProjection },
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.passed).toBe(2);
      expect(res.data.failed).toBe(0);
    }
  });
});
