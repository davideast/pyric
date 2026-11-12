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

  test('lint() reports the findings the free lint() reports for the same source', () => {
    const issues = storageRules(AVATAR_RULES).lint();
    expect(issues).toEqual(lint(AVATAR_RULES));
    expect(issues.some((issue) => issue.origin === 'parse' && issue.severity === 'error')).toBe(false);
  });
});
