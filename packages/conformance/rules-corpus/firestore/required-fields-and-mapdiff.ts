/**
 * ─── Scenario: required-fields-and-mapdiff ────────────────────────────────────
 * The everyday required-fields validation idiom, verified against production:
 * `request.resource.data.keys().hasAll([...])` / `.hasOnly([...])` on create,
 * and the `request.resource.data.diff(resource.data)` MapDiff family on update
 * (addedKeys / removedKeys / changedKeys / affectedKeys / unchangedKeys) to
 * constrain which fields a mutation may touch. An owner-scoped `articles`
 * collection: create requires the exact field set and self-ownership; update may
 * only change `title`/`body` and must leave `ownerId` intact.
 *
 * The `keys*` matches show `keys()` returns a List: `is list` holds, `is set`
 * is false, and `toSet()`, `hasAll()`, `hasAny()`, `hasOnly()`, `size()`,
 * `[0]` and `join()` evaluate on it.
 *
 * The `diff*` matches compare the MapDiff `affectedKeys()` Set with a key
 * set: `==` against a Set and against a List, and `hasAll()` with
 * `hasOnly()` against a List and a Set.
 *
 * The `keyOrder` matches pin the order `keys()` and `values()` return and
 * how `diff()` compares ints, floats, zeros and NaN.
 */
import type { ScenarioRecord } from './types.ts';

/** One keys() or diff() case: description, allow condition, production verdict. */
type KeyOrderCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

/**
 * `keys()` lists a Map's keys in ascending Unicode code point order, whatever
 * order the literal or the request data wrote them in: digits before upper
 * case before `_` before lower case, `'10'` before `'9'`, and `'ｚ'`
 * (U+FF5A) before `'😀'` (U+1F600), where UTF-16 code unit order would put
 * the emoji first. `values()` keeps the order the Map literal wrote. `diff()`
 * compares values by numeric value at every depth: an int and the equal
 * float, `0.0` and `-0.0`, and two NaN are unchanged. The request data is
 * `{b, a, n}` in that order.
 */
const keyOrderCases: readonly KeyOrderCase[] = [
  ["keys() of a literal is sorted", "{'b': 1, 'a': 2}.keys() == ['a', 'b']", 'ALLOW'],
  ["keys() of a literal is not in written order", "{'b': 1, 'a': 2}.keys() == ['b', 'a']", 'DENY'],
  ["keys() != the sorted List is false", "{'b': 1, 'a': 2}.keys() != ['a', 'b']", 'DENY'],
  ["keys()[0] is the least key", "{'b': 1, 'a': 2}.keys()[0] == 'a'", 'ALLOW'],
  ["keys().join() joins the sorted keys", "{'b': 1, 'a': 2}.keys().join(',') == 'a,b'", 'ALLOW'],
  [
    "keys() orders digits, upper case, underscore and lower case by code point",
    "{'b': 1, 'B': 2, 'a': 3, 'A': 4, '10': 5, '2': 6, '1': 7, '_': 8, 'z': 9}.keys() == ['1', '10', '2', 'A', 'B', '_', 'a', 'b', 'z']",
    'ALLOW',
  ],
  [
    "keys() does not order numeric keys by value",
    "{'b': 1, 'B': 2, 'a': 3, 'A': 4, '10': 5, '2': 6, '1': 7, '_': 8, 'z': 9}.keys() == ['1', '2', '10', 'A', 'B', '_', 'a', 'b', 'z']",
    'DENY',
  ],
  ["keys() puts '10' before '9'", "{'b': 1, '10': 2, '9': 3}.keys() == ['10', '9', 'b']", 'ALLOW'],
  ["keys() orders non-ASCII keys by code point", "{'é': 1, 'z': 2, 'ｚ': 3, '😀': 4, 'e': 5}.keys() == ['e', 'z', 'é', 'ｚ', '😀']", 'ALLOW'],
  ["keys() does not order by UTF-16 code unit", "{'é': 1, 'z': 2, 'ｚ': 3, '😀': 4, 'e': 5}.keys() == ['e', 'z', 'é', '😀', 'ｚ']", 'DENY'],
  ["keys() puts a prefix before its extensions", "{'ab': 1, 'a': 2, 'a b': 3, '': 4}.keys() == ['', 'a', 'a b', 'ab']", 'ALLOW'],
  ["keys() of request data is sorted", "request.resource.data.keys() == ['a', 'b', 'n']", 'ALLOW'],
  ["keys()[0] of request data is the least key", "request.resource.data.keys()[0] == 'a'", 'ALLOW'],
  ["values() keeps the written order", "{'c': 3, 'a': 1, 'b': 2}.values() == [3, 1, 2]", 'ALLOW'],
  ["values() is not in key order", "{'c': 3, 'a': 1, 'b': 2}.values() == [1, 2, 3]", 'DENY'],
  ["diff() of an int and the equal float is unchanged", "{'a': 1}.diff({'a': 1.0}).affectedKeys().size() == 0", 'ALLOW'],
  ["diff() of an int and the equal float lists the key as unchanged", "{'x': 1}.diff({'x': 1.0}).unchangedKeys().size() == 1", 'ALLOW'],
  ["diff() of an int List and the equal float List is unchanged", "{'x': [1]}.diff({'x': [1.0]}).changedKeys().size() == 0", 'ALLOW'],
  ["diff() of 0.0 and -0.0 is unchanged", "{'x': 0.0}.diff({'x': -0.0}).changedKeys().size() == 0", 'ALLOW'],
  ["diff() of NaN and NaN is unchanged", "{'x': float('NaN')}.diff({'x': float('NaN')}).changedKeys().size() == 0", 'ALLOW'],
  ["diff() of an int and a different float is changed", "{'x': 1}.diff({'x': 2.0}).changedKeys().size() == 1", 'ALLOW'],
];

const keyOrderBlocks = keyOrderCases
  .map(([, condition], index) => `    match /keyOrder/${index}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Coverage: List/Set + MapDiff required-fields idiom',
  rationale:
    'Production must accept the keys().hasAll/hasOnly required-fields pattern and the diff().*Keys() MapDiff family used to gate field-level mutations.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /articles/{articleId} {
      // create: exact required field set, self-owned
      allow create: if request.auth != null
        && request.resource.data.keys().hasAll(['title', 'body', 'ownerId', 'tags'])
        && request.resource.data.keys().hasOnly(['title', 'body', 'ownerId', 'tags'])
        && request.resource.data.ownerId == request.auth.uid;
      // update: only title/body may change; ownerId immutable, no add/remove
      allow update: if request.auth != null
        && resource.data.ownerId == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['title', 'body'])
        && request.resource.data.diff(resource.data).changedKeys().hasAny(['title', 'body'])
        && request.resource.data.diff(resource.data).addedKeys().size() == 0
        && request.resource.data.diff(resource.data).removedKeys().size() == 0
        && request.resource.data.diff(resource.data).unchangedKeys().hasAll(['ownerId']);
    }
    // keys() returns a List: each List method and type test on it
    match /keysToSet/{id} {
      allow create: if request.resource.data.keys().toSet() == ['a', 'b'].toSet();
    }
    match /keysHasAll/{id} {
      allow create: if request.resource.data.keys().hasAll(['a', 'b']);
    }
    match /keysSize/{id} {
      allow create: if request.resource.data.keys().size() == 2;
    }
    match /keysIndex/{id} {
      allow create: if request.resource.data.keys()[0] == 'a';
    }
    match /keysJoin/{id} {
      allow create: if request.resource.data.keys().join(',') == 'a';
    }
    match /keysHasAny/{id} {
      allow create: if request.resource.data.keys().hasAny(['a', 'z']);
    }
    match /keysHasOnly/{id} {
      allow create: if request.resource.data.keys().hasOnly(['a', 'b', 'c']);
    }
    match /keysIsList/{id} {
      allow create: if request.resource.data.keys() is list;
    }
    match /keysIsSet/{id} {
      allow create: if request.resource.data.keys() is set;
    }
    match /keysIsNotSet/{id} {
      allow create: if !(request.resource.data.keys() is set);
    }
    match /keysToSetSize/{id} {
      allow create: if request.resource.data.keys().toSet().size() == 2;
    }
    // Set equality on the MapDiff affectedKeys() Set: == against a Set or a
    // List, and hasAll() with hasOnly() against a List or a Set
    match /diffEqSet/{id} {
      allow update: if request.resource.data.diff(resource.data).affectedKeys() == ['b', 'a'].toSet();
    }
    match /diffEqList/{id} {
      allow update: if request.resource.data.diff(resource.data).affectedKeys() == ['a', 'b'];
    }
    match /diffBothWaysList/{id} {
      allow update: if request.resource.data.diff(resource.data).affectedKeys().hasAll(['b', 'a'])
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['b', 'a']);
    }
    match /diffBothWaysSet/{id} {
      allow update: if request.resource.data.diff(resource.data).affectedKeys().hasAll(['b', 'a'].toSet())
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['b', 'a'].toSet());
    }
${keyOrderBlocks}
  }
}`,
  cases: [
    {
      description: 'create with exact required fields, self-owned ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'articles/a1',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'create missing a required field DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a2',
      auth: { uid: 'alice' },
      data: { title: 'Hello', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'create with an extra field DENY (hasOnly)',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a3',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'alice', tags: ['x'], extra: 1 },
    },
    {
      description: 'create where ownerId != caller DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'articles/a4',
      auth: { uid: 'alice' },
      data: { title: 'Hello', body: 'World', ownerId: 'bob', tags: ['x'] },
    },
    {
      description: 'update changing only title ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'articles/a5',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'alice', tags: ['x'] },
    },
    {
      description: 'update touching ownerId DENY (affectedKeys hasOnly)',
      expectation: 'DENY',
      method: 'update',
      path: 'articles/a6',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'bob', tags: ['x'] },
    },
    {
      description: 'update adding a new field DENY (addedKeys size 0)',
      expectation: 'DENY',
      method: 'update',
      path: 'articles/a7',
      auth: { uid: 'alice' },
      resource: { title: 'Old', body: 'Body', ownerId: 'alice', tags: ['x'] },
      data: { title: 'New', body: 'Body', ownerId: 'alice', tags: ['x'], pinned: true },
    },
    ...([
      ['keys().toSet() equals a set of the field names → ALLOW', 'ALLOW', 'keysToSet', { a: 1, b: 2 }],
      ['keys().hasAll() with a List argument → ALLOW', 'ALLOW', 'keysHasAll', { a: 1, b: 2 }],
      ['keys().size() counts the fields → ALLOW', 'ALLOW', 'keysSize', { a: 1, b: 2 }],
      ['keys()[0] is the only field name → ALLOW', 'ALLOW', 'keysIndex', { a: 1 }],
      ["keys().join(',') joins the field names → ALLOW", 'ALLOW', 'keysJoin', { a: 1 }],
      ['keys().hasAny() → ALLOW', 'ALLOW', 'keysHasAny', { a: 1, b: 2 }],
      ['keys().hasOnly() → ALLOW', 'ALLOW', 'keysHasOnly', { a: 1, b: 2 }],
      ['keys() is list → ALLOW', 'ALLOW', 'keysIsList', { a: 1, b: 2 }],
      ['keys() is set is false → DENY', 'DENY', 'keysIsSet', { a: 1, b: 2 }],
      ['!(keys() is set) → ALLOW', 'ALLOW', 'keysIsNotSet', { a: 1, b: 2 }],
      ['keys().toSet().size() → ALLOW', 'ALLOW', 'keysToSetSize', { a: 1, b: 2 }],
    ] as const).map(([description, expectation, match, data], i) => ({
      description, expectation, method: 'create' as const,
      path: `${match}/k${i + 1}`, auth: { uid: 'alice' },
      data,
    })),
    ...([
      ['affectedKeys() == a Set of the same keys in another order → ALLOW', 'ALLOW', 'diffEqSet', { a: 2, b: 2, c: 0 }],
      ['affectedKeys() == a Set missing a changed key → DENY', 'DENY', 'diffEqSet', { a: 2, b: 2, c: 1 }],
      ['affectedKeys() == a Set with a key that did not change → DENY', 'DENY', 'diffEqSet', { a: 2, b: 0, c: 0 }],
      ['affectedKeys() == a List of the same keys is false → DENY', 'DENY', 'diffEqList', { a: 2, b: 2, c: 0 }],
      ['affectedKeys() hasAll() and hasOnly() a List of the same keys → ALLOW', 'ALLOW', 'diffBothWaysList', { a: 2, b: 2, c: 0 }],
      ['affectedKeys() hasAll() and hasOnly() a List, one key unchanged → DENY', 'DENY', 'diffBothWaysList', { a: 2, b: 0, c: 0 }],
      ['affectedKeys() hasAll() and hasOnly() a List, another key changed → DENY', 'DENY', 'diffBothWaysList', { a: 2, b: 2, c: 1 }],
      ['affectedKeys() hasAll() and hasOnly() a Set of the same keys → ALLOW', 'ALLOW', 'diffBothWaysSet', { a: 2, b: 2, c: 0 }],
      ['affectedKeys() hasAll() and hasOnly() a Set, another key changed → DENY', 'DENY', 'diffBothWaysSet', { a: 2, b: 2, c: 1 }],
    ] as const).map(([description, expectation, match, data], i) => ({
      description, expectation, method: 'update' as const,
      path: `${match}/e${i + 1}`, auth: { uid: 'alice' },
      resource: { a: 0, b: 0, c: 0 },
      data,
    })),
    ...keyOrderCases.map(([description, , expectation], index) => ({
      description: `keyOrder: ${description}`,
      expectation,
      method: 'create' as const,
      path: `keyOrder/${index}/d1`,
      auth: { uid: 'alice' },
      data: { b: 'y', a: 'x', n: 1 },
    })),
  ],
  group: 'stress',
};
