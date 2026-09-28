/**
 * ─── Scenario: list-map-literals-and-slice ───────────────────────────────────
 * List/map literals and range-slice access `[i:j]` — newly evaluable in
 * storage rules (PR #333 / #150). Mirrors the slice truth the Firestore
 * engine already pinned (rules-firestore-range-slice-list-and-string):
 * mid-slices on lists AND strings work, but an out-of-bounds slice END
 * ERRORS (→ DENY) — it does NOT clamp to length the way JS `.slice()` does.
 *
 * The bounds cases repeat the Firestore bounds shapes: `start` must be an
 * index, `end - 1` must be an index (so `[0:0]`, `[n:n]` and any slice of an
 * empty value are errors), and `start` must not exceed `end`.
 *
 * The `equality-*` matches pin `==` over ints and floats inside List and Map
 * literals.
 */
import type { StorageScenarioRecord } from './types.ts';

/** One `==` case over numbers inside Lists and Maps: description, condition, production verdict. */
type EqualityIdentityCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

/**
 * `==` compares an int and a float by value, but a List or Map literal equals
 * another only when each element or value has the same numeric type: `1 ==
 * 1.0` holds while `[1] == [1.0]` and `{'a': 1} == {'a': 1.0}` are false.
 * Inside a List or Map, `0.0` and `-0.0` differ and NaN equals nothing.
 */
const EQUALITY_IDENTITY_CASES: readonly EqualityIdentityCase[] = [
  ['an int equals a float of the same value', '1 == 1.0', 'ALLOW'],
  ['a List of an int does not equal a List of a float', '[1] == [1.0]', 'DENY'],
  ['!= between a List of an int and a List of a float is true', '[1] != [1.0]', 'ALLOW'],
  ['a List of a float does not equal a List of an int', '[1.0] == [1]', 'DENY'],
  ['one float element makes Lists unequal', '[1, 2] == [1, 2.0]', 'DENY'],
  ['nested Lists compare element types', '[[1]] == [[1.0]]', 'DENY'],
  ['a Map of an int does not equal a Map of a float', "{'a': 1} == {'a': 1.0}", 'DENY'],
  ['!= between a Map of an int and a Map of a float is true', "{'a': 1} != {'a': 1.0}", 'ALLOW'],
  ['a Map value List compares element types', "{'a': [1]} == {'a': [1.0]}", 'DENY'],
  ['an element read from a List equals a float of the same value', '[1][0] == 1.0', 'ALLOW'],
  ['a value read from a Map equals a float of the same value', "{'a': 1}.a == 1.0", 'ALLOW'],
  ['Lists of equal floats are equal', '[1.0] == [1.0]', 'ALLOW'],
  ['Maps of equal floats are equal', "{'a': 1.0} == {'a': 1.0}", 'ALLOW'],
  ['an int zero equals a negative float zero', '0 == -0.0', 'ALLOW'],
  ['a List of 0.0 does not equal a List of -0.0', '[0.0] == [-0.0]', 'DENY'],
  ['Lists of -0.0 are equal', '[-0.0] == [-0.0]', 'ALLOW'],
  ['a Map of -0.0 does not equal a Map of 0.0', "{'a': -0.0} == {'a': 0.0}", 'DENY'],
  ['NaN does not equal NaN', "float('NaN') == float('NaN')", 'DENY'],
  ['a List of NaN does not equal a List of NaN', "[float('NaN')] == [float('NaN')]", 'DENY'],
];

const equalityIdentityMatches = EQUALITY_IDENTITY_CASES.map(([, condition], index) =>
  `    match /equality-${index}/{fileId} { allow read: if ${condition}; }`).join('\n');

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: list/map literals, slice [i:j], OOB slice errors',
  rationale:
    'Slices on split() lists and on strings must evaluate, list literals must compare by value, and an out-of-bounds slice end must error → deny (production does not clamp).',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /slices/{fileId} {
      // the PR-333 motivating shape: prefix segments of a hyphenated name
      allow read: if fileId.split('-')[0:2].size() == 2;
      // list literal equality against a slice
      allow create: if fileId.split('-')[0:2] == ['a', 'b'];
      // slice end past length ERRORS in production (no JS-style clamp) → DENY
      allow update: if fileId.split('-')[0:9].size() >= 0;
      // string slice: substring semantics
      allow delete: if 'abcdef'[1:4] == 'bcd';
    }
    // Bounds on a 4-element list (fileId 'a-b-c-d') and a 5-character
    // string (fileId 'hello').
    match /listZeroZero/{fileId} { allow read: if fileId.split('-')[0:0].size() == 0; }
    match /listLenLen/{fileId} { allow read: if fileId.split('-')[4:4].size() == 0; }
    match /listLastEmpty/{fileId} { allow read: if fileId.split('-')[3:3].size() == 0; }
    match /listLastElement/{fileId} { allow read: if fileId.split('-')[3:4] == ['d']; }
    match /listEndBeforeFirst/{fileId} { allow read: if fileId.split('-')[1:0].size() == 0; }
    match /listStartAfterEnd/{fileId} { allow read: if fileId.split('-')[3:1].size() == 0; }
    match /listEmptyZeroZero/{fileId} { allow read: if [][0:0] == []; }
    match /strZeroZero/{fileId} { allow read: if fileId[0:0] == ''; }
    match /strOneOne/{fileId} { allow read: if fileId[1:1] == ''; }
    match /strLastEmpty/{fileId} { allow read: if fileId[4:4] == ''; }
    match /strLenLen/{fileId} { allow read: if fileId[5:5] == ''; }
    match /strStartAfterEnd/{fileId} { allow read: if fileId[2:1] == ''; }
    match /strEmptyZeroZero/{fileId} { allow read: if ''[0:0] == ''; }
    // List index access on a 4-element list (fileId 'a-b-c-d').
    match /listIndexInRange/{fileId} { allow read: if fileId.split('-')[1] == 'b'; }
    match /listIndexPastEnd/{fileId} { allow read: if fileId.split('-')[5] == null; }
    match /listIndexNegative/{fileId} { allow read: if fileId.split('-')[-1] == 'd'; }
    match /listIndexStringKey/{fileId} { allow read: if fileId.split('-')['length'] == 4; }
    // == over ints and floats inside List and Map literals
${equalityIdentityMatches}
  }
}`,
  cases: [
    {
      description: 'list mid-slice of split() → size 2 → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'slices/a-b-c.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: 'slice end beyond split() length errors → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'slices/one.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: 'slice == list literal → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'slices/a-b-c.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
    },
    {
      description: 'slice == list literal (different segments) → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'slices/x-y-z.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
    },
    {
      description: 'OOB slice end [0:9] errors, does not clamp → DENY',
      expectation: 'DENY',
      method: 'update',
      path: 'slices/a-b-c.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
      existingResource: { size: 100 },
    },
    {
      description: 'string slice [1:4] is substring → ALLOW',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'slices/a-b-c.png',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    ...([
      ['list slice [0:0] is an index error → DENY', 'DENY', 'listZeroZero/a-b-c-d'],
      ['list slice [n:n] is an index error → DENY', 'DENY', 'listLenLen/a-b-c-d'],
      ['list slice [n-1:n-1] → empty → ALLOW', 'ALLOW', 'listLastEmpty/a-b-c-d'],
      ['list slice [n-1:n] → last element → ALLOW', 'ALLOW', 'listLastElement/a-b-c-d'],
      ['list slice [1:0] is an index error → DENY', 'DENY', 'listEndBeforeFirst/a-b-c-d'],
      ['list slice start after end is a range error → DENY', 'DENY', 'listStartAfterEnd/a-b-c-d'],
      ['empty list slice [0:0] is an index error → DENY', 'DENY', 'listEmptyZeroZero/a-b-c-d'],
      ['string slice [0:0] is an index error → DENY', 'DENY', 'strZeroZero/hello'],
      ['string slice [1:1] → empty string → ALLOW', 'ALLOW', 'strOneOne/hello'],
      ['string slice [n-1:n-1] → empty string → ALLOW', 'ALLOW', 'strLastEmpty/hello'],
      ['string slice [n:n] is an index error → DENY', 'DENY', 'strLenLen/hello'],
      ['string slice start after end is a range error → DENY', 'DENY', 'strStartAfterEnd/hello'],
      ['empty string slice [0:0] is an index error → DENY', 'DENY', 'strEmptyZeroZero/hello'],
      ['list index in range → ALLOW', 'ALLOW', 'listIndexInRange/a-b-c-d'],
      ['list index past the end is an index error → DENY', 'DENY', 'listIndexPastEnd/a-b-c-d'],
      ['negative list index is an index error → DENY', 'DENY', 'listIndexNegative/a-b-c-d'],
      ['string key on a list is an error → DENY', 'DENY', 'listIndexStringKey/a-b-c-d'],
    ] as const).map(([description, expectation, path]) => ({
      description, expectation, method: 'get' as const, path,
      auth: { uid: 'alice' }, existingResource: { size: 100 },
    })),
    ...EQUALITY_IDENTITY_CASES.map(([description, , expectation], index) => ({
      description: `equality: ${description}`,
      expectation,
      method: 'get' as const,
      path: `equality-${index}/a.png`,
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    })),
  ],
};
