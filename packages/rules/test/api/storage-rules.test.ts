/**
 * `storageRules(source)` and the `StorageCase` form: Storage rules cases
 * through the public front door, with every binding taken as given.
 */
import { describe, test, expect } from 'bun:test';
import {
  storageRules,
  lint,
  assertCase,
  explainCase,
  RulesCompileError,
  RulesAssertionError,
  RulesUnsupportedError,
  type StorageCase,
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
});
