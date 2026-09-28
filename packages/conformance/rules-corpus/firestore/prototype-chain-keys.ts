/**
 * ─── Scenario 5: prototype-chain-keys (RULES-B7) ──────────────────────────────
 * Production maps expose OWN keys only — `'toString' in data` is false
 * unless the document literally has a `toString` field, and
 * `data.constructor` is a missing-field error. Pre-fix the simulator's
 * `in` walked the JS prototype chain, so `'toString' in data` allowed and
 * `data.constructor` returned the Object constructor.
 *
 * The negated membership cases separate an error from false: `in` over null
 * is `Null value error.`, `in` over a string, int, float or bool is
 * `Function not found error: Name: [in].`, and a non-string key into a map is
 * `Unsupported operation error. Received: map.in(int). Expected:
 * map.in(string).`. Each error denies, so its negation denies too. `in` over
 * a timestamp, a path or a map diff is the same function not found error, and
 * `in` over a set tests its elements, never its object fields.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B7',
  rationale: "`'toString' in map` must be false (own keys only) and `.constructor` access must error; JS prototype-chain leakage said true / returned Object.",
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // proto method name is NOT a key → false → DENY
    match /protoInDeny/{id} {
      allow create: if 'toString' in request.resource.data;
    }
    // negated form → ALLOW
    match /protoNotInAllow/{id} {
      allow create: if !('toString' in request.resource.data)
        && !('constructor' in request.resource.data)
        && !('hasOwnProperty' in request.resource.data);
    }
    // a REAL field named toString IS a key → ALLOW
    match /realKeyInAllow/{id} {
      allow create: if 'toString' in request.resource.data
        && request.resource.data.toString == 'present';
    }
    // .constructor access on a map without that field → error → DENY
    match /constructorAccessDeny/{id} {
      allow create: if request.resource.data.constructor != null;
    }
    // keys() reflects own keys only → ALLOW
    match /keysOwnOnlyAllow/{id} {
      allow create: if !request.resource.data.keys().hasAny(['toString', 'constructor'])
        && request.resource.data.keys().hasOnly(['name']);
    }
    // negated membership over a value that is not a collection → error → DENY
    match /notInNull/{id} {
      allow create: if !('a' in request.resource.data.v);
    }
    match /notInString/{id} {
      allow create: if !('a' in request.resource.data.v);
    }
    match /notInInt/{id} {
      allow create: if !('a' in request.resource.data.v);
    }
    match /notInFloat/{id} {
      allow create: if !('a' in request.resource.data.v);
    }
    match /notInBool/{id} {
      allow create: if !('a' in request.resource.data.v);
    }
    // negated int key into a map → error → DENY
    match /intKeyNotInMap/{id} {
      allow create: if !(1 in request.resource.data.v);
    }
    // set membership tests elements, never object fields
    match /inSet/{id} {
      allow create: if 'a' in request.resource.data.v.toSet();
    }
    match /fieldNameNotInSet/{id} {
      allow create: if !('items' in request.resource.data.v.toSet());
    }
    // negated membership over a timestamp, a path or a map diff
    match /notInTimestamp/{id} {
      allow create: if !('a' in request.time);
    }
    match /notInPath/{id} {
      allow create: if !('a' in request.path);
    }
    match /notInMapDiff/{id} {
      allow create: if !('a' in request.resource.data.diff({}));
    }
  }
}`,
  cases: [
    {
      description: "'toString' in data (no such field) → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'protoInDeny/d1',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'no proto names leak into `in` → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'protoNotInAllow/d2',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: "literal field named 'toString' IS a key → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'realKeyInAllow/d3',
      auth: { uid: 'alice' },
      data: { toString: 'present' },
    },
    {
      description: '.constructor access (no such field) → DENY (error)',
      expectation: 'DENY',
      method: 'create',
      path: 'constructorAccessDeny/d4',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'keys() lists own keys only → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'keysOwnOnlyAllow/d5',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    ...([
      ["!('a' in null) is a null value error → DENY", 'notInNull', null],
      ["!('a' in 'abc') is a function not found error → DENY", 'notInString', 'abc'],
      ["!('a' in 5) is a function not found error → DENY", 'notInInt', 5],
      ["!('a' in 1.5) is a function not found error → DENY", 'notInFloat', 1.5],
      ["!('a' in true) is a function not found error → DENY", 'notInBool', true],
      ["!(1 in {'a': 1}) is an unsupported operation error → DENY", 'intKeyNotInMap', { a: 1 }],
    ] as const).map(([description, match, v], i) => ({
      description, expectation: 'DENY' as const, method: 'create' as const,
      path: `${match}/d${6 + i}`, auth: { uid: 'alice' },
      data: { v },
    })),
    ...([
      ["'a' in a set of ['a', 'b'] → ALLOW", 'ALLOW', 'inSet', ['a', 'b']],
      ["!('items' in a set of ['a', 'b']) → ALLOW", 'ALLOW', 'fieldNameNotInSet', ['a', 'b']],
      ["!('a' in request.time) is an error → DENY", 'DENY', 'notInTimestamp', 1],
      ["!('a' in request.path) is an error → DENY", 'DENY', 'notInPath', 1],
      ["!('a' in a map diff) is an error → DENY", 'DENY', 'notInMapDiff', 1],
    ] as const).map(([description, expectation, match, v], i) => ({
      description, expectation, method: 'create' as const,
      path: `${match}/d${12 + i}`, auth: { uid: 'alice' },
      data: { v },
      requestTime: '2025-06-15T00:00:00Z',
    })),
  ],
  group: 'fix-class',
};
