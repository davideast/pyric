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

describe('FS-LNT-4, FS-LNT-6a, FS-LNT-7, FS-LNT-8 regressions', () => {
  test('FS-LNT-4: lintFirestoreRules reports GLOB_MATCH_COUNT and mutually recursive CALL_DEPTH', () => {
    const doubleGlob = lintFirestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{x=**} {
      match /b/{y=**} {
        allow read: if request.auth != null;
      }
    }
  }
}`);
    expect(doubleGlob.warnings.some(w => w.rule === 'GLOB_MATCH_COUNT' && w.severity === 'error')).toBe(true);

    const cycle = lintFirestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function a() { return b(); }
    function b() { return a(); }
    match /items/{id} {
      allow read: if a();
    }
  }
}`);
    expect(cycle.warnings.some(w => w.rule === 'CALL_DEPTH' && w.severity === 'error')).toBe(true);
  });

  test('FS-LNT-6a: evalConstBool folds ternary constant true for PERMISSIVE_RULE and RECURSIVE_WILDCARD_OPEN', () => {
    const r = lintFirestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true ? true : false;
    }
  }
}`);
    expect(r.warnings.some(w => w.rule === 'PERMISSIVE_RULE')).toBe(true);
    expect(r.warnings.some(w => w.rule === 'RECURSIVE_WILDCARD_OPEN')).toBe(true);
  });

  test('FS-LNT-7: lexical function scoping prevents sibling and shadowed functions from polluting GET_COUNT, GET_DUPLICATION, and REQUEST_TIME_NOT_PINNED', () => {
    const sixExists = Array.from(
      { length: 6 },
      (_, i) => `exists(/databases/$(database)/documents/c${i}/$(id))`,
    ).join(' && ');

    const siblingSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /light/{id} {
      function check() { return request.auth != null; }
      allow read: if check() && check();
    }
    match /heavy/{id} {
      function check() {
        return ${sixExists} && request.time > timestamp.date(2025, 1, 1);
      }
      allow read: if check();
    }
  }
}`;
    const siblingRes = lintFirestoreRules(siblingSource, {
      testCases: [
        {
          description: 'read light',
          expectation: 'ALLOW',
          method: 'get',
          path: 'light/1',
          auth: { uid: 'u1' },
        },
      ],
    });
    const rule1Warnings = siblingRes.warnings.filter(w => w.location?.ruleIndex === 1);
    expect(rule1Warnings).toHaveLength(0);

    const shadowSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /items/{id} {
      function helper() { return ${sixExists}; }
      allow read: if helper();
      match /sub/{subId} {
        function helper() { return request.auth != null; }
        allow read: if helper() && helper();
      }
    }
  }
}`;
    const shadowRes = lintFirestoreRules(shadowSource);
    const subWarnings = shadowRes.warnings.filter(
      w => w.location?.ruleIndex === 2 && (w.rule === 'GET_COUNT' || w.rule === 'GET_DUPLICATION'),
    );
    expect(subWarnings).toHaveLength(0);
  });

  test('FS-LNT-8: collectAllRules uses full match path from root for SHARED_GATE and REQUEST_TIME_NOT_PINNED', () => {
    const r = lintFirestoreRules(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /users/{uid} {
      allow read: if request.auth != null;
      match /items/{id} {
        allow update: if request.auth != null
                      && request.time > timestamp.date(2025, 1, 1)
                      && request.resource.data.title is string;
      }
    }
    match /orgs/{orgId} {
      allow read: if request.auth != null;
      match /items/{id} {
        allow update: if request.auth != null
                      && request.resource.data.name is string;
      }
    }
  }
}`,
      {
        testCases: [
          {
            description: 'update nested user item without requestTime',
            expectation: 'ALLOW',
            method: 'update',
            path: 'users/u1/items/i1',
            auth: { uid: 'u1' },
            data: { title: 'hello' },
          },
        ],
      },
    );
    expect(findRule(r, 'SHARED_GATE')).toHaveLength(0);
    expect(findRule(r, 'REQUEST_TIME_NOT_PINNED')).toHaveLength(1);
  });
});
