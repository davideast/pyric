/**
 * REQUEST_TIME_NOT_PINNED — REBUILD_PLAN.md Item 0.F deferred follow-up.
 *
 * The static linter couples to the test suite via `lintFirestoreRules(src,
 * { testCases })`. When a rule transitively reads `request.time`, every
 * test case targeting that rule without `requestTime` set produces a
 * warning. Existing source-only callers are unaffected.
 */
import { describe, test, expect } from 'bun:test';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

function rules(condition: string, helpers = ''): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${helpers}
    match /docs/{id} {
      allow read: if ${condition};
    }
  }
}`;
}

const tcDocs = (overrides: Partial<TestCase> = {}): TestCase => ({
  description: 'read docs/d1',
  expectation: 'ALLOW',
  method: 'get',
  path: 'docs/d1',
  ...overrides,
});

function findRule(result: ReturnType<typeof lintFirestoreRules>, code: string) {
  return result.warnings.filter(w => w.rule === code);
}

describe('REQUEST_TIME_NOT_PINNED — direct request.time access', () => {
  test('rule reads request.time + tc without requestTime → warning', () => {
    const r = lintFirestoreRules(
      rules("request.time > timestamp.value(0)"),
      { testCases: [tcDocs()] },
    );
    const hits = findRule(r, 'REQUEST_TIME_NOT_PINNED');
    expect(hits.length).toBe(1);
    expect(hits[0]!.message).toContain('"read docs/d1"');
    expect(hits[0]!.location?.testCaseDescription).toBe('read docs/d1');
    expect(hits[0]!.fix).toContain('requestTime');
  });

  test('rule reads request.time + tc WITH requestTime → no warning', () => {
    const r = lintFirestoreRules(
      rules("request.time > timestamp.value(0)"),
      { testCases: [tcDocs({ requestTime: '2026-01-01T00:00:00Z' })] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });

  test('rule does NOT read request.time → no warning even without pinned time', () => {
    const r = lintFirestoreRules(
      rules("request.auth != null"),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });

  test('bracket form request[\'time\'] is also detected', () => {
    const r = lintFirestoreRules(
      rules("request['time'] > timestamp.value(0)"),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(1);
  });

  test('property named time on a different object is NOT a hit', () => {
    // resource.data.time is a user field, not the global request.time.
    const r = lintFirestoreRules(
      rules("resource.data.time > 0"),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });
});

describe('REQUEST_TIME_NOT_PINNED — transitive through functions', () => {
  test('helper function reads request.time → warning still fires', () => {
    const helpers = `function isRecent() { return request.time > timestamp.value(0); }`;
    const r = lintFirestoreRules(
      rules('isRecent()', helpers),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(1);
  });

  test('helper that does NOT read request.time → no warning', () => {
    const helpers = `function isAuthed() { return request.auth != null; }`;
    const r = lintFirestoreRules(
      rules('isAuthed()', helpers),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });

  test('two-hop function reference is detected', () => {
    const helpers = `
      function inner() { return request.time > timestamp.value(0); }
      function outer() { return inner(); }
    `;
    const r = lintFirestoreRules(
      rules('outer()', helpers),
      { testCases: [tcDocs()] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(1);
  });
});

describe('REQUEST_TIME_NOT_PINNED — match-path resolution', () => {
  test('only test cases targeting the time-gated rule warn', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /timed/{id} { allow read: if request.time > timestamp.value(0); }
    match /open/{id}  { allow read: if true; }
  }
}`;
    const r = lintFirestoreRules(src, {
      testCases: [
        tcDocs({ description: 'targets timed', path: 'timed/x' }),
        tcDocs({ description: 'targets open',  path: 'open/y' }),
      ],
    });
    const hits = findRule(r, 'REQUEST_TIME_NOT_PINNED');
    expect(hits.length).toBe(1);
    expect(hits[0]!.location?.testCaseDescription).toBe('targets timed');
    expect(hits[0]!.location?.matchPath).toContain('timed/{id}');
  });

  test('wildcard segment matches any path segment', () => {
    // Rule path /a/{x}/b/{y} matches tc path a/1/b/2 but not a/1/c/2.
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{x}/b/{y} { allow read: if request.time > timestamp.value(0); }
  }
}`;
    const r = lintFirestoreRules(src, {
      testCases: [
        tcDocs({ description: 'matches', path: 'a/1/b/2' }),
        tcDocs({ description: 'wrong shape', path: 'a/1/c/2' }),
      ],
    });
    const hits = findRule(r, 'REQUEST_TIME_NOT_PINNED');
    expect(hits.length).toBe(1);
    expect(hits[0]!.location?.testCaseDescription).toBe('matches');
  });
});

describe('REQUEST_TIME_NOT_PINNED — back-compat', () => {
  test('source-only call (no testCases) is unchanged', () => {
    const r = lintFirestoreRules(rules("request.time > timestamp.value(0)"));
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });

  test('empty testCases array does not fire', () => {
    const r = lintFirestoreRules(
      rules("request.time > timestamp.value(0)"),
      { testCases: [] },
    );
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });

  test('parse error still short-circuits the time check', () => {
    const r = lintFirestoreRules(
      "this is not valid rules source",
      { testCases: [tcDocs()] },
    );
    expect(r.parseError).toBeDefined();
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED').length).toBe(0);
  });
});

describe('REQUEST_TIME_NOT_PINNED — multiple test cases', () => {
  test('one warning per affected test case', () => {
    const r = lintFirestoreRules(
      rules("request.time > timestamp.value(0)"),
      {
        testCases: [
          tcDocs({ description: 'tc1' }),
          tcDocs({ description: 'tc2' }),
          tcDocs({ description: 'tc3', requestTime: '2026-01-01T00:00:00Z' }),
        ],
      },
    );
    const hits = findRule(r, 'REQUEST_TIME_NOT_PINNED');
    expect(hits.length).toBe(2);
    const descs = hits.map(h => h.location?.testCaseDescription).sort();
    expect(descs).toEqual(['tc1', 'tc2']);
  });
});
