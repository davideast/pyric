/**
 * `storageRules(source)` and the `StorageCase` form: Storage rules cases
 * through the public front door, with every binding taken as given.
 */
import { describe, test, expect } from 'bun:test';
import {
  storageRules,
  firestoreRules,
  rtdbRules,
  lint,
  assertCase,
  explainCase,
  serverTimestamp,
  RulesCompileError,
  RulesAssertionError,
  RulesUnsupportedError,
  type StorageCase,
  type FirestoreCase,
  type RtdbCase,
} from '@pyric/rules';

const BUCKET = 'demo-app.appspot.com';

const AVATAR_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid}/{file} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 1024 * 1024
        && request.resource.contentType.matches('image/.*');
      allow delete: if request.auth.uid == uid && resource.metadata.owner == uid;
    }
    match /exports/{file} {
      allow read: if bucket == 'demo-app-exports';
    }
    match /shared/{file} {
      allow read: if firestore.get(/databases/(default)/documents/shares/$(file)).data.open == true;
    }
  }
}`;

const UPLOAD: StorageCase = {
  description: 'alice uploads her avatar',
  expectation: 'ALLOW',
  method: 'create',
  bucket: BUCKET,
  path: 'avatars/alice/me.png',
  auth: { uid: 'alice' },
  requestResource: { size: 2048, contentType: 'image/png', name: 'avatars/alice/me.png', bucket: BUCKET },
};

describe('storageRules', () => {
  test('allows an upload the rules grant', () => {
    const summary = storageRules(AVATAR_RULES).simulate([UPLOAD]);
    expect(summary).toMatchObject({ passed: 1, failed: 0, unsupported: 0 });
    expect(summary.cases[0]).toMatchObject({
      decision: 'ALLOW',
      bucket: BUCKET,
      decidingRule: { path: 'match /avatars/{uid}/{file}', line: 6 },
    });
  });

  test('denies an upload into another user\'s folder, naming the rule that refused it', () => {
    const intruder: StorageCase = { ...UPLOAD, description: 'mallory writes to alice', expectation: 'DENY', auth: { uid: 'mallory' } };
    const [result] = storageRules(AVATAR_RULES).simulate([intruder]).cases;
    expect(result.decision).toBe('DENY');
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual(['match /avatars/{uid}/{file} create: condition false']);
  });

  test('reads resource as given on a delete', () => {
    const ruleset = storageRules(AVATAR_RULES);
    const base = { method: 'delete', bucket: BUCKET, path: 'avatars/alice/me.png', auth: { uid: 'alice' } } as const;
    const summary = ruleset.simulate([
      { ...base, description: 'owner deletes', expectation: 'ALLOW', resource: { size: 1, metadata: { owner: 'alice' } } },
      { ...base, description: 'no object stored', expectation: 'DENY' },
    ]);
    expect(summary.cases.map((r) => r.decision)).toEqual(['ALLOW', 'DENY']);
  });

  test('binds the bucket wildcard to the case\'s bucket, or the ruleset\'s default', () => {
    const exportsRead = { method: 'get', path: 'exports/report.csv' } as const;
    const ruleset = storageRules(AVATAR_RULES, { bucket: 'demo-app-exports' });
    const summary = ruleset.simulate([
      { ...exportsRead, description: 'default bucket', expectation: 'ALLOW' },
      { ...exportsRead, description: 'gs:// bucket url', expectation: 'ALLOW', bucket: 'gs://demo-app-exports' },
      { ...exportsRead, description: 'another bucket', expectation: 'DENY', bucket: BUCKET },
    ]);
    expect(summary.cases.map((r) => [r.bucket, r.decision])).toEqual([
      ['demo-app-exports', 'ALLOW'],
      ['demo-app-exports', 'ALLOW'],
      [BUCKET, 'DENY'],
    ]);
  });

  test('throws RulesCompileError with the parse error on .issues', () => {
    let thrown: unknown;
    try {
      storageRules(`service firebase.storage { match /b/{bucket}/o { allow read: if ; } }`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RulesCompileError);
    const issues = (thrown as RulesCompileError).issues;
    expect(issues[0]).toMatchObject({ code: 'PARSE_ERROR', severity: 'error', origin: 'parse', line: 1 });
  });

  test('refuses a Firestore ruleset by naming the service it expected', () => {
    const firestore = `rules_version = '2';
service cloud.firestore { match /databases/{d}/documents { allow read: if true; } }`;
    expect(() => storageRules(firestore)).toThrow(/Expected 'service firebase.storage'/);
  });

  test('explain returns the verdict, the deciding rule and the reasons without the case', () => {
    const explanation = storageRules(AVATAR_RULES).explain({ ...UPLOAD, requestResource: { size: 2048, contentType: 'text/plain' } });
    expect(explanation).toMatchObject({
      decision: 'DENY',
      expectation: 'ALLOW',
      passed: false,
      unsupported: false,
      bucket: BUCKET,
      decidingRule: { path: 'match /avatars/{uid}/{file}', line: 6 },
      reasons: ['match /avatars/{uid}/{file} create: condition false'],
    });
    expect(explanation.evaluatedExpressions).toBeGreaterThan(0);
    expect('case' in explanation).toBe(false);
  });

  test('explainCase renders the request, the deciding rule and each reason', () => {
    const [result] = storageRules(AVATAR_RULES).simulate([{ ...UPLOAD, auth: null }]).cases;
    expect(explainCase(result).split('\n')).toEqual([
      'FAIL: alice uploads her avatar',
      `  create avatars/alice/me.png in ${BUCKET} (expected ALLOW, got DENY)`,
      '  deciding rule: match /avatars/{uid}/{file} (line 6)',
      '  reason: match /avatars/{uid}/{file} create: Property auth is undefined on object.',
    ]);
  });

  test('assertCase(storageRuleset, oneCase) passes, and throws the trace on a miss', () => {
    const ruleset = storageRules(AVATAR_RULES);
    expect(() => assertCase(ruleset, UPLOAD)).not.toThrow();
    expect(() => assertCase(ruleset, { ...UPLOAD, expectation: 'DENY' })).toThrow(RulesAssertionError);
  });

  test('answers firestore.get() from the case\'s documents', () => {
    const read = { method: 'get', bucket: BUCKET, path: 'shared/a.txt', auth: { uid: 'bob' } } as const;
    const summary = storageRules(AVATAR_RULES).simulate([
      { ...read, description: 'open share', expectation: 'ALLOW', firestore: { 'shares/a.txt': { open: true } } },
      { ...read, description: 'no share document', expectation: 'DENY', firestore: {} },
    ]);
    expect(summary.cases.map((r) => r.decision)).toEqual(['ALLOW', 'DENY']);
  });

  test('reports a case it cannot evaluate as given as UNSUPPORTED, with the reason', () => {
    const ruleset = storageRules(AVATAR_RULES);
    const summary = ruleset.simulate([
      { ...UPLOAD, description: 'no bucket', bucket: undefined },
      { ...UPLOAD, description: 'coarse write', method: 'write' as StorageCase['method'] },
      { ...UPLOAD, description: 'bad time', requestTime: 'yesterday' },
      { description: 'unsupplied document', expectation: 'DENY', method: 'get', bucket: BUCKET, path: 'shared/a.txt' },
    ]);
    expect(summary).toMatchObject({ passed: 0, failed: 0, unsupported: 4 });
    expect(summary.cases.map((r) => r.reasons[0])).toEqual([
      'The case names no bucket. Pass bucket on the case or as an option to storageRules().',
      'Unknown method "write". A case names one of read, get, list, create, update, delete.',
      'requestTime "yesterday" is not an ISO-8601 time.',
      'The rules read a Firestore document. Pass the documents they read as firestore on the case.',
    ]);
    expect(() => assertCase(summary.cases[0])).toThrow(RulesUnsupportedError);
  });

  test('reports a read or delete case that carries requestResource as UNSUPPORTED, naming the field and method', () => {
    const sizeGate = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      allow read, delete: if request.resource.size < 10;
    }
  }
}`;
    const base = { expectation: 'DENY', bucket: BUCKET, path: 'a.txt', requestResource: { size: 1 } } as const;
    const summary = storageRules(sizeGate).simulate([
      { ...base, description: 'get', method: 'get' },
      { ...base, description: 'list', method: 'list' },
      { ...base, description: 'read', method: 'read' },
      { ...base, description: 'delete', method: 'delete' },
      { description: 'get without it', expectation: 'DENY', method: 'get', bucket: BUCKET, path: 'a.txt' },
    ]);
    expect(summary.cases.map((r) => r.decision)).toEqual(['UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED', 'DENY']);
    expect(summary.cases[0].reasons).toEqual([
      'requestResource is set on a get case. Production leaves request.resource unset for get, so omit it.',
    ]);
  });

  test('reports a bucket holding a "/" as UNSUPPORTED rather than rewriting the path', () => {
    const anyBucket = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /evil/{file} { allow read: if true; }
  }
}`;
    const [result] = storageRules(anyBucket).simulate([
      { description: 'slash bucket', expectation: 'DENY', method: 'get', bucket: 'x/o/evil', path: 'a.txt' },
    ]).cases;
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reasons).toEqual(['Bucket "x/o/evil" holds a "/". A bucket name has none.']);
  });

  test('keeps running the batch past a malformed case', () => {
    const noPath = { description: 'no path', expectation: 'ALLOW', method: 'get', bucket: BUCKET } as unknown as StorageCase;
    const summary = storageRules(AVATAR_RULES).simulate([noPath, { ...UPLOAD }]);
    expect(summary).toMatchObject({ passed: 1, unsupported: 1 });
    expect(summary.cases[0].reasons).toEqual(['The case has no path. Pass the object path within the bucket as path.']);
  });

  test('accepts only an ISO-8601 time with an offset as requestTime', () => {
    const timed = (requestTime: string): StorageCase => ({ ...UPLOAD, description: requestTime, requestTime });
    const summary = storageRules(AVATAR_RULES).simulate([
      timed('2026-01-02T03:04:05Z'),
      timed('2026-01-02T03:04:05.123+01:00'),
      timed('2026-01-02'),
      timed('Jan 2, 2026'),
      timed('1700000000000'),
    ]);
    expect(summary.cases.map((r) => r.decision)).toEqual(['ALLOW', 'ALLOW', 'UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED']);
  });

  test('binds list and update to their own grants', () => {
    const docs = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{file} {
      allow list: if request.auth != null;
      allow update: if request.auth.uid == resource.metadata.owner
        && request.resource.metadata.owner == resource.metadata.owner;
    }
  }
}`;
    const stored = { size: 5, metadata: { owner: 'alice' } };
    const base = { bucket: BUCKET, path: 'docs/a.txt', auth: { uid: 'alice' } } as const;
    const summary = storageRules(docs).simulate([
      { ...base, description: 'list', expectation: 'ALLOW', method: 'list' },
      { ...base, description: 'get has no grant', expectation: 'DENY', method: 'get' },
      { ...base, description: 'owner keeps owner', expectation: 'ALLOW', method: 'update', resource: stored,
        requestResource: { size: 5, metadata: { owner: 'alice' } } },
      { ...base, description: 'owner hands it over', expectation: 'DENY', method: 'update', resource: stored,
        requestResource: { size: 5, metadata: { owner: 'mallory' } } },
    ]);
    expect(summary.cases.map((r) => r.decision)).toEqual(['ALLOW', 'DENY', 'ALLOW', 'DENY']);
    expect(summary.passed).toBe(4);
  });

  test('marks each result as a Storage one', () => {
    const [result] = storageRules(AVATAR_RULES).simulate([UPLOAD]).cases;
    expect(result.service).toBe('storage');
    expect(storageRules(AVATAR_RULES).explain(UPLOAD).service).toBe('storage');
  });

  test('lint() reports the findings the free lint() reports for the same source', () => {
    const issues = storageRules(AVATAR_RULES).lint();
    expect(issues).toEqual(lint(AVATAR_RULES));
    expect(issues.some((issue) => issue.origin === 'parse' && issue.severity === 'error')).toBe(false);
  });

  test('validates StorageCase shape, scalar bounds, and firestore lookup entries strictly', () => {
    const ruleset = storageRules(
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if firestore.exists(/databases/(default)/documents/users/u1)
        && firestore.get(/databases/(default)/documents/users/u1).data.active == true;
      allow list: if firestore.get(/databases/(default)/documents/users/u1).data.ts.__type == 'serverTimestamp';
      allow create: if request.resource.size is float || request.resource.size >= 0;
      allow delete: if resource.timeCreated != null || true;
    }
  }
}`,
      { bucket: BUCKET },
    );

    // Leading-slash and full resource-name keys for the default database normalize cleanly.
    const validLookupSummary = ruleset.simulate([
      {
        description: 'leading slash key',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        firestore: { '/users/u1': { active: true } },
      },
      {
        description: 'full resource key',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        firestore: { '/databases/(default)/documents/users/u1': { active: true } },
      },
    ]);
    expect(validLookupSummary.passed).toBe(2);

    // Malformed shapes, null/sentinel firestore entries, float/negative sizes, bad timestamps, and unknown keys become UNSUPPORTED.
    const invalidCases: StorageCase[] = [
      {
        description: 'null firestore doc entry',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        firestore: { 'users/u1': null as unknown as Record<string, unknown> },
      },
      {
        description: 'null firestore map',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        firestore: null as unknown as Record<string, Record<string, unknown>>,
      },
      {
        description: 'serverTimestamp sentinel in stored firestore doc',
        expectation: 'DENY',
        method: 'list',
        path: 'items/i1',
        firestore: { 'users/u1': { ts: serverTimestamp() } },
      },
      {
        description: 'nested serverTimestamp sentinel in stored firestore doc',
        expectation: 'DENY',
        method: 'list',
        path: 'items/i1',
        firestore: { 'users/u1': { history: [{ at: serverTimestamp() }] } },
      },
      {
        description: 'odd-segment collection key in firestore map',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        firestore: { users: { active: true } },
      },
      {
        description: 'non-default database key in firestore map',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        firestore: { '/databases/secondary/documents/users/u1': { active: true } },
      },
      {
        description: 'duplicate normalized keys in firestore map',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        firestore: { 'users/u1': { active: true }, '/users/u1': { active: false } },
      },
      {
        description: 'float requestResource.size',
        expectation: 'DENY',
        method: 'create',
        path: 'items/i1',
        requestResource: { size: 1.5 },
      },
      {
        description: 'negative requestResource.size',
        expectation: 'DENY',
        method: 'create',
        path: 'items/i1',
        requestResource: { size: -1 },
      },
      {
        description: 'null requestResource on create',
        expectation: 'DENY',
        method: 'create',
        path: 'items/i1',
        requestResource: null as unknown as StorageCase['requestResource'],
      },
      {
        description: 'invalid resource.timeCreated string',
        expectation: 'DENY',
        method: 'delete',
        path: 'items/i1',
        resource: { size: 1, timeCreated: 'not-a-timestamp' },
      },
      {
        description: 'year 0000 resource.timeCreated',
        expectation: 'DENY',
        method: 'delete',
        path: 'items/i1',
        resource: { size: 1, timeCreated: '0000-01-01T00:00:00Z' },
      },
      {
        description: 'calendar-invalid resource.updated',
        expectation: 'DENY',
        method: 'delete',
        path: 'items/i1',
        resource: { size: 1, updated: '2026-02-31T00:00:00Z' },
      },
      {
        description: 'lowercase expectation and Firestore data key',
        expectation: 'allow' as StorageCase['expectation'],
        method: 'create',
        path: 'items/i1',
        requestResource: { size: 10 },
        ...({ data: { size: 10 } } as Record<string, unknown>),
      },
    ];

    const invalidSummary = ruleset.simulate(invalidCases);
    expect(invalidSummary.unsupported).toBe(invalidCases.length);
    expect(invalidSummary.passed).toBe(0);
    expect(invalidSummary.failed).toBe(0);
    expect(invalidSummary.cases.every((c) => c.decision === 'UNSUPPORTED' && c.unsupported)).toBe(true);
  });

  test('isolates adversarial case inputs as UNSUPPORTED without throwing or aborting batches across storageRules, firestoreRules, and rtdbRules', () => {
    const cyclicToken: Record<string, unknown> = {};
    cyclicToken.self = cyclicToken;

    const stRules = storageRules(
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if request.time != null;
      allow list: if resource.timeCreated != null;
      allow create: if request.resource != null && request.resource.size < 100;
    }
  }
}`,
      { bucket: BUCKET },
    );

    const stBatch = stRules.simulate([
      { description: 'year 0000 requestTime', expectation: 'DENY', method: 'get', path: 'items/i1', requestTime: '0000-01-01T00:00:00Z' },
      { description: 'year 0000 resource timeCreated', expectation: 'DENY', method: 'list', path: 'items/i1', resource: { size: 1, timeCreated: '0000-01-01T00:00:00Z' } },
      { description: 'null requestResource on create', expectation: 'DENY', method: 'create', path: 'items/i1', requestResource: null as unknown as StorageCase['requestResource'] },
      { description: 'function in auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { fn: () => true } } },
      { description: 'symbol in auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { sym: Symbol('s') } } },
      { description: 'cyclic auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: cyclicToken } },
      { description: 'valid control get', expectation: 'ALLOW', method: 'get', path: 'items/i1' },
    ]);
    expect(stBatch.unsupported).toBe(6);
    expect(stBatch.passed).toBe(1);

    const fsRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.time != null;
    }
  }
}`);
    const fsBatch = fsRules.simulate([
      { description: 'year 0000', expectation: 'DENY', method: 'get', path: 'items/i1', requestTime: '0000-01-01T00:00:00Z' },
      { description: 'function in auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: { fn: () => true } } },
      { description: 'cyclic auth.token', expectation: 'DENY', method: 'get', path: 'items/i1', auth: { uid: 'u1', token: cyclicToken } },
      { description: 'valid control get', expectation: 'ALLOW', method: 'get', path: 'items/i1' } as FirestoreCase,
    ]);
    expect(fsBatch.unsupported).toBe(3);
    expect(fsBatch.passed).toBe(1);

    const dbRules = rtdbRules({ rules: { items: { $id: { '.read': 'auth != null' } } } });
    const dbBatch = dbRules.simulate([
      { description: 'function in auth.token', expectation: 'DENY', operation: 'read', path: '/items/i1', auth: { uid: 'u1', token: { fn: () => true } } } as RtdbCase,
      { description: 'valid control read', expectation: 'ALLOW', operation: 'read', path: '/items/i1', auth: { uid: 'u1' } },
    ]);
    expect(dbBatch.unsupported).toBe(1);
    expect(dbBatch.passed).toBe(1);
  });

  test('reports Storage and 2+modules compile blockers with origin: parse and exact line numbers in lint() and storageRules()', () => {
    const storageInvalidRegex = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow get: if id.matches('(?=a)a');",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const regexParseIssues = lint(storageInvalidRegex).filter((i) => i.origin === 'parse');
    expect(regexParseIssues).toEqual([
      expect.objectContaining({
        code: 'INVALID_REGEX_PATTERN',
        severity: 'error',
        origin: 'parse',
        line: 5,
      }),
    ]);

    let thrownRegex: unknown;
    try {
      storageRules(storageInvalidRegex, { bucket: BUCKET });
    } catch (err) {
      thrownRegex = err;
    }
    expect(thrownRegex).toBeInstanceOf(RulesCompileError);
    expect((thrownRegex as RulesCompileError).issues[0]).toMatchObject({
      code: 'INVALID_REGEX_PATTERN',
      severity: 'error',
      origin: 'parse',
      line: 5,
    });

    const storageV2Import = [
      "rules_version = '2';",
      "import { isAuthenticated } from 'auth';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow get: if isAuthenticated();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const v2ImportParseIssues = lint(storageV2Import).filter((i) => i.origin === 'parse');
    expect(v2ImportParseIssues).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_MODULES',
        severity: 'error',
        origin: 'parse',
        line: 2,
      }),
    ]);

    const storageIncompatibleImport = [
      "rules_version = '2+modules';",
      "import { validString } from 'validation';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow create: if request.auth != null && validString('title', 1, 50);",
      '    }',
      '  }',
      '}',
    ].join('\n');
    const incompatParseIssues = lint(storageIncompatibleImport).filter((i) => i.origin === 'parse');
    expect(incompatParseIssues).toEqual([
      expect.objectContaining({
        code: 'INCOMPATIBLE_FUNCTION',
        severity: 'error',
        origin: 'parse',
        line: 2,
      }),
    ]);
  });

  test('lints and checks compile limits across all service blocks in multi-service files', () => {
    const multiServiceOpenStorage = [
      "rules_version = '2';",
      'function isSignedIn() { return request.auth != null; }',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /users/{uid} {',
      '      allow get: if request.auth != null && request.auth.uid == uid;',
      '    }',
      '    match /{document=**} { allow read, write: if false; }',
      '  }',
      '}',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow get: if isSignedIn();',
      '    }',
      '    match /{allPaths=**} {',
      '      allow read, write: if true;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const scopedStorageIssues = storageRules(multiServiceOpenStorage, { bucket: BUCKET }).lint();
    expect(scopedStorageIssues.some((i) => i.code === 'SEC-1' && i.severity === 'error')).toBe(true);
    expect(scopedStorageIssues.some((i) => i.code === 'RECURSIVE_WILDCARD_OPEN' && i.severity === 'error')).toBe(true);
    // Global function called by the Storage block is not falsely flagged as unused (QUA-4).
    expect(scopedStorageIssues.some((i) => i.code === 'QUA-4')).toBe(false);

    const freeLintIssues = lint(multiServiceOpenStorage);
    expect(freeLintIssues.some((i) => i.code === 'SEC-1' && i.severity === 'error')).toBe(true);
    expect(freeLintIssues.some((i) => i.code === 'QUA-4')).toBe(false);

    const multiServiceGlobError = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{document=**} { allow read, write: if false; }',
      '  }',
      '}',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{a=**}/items/{b=**} {',
      '      allow get: if request.auth != null;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const globIssues = lint(multiServiceGlobError).filter((i) => i.origin === 'parse');
    expect(globIssues).toEqual([
      expect.objectContaining({
        code: 'GLOB_MATCH_COUNT',
        severity: 'error',
        origin: 'parse',
        line: 9,
      }),
    ]);
  });

  test('maps 2+modules Storage decidingRule and lint() / compile error lines back to authored source lines', () => {
    const modularStorage = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow get: if isAuthenticated();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const stRs = storageRules(modularStorage, { bucket: BUCKET });
    const [stAllowed] = stRs.simulate([
      { description: 'signed in get', expectation: 'ALLOW', method: 'get', path: 'items/i1', auth: { uid: 'u1' } },
    ]).cases;
    expect(stAllowed.decidingRule).toEqual({ path: 'match /items/{id}', line: 6 });
    expect(stRs.explain({
      description: 'signed in get',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/i1',
      auth: { uid: 'u1' },
    }).decidingRule).toEqual({ path: 'match /items/{id}', line: 6 });

    const modularLintRegex = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      "      allow get: if isAuthenticated() && id.matches('(?=a)a');",
      '    }',
      '  }',
      '}',
    ].join('\n');
    const regexIssue = lint(modularLintRegex).find((i) => i.code === 'INVALID_REGEX_PATTERN');
    expect(regexIssue).toMatchObject({
      code: 'INVALID_REGEX_PATTERN',
      origin: 'parse',
      line: 6,
    });

    let fsCompileErr: unknown;
    try {
      firestoreRules(modularLintRegex);
    } catch (err) {
      fsCompileErr = err;
    }
    expect(fsCompileErr).toBeInstanceOf(RulesCompileError);
    expect((fsCompileErr as RulesCompileError).issues[0]).toMatchObject({
      code: 'INVALID_REGEX_PATTERN',
      origin: 'parse',
      line: 6,
    });
  });
});
