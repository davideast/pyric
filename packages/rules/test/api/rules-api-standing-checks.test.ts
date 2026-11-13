/**
 * Standing mechanical checks across the `@pyric/rules` public front door
 * (`firestoreRules`, `storageRules`, `rtdbRules`, `lint`, `explainCase`, and
 * value helpers).
 *
 * Exercises cross-service parity invariants systematically so fixes to one
 * parser, normalizer, validator, or serializer cannot drift on sibling planes.
 */
import { describe, expect, test } from 'bun:test';
import {
  allow,
  assertCase,
  bytes,
  defineRtdbRules,
  deny,
  duration,
  explainCase,
  expr,
  firestoreRules,
  latlng,
  lint,
  reference,
  rtdbRules,
  RulesCompileError,
  RulesUnsupportedError,
  serverTimestamp,
  storageRules,
  timestamp,
  vector,
  type FirestoreCase,
  type RtdbCase,
  type StorageCase,
} from '@pyric/rules';

const BUCKET = 'example-bucket';

describe('standing check: strict Gregorian calendar and timestamp range parity', () => {
  const INVALID_ISO_CORPUS: readonly string[] = [
    // February rollovers (leap and non-leap years, including century rules)
    '2025-02-29T00:00:00Z',
    '2026-02-29T12:30:00Z',
    '1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-02-31T00:00:00Z',
    // 30-day months with day 31
    '2026-04-31T00:00:00Z',
    '2026-06-31T00:00:00Z',
    '2026-09-31T00:00:00Z',
    '2026-11-31T00:00:00Z',
    // Out-of-bounds month / day / time / offset components
    '2026-00-15T00:00:00Z',
    '2026-13-15T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-32T00:00:00Z',
    '2026-01-15T24:00:00Z',
    '2026-01-15T23:60:00Z',
    '2026-01-15T23:59:60Z',
    '2026-01-15T12:00:00+24:00',
    '2026-01-15T12:00:00+00:60',
    // Missing timezone offset, omitted seconds, or >9 fractional digits (beyond nanosecond precision)
    '2026-01-15T12:00:00',
    '2026-01-01T00:00Z',
    '2026-01-01T00:00+02:00',
    '2026-01-01T00:00:00.1234567890Z',
    '2026-01-01T00:00:00.0000000001+00:00',
    // Year 0000 and UTC offset underflow / overflow past [0001..9999]
    '0000-01-01T00:00:00Z',
    '0000-12-31T23:59:59Z',
    '0001-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59-00:01',
  ];

  const VALID_ISO_CORPUS: ReadonlyArray<readonly [string, number]> = [
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29, 0, 0, 0) / 1000],
    ['2000-02-29T00:00:00Z', Date.UTC(2000, 1, 29, 0, 0, 0) / 1000],
    ['2400-02-29T00:00:00Z', Date.UTC(2400, 1, 29, 0, 0, 0) / 1000],
    ['0001-01-01T00:00:00Z', -62_135_596_800],
    ['9999-12-31T23:59:59Z', 253_402_300_799],
    ['2026-03-31T23:59:59+05:30', (Date.UTC(2026, 2, 31, 23, 59, 59) - (5 * 60 + 30) * 60_000) / 1000],
  ];

  const fsRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.time != null;
    }
  }
}`);

  const stRules = storageRules(
    `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if request.time != null;
      allow delete: if resource.timeCreated != null && resource.updated != null;
    }
  }
}`,
    { bucket: BUCKET },
  );

  test('rejects every invalid calendar or out-of-range ISO string across timestamp(), Firestore, and Storage', () => {
    for (const invalid of INVALID_ISO_CORPUS) {
      expect(() => timestamp(invalid)).toThrow(TypeError);

      const fsRes = fsRules.simulate([
        { description: invalid, expectation: 'DENY', method: 'get', path: 'items/i1', requestTime: invalid },
      ]).cases[0]!;
      expect(fsRes.decision).toBe('UNSUPPORTED');
      expect(fsRes.unsupported).toBe(true);

      const stReqTime = stRules.simulate([
        { description: invalid, expectation: 'DENY', method: 'get', path: 'items/i1', requestTime: invalid },
      ]).cases[0]!;
      expect(stReqTime.decision).toBe('UNSUPPORTED');
      expect(stReqTime.unsupported).toBe(true);

      const stTimeCreated = stRules.simulate([
        {
          description: `timeCreated ${invalid}`,
          expectation: 'DENY',
          method: 'delete',
          path: 'items/i1',
          resource: { size: 1, timeCreated: invalid, updated: '2026-01-01T00:00:00Z' },
        },
      ]).cases[0]!;
      expect(stTimeCreated.decision).toBe('UNSUPPORTED');

      const stUpdated = stRules.simulate([
        {
          description: `updated ${invalid}`,
          expectation: 'DENY',
          method: 'delete',
          path: 'items/i1',
          resource: { size: 1, timeCreated: '2026-01-01T00:00:00Z', updated: invalid },
        },
      ]).cases[0]!;
      expect(stUpdated.decision).toBe('UNSUPPORTED');
    }
  });

  test('accepts every valid leap-year and range-boundary ISO string across timestamp(), Firestore, and Storage', () => {
    for (const [iso, expectedSeconds] of VALID_ISO_CORPUS) {
      expect(timestamp(iso).seconds).toBe(expectedSeconds);

      const fsRes = fsRules.simulate([
        { description: iso, expectation: 'ALLOW', method: 'get', path: 'items/i1', requestTime: iso },
      ]).cases[0]!;
      expect(fsRes.decision).toBe('ALLOW');

      const stRes = stRules.simulate([
        { description: iso, expectation: 'ALLOW', method: 'get', path: 'items/i1', requestTime: iso },
        {
          description: `resource ${iso}`,
          expectation: 'ALLOW',
          method: 'delete',
          path: 'items/i1',
          resource: { size: 1, timeCreated: iso, updated: iso },
        },
      ]);
      expect(stRes.passed).toBe(2);
    }
  });
});

describe('standing check: auth.token wrapper prototype preservation and caller isolation', () => {
  test('preserves all Rules wrapper prototypes and isolates caller mutations with and without tenant', () => {
    const rawBuf = new Uint8Array([0x41, 0x42, 0x43]);
    const claims: Record<string, unknown> = {
      ts: timestamp('2028-05-01T00:00:00Z'),
      dur: duration(120, 's'),
      geo: latlng(40.5, -74.25),
      ref: reference('orgs/o1'),
      bin: bytes(rawBuf),
      vec: vector([0.25, 0.75]),
      whole: 42,
      frac: 3.25,
      bag: {
        list: [timestamp('2029-01-01T00:00:00Z'), duration(5, 'm'), bytes('ok')],
      },
    };

    const exprChecks = [
      'request.auth.token.ts is timestamp',
      'request.auth.token.ts.year() == 2028',
      'request.auth.token.dur is duration',
      'request.auth.token.dur.seconds() == 120',
      'request.auth.token.geo is latlng',
      'request.auth.token.geo.latitude() == 40.5',
      'request.auth.token.ref is path',
      'request.auth.token.ref == /databases/(default)/documents/orgs/o1',
      'request.auth.token.bin is bytes',
      'request.auth.token.bin.size() == 3',
      "request.auth.token.bin == b'ABC'",
      'request.auth.token.whole is int',
      'request.auth.token.whole == 42',
      'request.auth.token.frac is float',
      'request.auth.token.frac == 3.25',
      'request.auth.token.bag.list[0] is timestamp',
      'request.auth.token.bag.list[1] is duration',
      'request.auth.token.bag.list[2] is bytes',
    ].join(' && ');

    const fsRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow get: if ${exprChecks};
    }
  }
}`);

    const stRules = storageRules(
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow get: if ${exprChecks};
    }
  }
}`,
      { bucket: BUCKET },
    );

    for (const auth of [
      { uid: 'u1', token: claims },
      { uid: 'u1', tenant: 'org-a', token: claims },
    ]) {
      expect(
        fsRules.simulate([
          { description: 'fs wrapper claims', expectation: 'ALLOW', method: 'get', path: 'docs/d1', auth },
        ]).passed,
      ).toBe(1);
      expect(
        stRules.simulate([
          { description: 'st wrapper claims', expectation: 'ALLOW', method: 'get', path: 'docs/d1', auth },
        ]).passed,
      ).toBe(1);
    }

    // Mutating rawBuf after bytes(rawBuf) and mutating claims / normalizeAuthState output does not corrupt caller or subsequent runs.
    rawBuf[0] = 0xff;
    expect('firebase' in claims).toBe(false);
    expect((claims.bag as { list: unknown[] }).list).toHaveLength(3);
    expect(
      stRules.simulate([
        { description: 'post-rawBuf-mutation st wrapper claims', expectation: 'ALLOW', method: 'get', path: 'docs/d1', auth: { uid: 'u1', token: claims } },
      ]).passed,
    ).toBe(1);

    // Mutate claims in place and verify normalized tenant projection never wrote back to caller claims.
    (claims.bag as { list: unknown[] }).list.push('mutated');
    expect((claims.bag as { list: unknown[] }).list).toHaveLength(4);
  });
});

describe('standing check: StorageCase shape and firestore lookup parity with FirestoreCase', () => {
  const stRules = storageRules(
    `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if firestore.exists(/databases/(default)/documents/orgs/o1)
        && firestore.get(/databases/(default)/documents/orgs/o1).data.tier == 'pro';
      allow create: if request.resource.size < 4096;
      allow update: if resource.size < 4096 && request.resource.size < 4096;
    }
  }
}`,
    { bucket: BUCKET },
  );

  test('normalizes equivalent default-database Firestore document keys consistently', () => {
    const keyVariants = [
      'orgs/o1',
      '/orgs/o1',
      '/databases/(default)/documents/orgs/o1',
      'projects/demo-proj/databases/(default)/documents/orgs/o1',
    ];
    const summary = stRules.simulate(
      keyVariants.map((key): StorageCase => ({
        description: `key ${key}`,
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        firestore: { [key]: { tier: 'pro' } },
      })),
    );
    expect(summary.passed).toBe(keyVariants.length);
  });

  test('refuses malformed StorageCase fields, cross-service keys, null/sentinel firestore docs, and non-int sizes', () => {
    const badCases: StorageCase[] = [
      // Unknown / cross-service keys
      { description: 'fs data key', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 1 }, ...({ data: { a: 1 } } as object) },
      { description: 'fs functionMocks key', expectation: 'ALLOW', method: 'get', path: 'items/i1', ...({ functionMocks: [] } as object) },
      { description: 'rtdb operation key', expectation: 'ALLOW', method: 'get', path: 'items/i1', ...({ operation: 'read' } as object) },
      // Invalid expectation / description
      { description: 'lowercase allow', expectation: 'allow' as 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 1 } },
      { description: 123 as unknown as string, expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 1 } },
      // Invalid requestResource / resource scalars and unknown nested keys
      { description: 'float requestResource.size', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 10.5 } },
      { description: '-0 requestResource.size', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: -0 } },
      { description: 'NaN requestResource.size', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: Number.NaN } },
      { description: 'unknown requestResource key', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 1, ...({ extra: true } as object) } },
      { description: 'non-string metadata value', expectation: 'ALLOW', method: 'create', path: 'items/i1', requestResource: { size: 1, metadata: { k: 42 as unknown as string } } },
      { description: 'float resource.size', expectation: 'ALLOW', method: 'update', path: 'items/i1', resource: { size: 2.5 }, requestResource: { size: 2 } },
      { description: 'float resource.generation', expectation: 'ALLOW', method: 'update', path: 'items/i1', resource: { size: 2, generation: 1.2 }, requestResource: { size: 2 } },
      // Invalid firestore lookup shapes
      { description: 'null doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': null as unknown as Record<string, unknown> } },
      { description: 'array doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': [] as unknown as Record<string, unknown> } },
      { description: 'serverTimestamp in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', at: serverTimestamp() } } },
      { description: 'deleteField __type sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', gone: { __type: 'deleteField' } } } },
      { description: 'arrayUnion __type sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', tags: { __type: 'arrayUnion', values: ['x'] } } } },
      { description: 'arrayRemove __type sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', tags: { __type: 'arrayRemove', values: ['x'] } } } },
      { description: 'increment __type sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', count: { __type: 'increment', value: 1 } } } },
      { description: 'SDK _methodName deleteField sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', gone: { _methodName: 'FieldValue.delete' } } } },
      { description: 'SDK _methodName arrayUnion sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', tags: { _methodName: 'FieldValue.arrayUnion', _elements: ['x'] } } } },
      { description: 'SDK _methodName increment sentinel in doc', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro', count: { _methodName: 'FieldValue.increment', _operand: 1 } } } },
      { description: 'trailing slash doc path', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1/': { tier: 'pro' } } },
      { description: 'collection path in firestore', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { orgs: { tier: 'pro' } } },
      { description: 'named database in firestore', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { '/databases/analytics/documents/orgs/o1': { tier: 'pro' } } },
      { description: 'duplicate normalized doc paths', expectation: 'DENY', method: 'get', path: 'items/i1', firestore: { 'orgs/o1': { tier: 'pro' }, '/databases/(default)/documents/orgs/o1': { tier: 'free' } } },
    ];

    const summary = stRules.simulate(badCases);
    expect(summary.unsupported).toBe(badCases.length);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test('refuses unresolved write sentinels in stored FirestoreCase.resource and functionMocks while preserving plain __type user maps', () => {
    const fsRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if resource.data.tier == 'pro';
      allow create: if request.resource.data.v is map && request.resource.data.v.__type == 'timestamp';
      allow update: if get(/databases/(default)/documents/orgs/o1).data.tier == 'pro';
    }
  }
}`);

    const sentinelRegistryKey = Symbol.for('pyric.firestore.field-value-sentinels');
    const g = globalThis as { [sentinelRegistryKey]?: WeakSet<object> };
    const registry = g[sentinelRegistryKey] ?? (g[sentinelRegistryKey] = new WeakSet<object>());
    const registeredSentinel = registry.add({ customSentinel: true });

    const refusedStoredCases: FirestoreCase[] = [
      { description: 'serverTimestamp in resource', expectation: 'ALLOW', method: 'get', path: 'items/i1', resource: { tier: 'pro', ts: serverTimestamp() } },
      { description: 'deleteField in resource', expectation: 'ALLOW', method: 'get', path: 'items/i1', resource: { tier: 'pro', f: { __type: 'deleteField' } } },
      { description: 'arrayUnion in resource', expectation: 'ALLOW', method: 'get', path: 'items/i1', resource: { tier: 'pro', tags: { __type: 'arrayUnion', values: ['a'] } } },
      { description: 'increment in resource', expectation: 'ALLOW', method: 'get', path: 'items/i1', resource: { tier: 'pro', count: { _methodName: 'FieldValue.increment', _operand: 1 } } },
      { description: 'registered sentinel in resource', expectation: 'ALLOW', method: 'get', path: 'items/i1', resource: { tier: 'pro', s: registeredSentinel } },
      {
        description: 'deleteField in functionMocks result',
        expectation: 'ALLOW',
        method: 'update',
        path: 'items/i1',
        resource: { tier: 'pro' },
        data: { tier: 'pro' },
        functionMocks: [{ function: 'get', args: ['/databases/(default)/documents/orgs/o1'], result: { data: { tier: 'pro', f: { __type: 'deleteField' } } } }],
      },
    ];
    const refusedSummary = fsRules.simulate(refusedStoredCases);
    expect(refusedSummary.unsupported).toBe(refusedStoredCases.length);

    // Plain user map with `{ __type: 'timestamp', ... }` in FirestoreCase continues to read as a map.
    const plainMapSummary = fsRules.simulate([
      {
        description: 'plain __type timestamp map stays a map',
        expectation: 'ALLOW',
        method: 'create',
        path: 'items/i1',
        data: { v: { __type: 'timestamp', seconds: 1767225600, nanos: 0 } },
      },
    ]);
    expect(plainMapSummary.passed).toBe(1);
  });
});

describe('standing check: compile blockers, multi-service AST passes, and 2+modules source-map parity', () => {
  test('surfaces origin: parse compile blockers consistently across single-service and multi-service Firestore and Storage sources', () => {
    const storageBlockers: ReadonlyArray<{ label: string; source: string; expectedCode: string; expectedLine: number }> = [
      {
        label: 'lookahead regex in Storage',
        expectedCode: 'INVALID_REGEX_PATTERN',
        expectedLine: 5,
        source: [
          "rules_version = '2';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} {',
          "      allow get: if id.matches('(?=x)x');",
          '    }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        label: 'import statement under rules_version = 2 in Storage',
        expectedCode: 'UNRESOLVED_MODULES',
        expectedLine: 2,
        source: [
          "rules_version = '2';",
          "import { isAuthenticated } from 'auth';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} { allow get: if isAuthenticated(); }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        label: 'Firestore-only stdlib helper imported into Storage',
        expectedCode: 'INCOMPATIBLE_FUNCTION',
        expectedLine: 2,
        source: [
          "rules_version = '2+modules';",
          "import { validString } from 'validation';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          "    match /items/{id} { allow create: if validString('name', 1, 10); }",
          '  }',
          '}',
        ].join('\n'),
      },
      {
        label: 'unknown module in Storage 2+modules',
        expectedCode: 'UNKNOWN_MODULE',
        expectedLine: 2,
        source: [
          "rules_version = '2+modules';",
          "import { check } from 'nonexistent-stdlib-pkg';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} { allow get: if check(); }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        label: 'unknown export in Storage 2+modules',
        expectedCode: 'UNKNOWN_FUNCTION',
        expectedLine: 2,
        source: [
          "rules_version = '2+modules';",
          "import { missingExport } from 'auth';",
          'service firebase.storage {',
          '  match /b/{bucket}/o {',
          '    match /items/{id} { allow get: if missingExport(); }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        label: 'service-scope duplicate with imported function in Storage 2+modules',
        expectedCode: 'DUPLICATE_FUNCTION',
        expectedLine: 2,
        source: [
          "rules_version = '2+modules';",
          "import { isAuthenticated } from 'auth';",
          'service firebase.storage {',
          '  function isAuthenticated() { return true; }',
          '  match /b/{bucket}/o {',
          '    match /items/{id} { allow get: if isAuthenticated(); }',
          '  }',
          '}',
        ].join('\n'),
      },
    ];

    for (const { source, expectedCode, expectedLine } of storageBlockers) {
      const parseIssues = lint(source).filter((i) => i.origin === 'parse');
      expect(parseIssues).toContainEqual(
        expect.objectContaining({
          code: expectedCode,
          severity: 'error',
          origin: 'parse',
          line: expectedLine,
        }),
      );

      let thrown: unknown;
      try {
        storageRules(source, { bucket: BUCKET });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(RulesCompileError);
      expect((thrown as RulesCompileError).issues).toContainEqual(
        expect.objectContaining({
          code: expectedCode,
          severity: 'error',
          origin: 'parse',
          line: expectedLine,
        }),
      );
    }

    // Multi-service in BOTH declaration orders (Firestore first vs Storage first)
    const fsClosedBlock = [
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{document=**} { allow read, write: if false; }',
      '  }',
      '}',
    ].join('\n');
    const stInvalidRegexBlock = [
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow get: if id.matches('(?=a)a');",
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fsInvalidRegexBlock = [
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /docs/{docId} {',
      "      allow get: if docId.matches('(?=b)b');",
      '    }',
      '  }',
      '}',
    ].join('\n');
    const stClosedBlock = [
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{allPaths=**} { allow read, write: if false; }',
      '  }',
      '}',
    ].join('\n');

    const fsThenSt = `rules_version = '2';\n${fsClosedBlock}\n${stInvalidRegexBlock}`;
    const stThenFs = `rules_version = '2';\n${stClosedBlock}\n${fsInvalidRegexBlock}`;

    expect(lint(fsThenSt).filter((i) => i.origin === 'parse')).toEqual([
      expect.objectContaining({ code: 'INVALID_REGEX_PATTERN', line: 10 }),
    ]);
    expect(lint(stThenFs).filter((i) => i.origin === 'parse')).toEqual([
      expect.objectContaining({ code: 'INVALID_REGEX_PATTERN', line: 10 }),
    ]);
  });

  test('supports nested match shadowing with distinct arity and preserves authored line numbers in 2+modules', () => {
    // Nested match shadows `validString` (imported from 'validation') with a 2-arg int helper!
    const source = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      "import { validString } from 'validation';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      function validString(a, b) { return a + b == 5; }',
      '      allow get: if validString(2, 3);', // line 8
      '    }',
      '    match /users/{uid} {',
      "      allow create: if isAuthenticated() && validString('email', 3, 80);", // line 11
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(lint(source).filter((i) => i.origin === 'parse')).toEqual([]);
    const rs = firestoreRules(source);
    const sim = rs.simulate([
      { description: 'shadowed 2-arg helper', expectation: 'ALLOW', method: 'get', path: 'items/i1' },
      {
        description: 'imported validString on sibling match',
        expectation: 'ALLOW',
        method: 'create',
        path: 'users/u1',
        auth: { uid: 'u1' },
        data: { email: 'u1@example.com' },
      },
    ]);
    expect(sim.passed).toBe(2);
    expect(
      rs.explain({ description: 'shadowed 2-arg helper', expectation: 'ALLOW', method: 'get', path: 'items/i1' })
        .deciding?.line,
    ).toBe(8);

    const stModular = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/items/{id} {',
      '      allow get: if isAuthenticated();', // line 6
      '    }',
      '  }',
      '}',
    ].join('\n');
    const stRs = storageRules(stModular, { bucket: BUCKET });
    const [denied] = stRs.simulate([
      { description: 'anon denied at authored line 6', expectation: 'ALLOW', method: 'get', path: 'orgs/o1/items/i1', auth: null },
    ]).cases;
    expect(denied.decidingRule?.line).toBe(6);
    expect(explainCase(denied)).toContain('(line 6)');

    // firestoreRules(modular).lint() and runtime resourceLimit.line report authored lines, matching Storage.
    const chainDefs = Array.from({ length: 18 }, (_, idx) => {
      const n = idx + 1;
      const body = n === 18 ? 'isAuthenticated()' : `h${n + 1}()`;
      return `  function h${n}() { return ${body}; }`; // h1 is on authored line 4
    });
    const fsModularCallDepth = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service cloud.firestore {',
      ...chainDefs,
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow get: if h1();',
      "      allow write: if id.includes('a');", // authored line 25 (HALLUCINATED_METHOD)
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fsHandleIssues = firestoreRules(fsModularCallDepth).lint();
    const freeIssues = lint(fsModularCallDepth);
    expect(fsHandleIssues.find((i) => i.code === 'CALL_DEPTH')?.line).toBe(4);
    expect(freeIssues.find((i) => i.code === 'CALL_DEPTH')?.line).toBe(4);
    expect(fsHandleIssues).toEqual(freeIssues);

    // 1000-expression runtime resource limit inside helper on authored line 4 (both Firestore and Storage)
    const burnBody = 'x + x + x + x + x + x + x + x + x + x';
    const b1Body = 'step1(x) + step1(x) + step1(x) + step1(x) + step1(x) + step1(x) + step1(x) + step1(x)';
    const b2Body = 'b1(x) + b1(x) + b1(x) + b1(x) + b1(x) + b1(x) + b1(x) + b1(x)';
    const fsModularBurn = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service cloud.firestore {',
      `  function step1(x) { return ${burnBody}; }`, // authored line 4
      `  function b1(x) { return ${b1Body}; }`,
      `  function b2(x) { return ${b2Body}; }`,
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if isAuthenticated() && b2(1) > 0; }',
      '  }',
      '}',
    ].join('\n');
    const [fsBurnCase] = firestoreRules(fsModularBurn).simulate([
      { description: 'hits expression limit', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
    ]).cases;
    expect(fsBurnCase.resourceLimit?.line).toBe(4);
    expect(fsBurnCase.notes[0]).toContain('line 4');

    const stModularBurn = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service firebase.storage {',
      `  function step1(x) { return ${burnBody}; }`, // authored line 4
      `  function b1(x) { return ${b1Body}; }`,
      `  function b2(x) { return ${b2Body}; }`,
      '  match /b/{bucket}/o {',
      '    match /items/{id} { allow get: if isAuthenticated() && b2(1) > 0; }',
      '  }',
      '}',
    ].join('\n');
    const [stBurnCase] = storageRules(stModularBurn, { bucket: BUCKET }).simulate([
      { description: 'hits expression limit', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
    ]).cases;
    expect(stBurnCase.resourceLimit?.line).toBe(4);

    // Storage 2+modules compile-limit error text and .issues[0].line both cite authored line
    const stModularGlob = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{a=**}/items/{b=**} {', // authored line 5
      '      allow get: if isAuthenticated();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    let stGlobErr: unknown;
    try {
      storageRules(stModularGlob, { bucket: BUCKET });
    } catch (e) {
      stGlobErr = e;
    }
    expect(stGlobErr).toBeInstanceOf(RulesCompileError);
    expect((stGlobErr as RulesCompileError).issues[0]?.line).toBe(5);
    expect((stGlobErr as RulesCompileError).message).toContain('Line 5:');
  });
});

describe('standing check: rtdbRules() deep-clone immutability and __proto__ preservation', () => {
  test('isolates nested objects, arrays, and own __proto__ keys on input and toJSON() across all rtdbRules forms', () => {
    const rawRules: Record<string, unknown> = {
      users: {
        '.indexOn': ['handle'],
        $uid: {
          '.read': 'auth != null && auth.uid == $uid',
          '.write': 'auth != null && auth.uid == $uid',
        },
      },
    };
    Object.defineProperty(rawRules, '__proto__', {
      value: { '.read': false, '.write': false },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const inputObj = { rules: rawRules };
    const handle = rtdbRules(inputObj);

    // Mutate input object deeply after construction
    (rawRules.users as Record<string, unknown>)['.indexOn'] = ['corrupted'];
    ((rawRules.users as Record<string, unknown>).$uid as Record<string, unknown>)['.read'] = true;
    ((rawRules as Record<string, unknown>)['__proto__'] as Record<string, unknown>)['.read'] = true;

    const snap1 = handle.toJSON();
    expect(Object.getPrototypeOf(snap1.rules)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(snap1.rules, '__proto__')).toBe(true);
    expect((snap1.rules['__proto__'] as Record<string, unknown>)['.read']).toBe(false);
    expect((snap1.rules.users as Record<string, unknown>)['.indexOn']).toEqual(['handle']);

    // Mutate returned snapshot deeply
    ((snap1.rules.users as Record<string, unknown>)['.indexOn'] as string[]).push('injected');
    ((snap1.rules.users as Record<string, unknown>).$uid as Record<string, unknown>)['.read'] = true;

    const sim = handle.simulate([
      { description: 'anon read denied', expectation: 'DENY', operation: 'read', path: '/users/u1', auth: null },
      { description: 'owner read allowed', expectation: 'ALLOW', operation: 'read', path: '/users/u1', auth: { uid: 'u1' } },
    ]);
    expect(sim.passed).toBe(2);

    // Definition handle with nested children
    const def = {
      paths: {
        '/orgs/$orgId': {
          read: expr('auth != null'),
          children: {
            items: {
              indexOn: ['rank'],
              children: {
                $id: { read: deny(), write: deny() },
              },
            },
          },
        },
      },
    };
    const defHandle = rtdbRules(defineRtdbRules(def));
    def.paths['/orgs/$orgId'].read = allow();
    def.paths['/orgs/$orgId'].children.items.indexOn.push('mutated');
    def.paths['/orgs/$orgId'].children.items.children.$id.read = allow();

    const defSim = defHandle.simulate([
      { description: 'anon org read denied', expectation: 'DENY', operation: 'read', path: '/orgs/o1', auth: null },
    ]);
    expect(defSim.passed).toBe(1);
    const defJson = defHandle.toJSON() as { rules: { orgs: { $orgId: { items: { '.indexOn': string[] } } } } };
    expect(defJson.rules.orgs.$orgId.items['.indexOn']).toEqual(['rank']);

    // Callback-form defineRtdbRules({ paths(ctx) { ... } }) also isolates PathDef mutations immediately
    const sharedCbDef = { read: expr('auth != null'), indexOn: ['handle'] };
    const cbDoc = defineRtdbRules({
      paths(ctx) {
        ctx.path('/users/$uid', sharedCbDef);
      },
    });
    const cbHandle = rtdbRules(cbDoc);
    sharedCbDef.read = allow();
    sharedCbDef.indexOn.push('corrupted');

    expect(
      cbHandle.simulate([
        { description: 'anon cb read denied', expectation: 'DENY', operation: 'read', path: '/users/u1', auth: null },
      ]).passed,
    ).toBe(1);
    expect(((cbHandle.toJSON().rules.users as Record<string, unknown>)['.indexOn'])).toEqual(['handle']);

    // Sibling firestoreRules().toJSON() returns a fresh deep clone so mutating AST nodes never alters live evaluation
    const fsImmut = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
  }
}`);
    const astSnap = fsImmut.toJSON();
    astSnap.service.match.children[0]!.allows[0]!.condition = {
      type: 'literal',
      value: true,
      raw: 'true',
    };
    expect(
      fsImmut.simulate([
        { description: 'anon still denied after AST mutation', expectation: 'DENY', method: 'get', path: 'users/u1', auth: null },
      ]).passed,
    ).toBe(1);
    expect(fsImmut.toJSON().service.match.children[0]!.allows[0]!.condition.type).not.toBe('literal');
  });
});

describe('standing check: per-case exception isolation on adversarial inputs', () => {
  test('never throws from simulate() or explain() and preserves batch count partitioning across all three services', () => {
    const throwingCase = new Proxy(
      { description: 'proxy case', expectation: 'DENY' },
      {
        get(target, prop, receiver) {
          if (prop === 'path' || prop === 'method' || prop === 'operation') {
            throw new Error(`boom reading ${String(prop)}`);
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );

    const fsRs = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow get: if request.auth != null; }
  }
}`);
    const fsSummary = fsRs.simulate([
      null as unknown as FirestoreCase,
      42 as unknown as FirestoreCase,
      [] as unknown as FirestoreCase,
      throwingCase as unknown as FirestoreCase,
      { description: 'map in token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { m: new Map() } } },
      { description: 'valid allow', expectation: 'ALLOW', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
      { description: 'valid deny', expectation: 'DENY', method: 'get', path: 'items/i1', auth: null },
    ]);
    expect(fsSummary.passed + fsSummary.failed + fsSummary.unsupported).toBe(fsSummary.cases.length);
    expect(fsSummary.unsupported).toBe(5);
    expect(fsSummary.passed).toBe(2);
    expect(() => fsRs.explain(throwingCase as unknown as FirestoreCase)).not.toThrow();

    const stRs = storageRules(
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} { allow get: if request.auth != null; }
  }
}`,
      { bucket: BUCKET },
    );
    const stSummary = stRs.simulate([
      null as unknown as StorageCase,
      42 as unknown as StorageCase,
      [] as unknown as StorageCase,
      throwingCase as unknown as StorageCase,
      { description: 'weakmap in token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { wm: new WeakMap() } } },
      { description: 'valid allow', expectation: 'ALLOW', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
      { description: 'valid deny', expectation: 'DENY', method: 'get', path: 'items/i1', auth: null },
    ]);
    expect(stSummary.passed + stSummary.failed + stSummary.unsupported).toBe(stSummary.cases.length);
    expect(stSummary.unsupported).toBe(5);
    expect(stSummary.passed).toBe(2);
    expect(() => stRs.explain(throwingCase as unknown as StorageCase)).not.toThrow();

    const dbRs = rtdbRules({ rules: { items: { $id: { '.read': 'auth != null' } } } });
    const dbSummary = dbRs.simulate([
      null as unknown as RtdbCase,
      throwingCase as unknown as RtdbCase,
      { description: 'valid allow', expectation: 'ALLOW', operation: 'read', path: '/items/i1', auth: { uid: 'u1' } },
      { description: 'valid deny', expectation: 'DENY', operation: 'read', path: '/items/i1', auth: null },
    ]);
    expect(dbSummary.passed + dbSummary.failed + dbSummary.unsupported).toBe(dbSummary.cases.length);
    expect(dbSummary.unsupported).toBe(2);
    expect(dbSummary.passed).toBe(2);
    expect(() => dbRs.explain(throwingCase as unknown as RtdbCase)).not.toThrow();

    // Hostile Proxy throwing Object.create(null) + explainCase / assertCase on refused null/Proxy cases + invalid Date objects
    const nullProtoThrowingProxy = new Proxy(
      {},
      {
        get() {
          throw Object.create(null);
        },
      },
    );

    const fsNullProto = fsRs.simulate([
      null as unknown as FirestoreCase,
      nullProtoThrowingProxy as unknown as FirestoreCase,
      { description: 'invalid Date in data', expectation: 'DENY', method: 'create', path: 'items/i1', auth: { uid: 'u1' }, data: { at: new Date('invalid') } },
      { description: 'year 0000 Date in resource', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1' }, resource: { at: new Date('0000-01-01T00:00:00Z') } },
      { description: 'year 10000 Date in auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { exp: new Date('+010000-01-01T00:00:00Z') } } },
      { description: 'valid allow after null-proto throw', expectation: 'ALLOW', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
    ]);
    expect(fsNullProto.unsupported).toBe(5);
    expect(fsNullProto.passed).toBe(1);
    for (const c of fsNullProto.cases.slice(0, 5)) {
      expect(typeof explainCase(c)).toBe('string');
      expect(() => assertCase(c)).toThrow(RulesUnsupportedError);
    }

    const stNullProto = stRs.simulate([
      null as unknown as StorageCase,
      nullProtoThrowingProxy as unknown as StorageCase,
      { description: 'invalid Date in auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { exp: new Date('invalid') } } },
      { description: 'valid allow after null-proto throw', expectation: 'ALLOW', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
    ]);
    expect(stNullProto.unsupported).toBe(3);
    expect(stNullProto.passed).toBe(1);
    for (const c of stNullProto.cases.slice(0, 3)) {
      expect(typeof explainCase(c)).toBe('string');
      expect(() => assertCase(c)).toThrow(RulesUnsupportedError);
    }

    const dbNullProto = dbRs.simulate([
      null as unknown as RtdbCase,
      nullProtoThrowingProxy as unknown as RtdbCase,
      { description: 'valid allow after null-proto throw', expectation: 'ALLOW', operation: 'read', path: '/items/i1', auth: { uid: 'u1' } },
    ]);
    expect(dbNullProto.unsupported).toBe(2);
    expect(dbNullProto.passed).toBe(1);
    for (const c of dbNullProto.cases.slice(0, 2)) {
      expect(typeof explainCase(c)).toBe('string');
      expect(() => assertCase(c)).toThrow(RulesUnsupportedError);
    }
  });

  test('executes cleanly in a browser-like environment with Buffer absent', () => {
    const g = globalThis as Record<string, unknown>;
    const savedBuffer = g.Buffer;
    try {
      delete g.Buffer;
      const modularSt = [
        "rules_version = '2+modules';",
        "import { isAuthenticated } from 'auth';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        '      allow get: if isAuthenticated() && request.auth.token.sig is bytes;',
        '    }',
        '  }',
        '}',
      ].join('\n');
      expect(lint(modularSt).filter((i) => i.origin === 'parse')).toEqual([]);
      const st = storageRules(modularSt, { bucket: BUCKET });
      const res = st.simulate([
        {
          description: 'browser-safe simulation without Buffer',
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/i1',
          requestTime: '2024-02-29T12:00:00Z',
          auth: { uid: 'u1', token: { sig: bytes('ok'), exp: timestamp('2028-01-01T00:00:00Z') } },
        },
      ]);
      expect(res.passed).toBe(1);
    } finally {
      g.Buffer = savedBuffer;
    }
  });
});
