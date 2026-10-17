import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'FS-SIM-SEMANTICS',
  rationale:
    'Proves production Firestore Rules enforces numeric operands on arithmetic, user function shadowing and arity, Java Matcher replace escapes, builtin/method arity and argument types, absence of request.resource on get/delete, calendar bounds on timestamp.date, string keys in map literals, and document-path arguments to exists/get.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function int(x) { return 42; }
    function pairFirst(a, b) { return a; }
    function mapWithKey(k) { return {k: 'v'}; }

    match /sim2a/{id} {
      allow read: if 'abc' - 'a' != 0;
    }
    match /sim2b/{id} {
      allow read: if -'5' == -5;
    }
    match /sim4a/{id} {
      allow read: if int('99') == 42;
    }
    match /sim4b/{id} {
      allow read: if pairFirst(1) == 1;
    }
    match /sim5a/{id} {
      allow read: if 'abc'.replace('b', '\\\\$') == 'a$c';
    }
    match /sim5b/{id} {
      allow read: if 'abc'.lower(1) == 'abc';
    }
    match /sim6a/{id} {
      allow read: if [1, 2].toSet('x').size() == 2;
    }
    match /sim6b/{id} {
      allow read: if {'a': 1}.get('a', 0, 99) == 1;
    }
    match /sim6c/{id} {
      allow read: if {'a': 1}.diff({'a': 1}, 'x').affectedKeys().size() == 0;
    }
    match /sim6d/{id} {
      allow read: if {'a': 1}.diff('notamap').affectedKeys().size() >= 0;
    }
    match /sim9a/{id} {
      allow get, delete: if !('resource' in request);
    }
    match /sim9b/{id} {
      allow delete: if request.resource.data.x == 1;
    }
    match /sim9c/{id} {
      allow delete: if request.resource.data.size() == 0;
    }
    match /sim10a/{id} {
      allow read: if timestamp.date(2024, 13, 1).month() > 0;
    }
    match /sim10b/{id} {
      allow read: if timestamp.date(2024, 2, 30).day() > 0;
    }
    match /sim11/{id} {
      allow read: if mapWithKey(1)['1'] == 'v';
    }
    match /sim12a/{id} {
      allow read: if !exists('/databases/(default)/documents/u/1');
    }
    match /sim12b/{id} {
      allow read: if !exists(/databases/$(database)/documents/u);
    }
  }
}`,
  cases: [
    {
      description: 'FS-SIM-2a: string minus string DENIED with no such overload',
      expectation: 'DENY',
      method: 'get',
      path: 'sim2a/1',
    },
    {
      description: 'FS-SIM-2b: unary minus on string DENIED with no such overload',
      expectation: 'DENY',
      method: 'get',
      path: 'sim2b/1',
    },
    {
      description: 'FS-SIM-4a: user-defined int(x) shadows global int cast ALLOWED',
      expectation: 'ALLOW',
      method: 'get',
      path: 'sim4a/1',
    },
    {
      description: 'FS-SIM-4b: user function called with wrong arity DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim4b/1',
    },
    {
      description: 'FS-SIM-5a: string.replace escaped dollar literal ALLOWED',
      expectation: 'ALLOW',
      method: 'get',
      path: 'sim5a/1',
    },
    {
      description: 'FS-SIM-5b: string.lower(1) extra argument DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim5b/1',
    },
    {
      description: 'FS-SIM-6a: list.toSet(arg) extra argument DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim6a/1',
    },
    {
      description: 'FS-SIM-6b: map.get with 3 arguments DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim6b/1',
    },
    {
      description: 'FS-SIM-6c: map.diff with 2 arguments DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim6c/1',
    },
    {
      description: 'FS-SIM-6d: map.diff with non-map argument DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim6d/1',
    },
    {
      description: 'FS-SIM-9a: request has no resource key on get ALLOWED',
      expectation: 'ALLOW',
      method: 'get',
      path: 'sim9a/1',
    },
    {
      description: 'FS-SIM-9b: request.resource.data on delete with test payload ALLOWED',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'sim9b/1',
      data: { x: 1 },
    },
    {
      description: 'FS-SIM-9c: request.resource.data on delete without test payload DENIED',
      expectation: 'DENY',
      method: 'delete',
      path: 'sim9c/1',
      resource: { x: 1 },
    },
    {
      description: 'FS-SIM-10a: timestamp.date month 13 out of bounds DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim10a/1',
    },
    {
      description: 'FS-SIM-10b: timestamp.date Feb 30 out of bounds DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim10b/1',
    },
    {
      description: 'FS-SIM-11: map literal with integer key expression DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim11/1',
    },
    {
      description: 'FS-SIM-12a: exists() with string argument instead of Path DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim12a/1',
    },
    {
      description: 'FS-SIM-12b: exists() with odd-segment collection path DENIED',
      expectation: 'DENY',
      method: 'get',
      path: 'sim12b/1',
    },
  ],
  group: 'fix-class',
};
