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
    // Property and index access on values that are not maps: a list, a
    // string, a path, a duration, and size read as a field of a map.
    // Dot length on a list.
    match /paListLengthEq/{fileId} { allow read: if fileId.split('-').length == 4; }
    match /paListLengthNe/{fileId} { allow read: if fileId.split('-').length != 99; }
    match /paListLengthNot/{fileId} { allow read: if !(fileId.split('-').length == 4); }
    match /paListLengthOrTrue/{fileId} { allow read: if fileId.split('-').length == 4 || true; }
    // Dot size without a call on a list.
    match /paListSizeFieldEq/{fileId} { allow read: if fileId.split('-').size == 4; }
    match /paListSizeFieldNe/{fileId} { allow read: if fileId.split('-').size != 99; }
    match /paListSizeFieldNot/{fileId} { allow read: if !(fileId.split('-').size == 4); }
    match /paListSizeFieldOrTrue/{fileId} { allow read: if fileId.split('-').size == 4 || true; }
    // Int index on a string.
    match /paStrIndexEq/{fileId} { allow read: if 'abc'[0] == 'a'; }
    match /paStrIndexNe/{fileId} { allow read: if 'abc'[0] != 'zz'; }
    match /paStrIndexNot/{fileId} { allow read: if !('abc'[0] == 'a'); }
    match /paStrIndexOrTrue/{fileId} { allow read: if 'abc'[0] == 'a' || true; }
    // String key on a string.
    match /paStrLengthKeyEq/{fileId} { allow read: if 'abc'['length'] == 3; }
    match /paStrLengthKeyNe/{fileId} { allow read: if 'abc'['length'] != 99; }
    match /paStrLengthKeyNot/{fileId} { allow read: if !('abc'['length'] == 3); }
    match /paStrLengthKeyOrTrue/{fileId} { allow read: if 'abc'['length'] == 3 || true; }
    // Dot length on a string.
    match /paStrLengthEq/{fileId} { allow read: if fileId.length == 7; }
    match /paStrLengthNe/{fileId} { allow read: if fileId.length != 99; }
    match /paStrLengthNot/{fileId} { allow read: if !(fileId.length == 7); }
    match /paStrLengthOrTrue/{fileId} { allow read: if fileId.length == 7 || true; }
    // Int index on a path.
    match /paPathIndexEq/{fileId} { allow read: if request.path[0] == 'b'; }
    match /paPathIndexNe/{fileId} { allow read: if request.path[0] != 'zz'; }
    match /paPathIndexNot/{fileId} { allow read: if !(request.path[0] == 'b'); }
    match /paPathIndexOrTrue/{fileId} { allow read: if request.path[0] == 'b' || true; }
    // Unbound string key on a path.
    match /paPathSegmentsKeyEq/{fileId} { allow read: if request.path['segments'] == null; }
    match /paPathSegmentsKeyNe/{fileId} { allow read: if request.path['segments'] != 'zz'; }
    match /paPathSegmentsKeyNot/{fileId} { allow read: if !(request.path['segments'] == null); }
    match /paPathSegmentsKeyOrTrue/{fileId} { allow read: if request.path['segments'] == null || true; }
    // Unbound name read by dot access on a path.
    match /paPathSegmentsDotEq/{fileId} { allow read: if request.path.segments == null; }
    match /paPathSegmentsDotNe/{fileId} { allow read: if request.path.segments != 'zz'; }
    match /paPathSegmentsDotNot/{fileId} { allow read: if !(request.path.segments == null); }
    match /paPathSegmentsDotOrTrue/{fileId} { allow read: if request.path.segments == null || true; }
    // Int index on a timestamp.
    match /paTimestampIndexEq/{fileId} { allow read: if timestamp.value(0)[0] == null; }
    match /paTimestampIndexNe/{fileId} { allow read: if timestamp.value(0)[0] != 'zz'; }
    match /paTimestampIndexNot/{fileId} { allow read: if !(timestamp.value(0)[0] == null); }
    match /paTimestampIndexOrTrue/{fileId} { allow read: if timestamp.value(0)[0] == null || true; }
    // Int index on a latlng.
    match /paLatLngIndexEq/{fileId} { allow read: if latlng.value(1.0, 2.0)[0] == null; }
    match /paLatLngIndexNe/{fileId} { allow read: if latlng.value(1.0, 2.0)[0] != 'zz'; }
    match /paLatLngIndexNot/{fileId} { allow read: if !(latlng.value(1.0, 2.0)[0] == null); }
    match /paLatLngIndexOrTrue/{fileId} { allow read: if latlng.value(1.0, 2.0)[0] == null || true; }
    // Int index on a duration.
    match /paDurationIndexEq/{fileId} { allow read: if duration.value(1, 'h')[0] == null; }
    match /paDurationIndexNe/{fileId} { allow read: if duration.value(1, 'h')[0] != 'zz'; }
    match /paDurationIndexNot/{fileId} { allow read: if !(duration.value(1, 'h')[0] == null); }
    match /paDurationIndexOrTrue/{fileId} { allow read: if duration.value(1, 'h')[0] == null || true; }
    // Dot size without a call on a map.
    match /paMapSizeFieldEq/{fileId} { allow read: if {'a': 1}.size == 1; }
    match /paMapSizeFieldNe/{fileId} { allow read: if {'a': 1}.size != 99; }
    match /paMapSizeFieldNot/{fileId} { allow read: if !({'a': 1}.size == 1); }
    match /paMapSizeFieldOrTrue/{fileId} { allow read: if {'a': 1}.size == 1 || true; }
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
    ...([
      ['fileId.split(\'-\').length == 4 (dot length on a list) → DENY', 'DENY', 'paListLengthEq/a-b-c-d'],
      ['fileId.split(\'-\').length != 99 (dot length on a list) → DENY', 'DENY', 'paListLengthNe/a-b-c-d'],
      ['!(fileId.split(\'-\').length == 4) (dot length on a list) → DENY', 'DENY', 'paListLengthNot/a-b-c-d'],
      ['fileId.split(\'-\').length == 4 || true (dot length on a list) → ALLOW', 'ALLOW', 'paListLengthOrTrue/a-b-c-d'],
      ['fileId.split(\'-\').size == 4 (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldEq/a-b-c-d'],
      ['fileId.split(\'-\').size != 99 (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldNe/a-b-c-d'],
      ['!(fileId.split(\'-\').size == 4) (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldNot/a-b-c-d'],
      ['fileId.split(\'-\').size == 4 || true (dot size without a call on a list) → ALLOW', 'ALLOW', 'paListSizeFieldOrTrue/a-b-c-d'],
      ['\'abc\'[0] == \'a\' (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexEq/a-b-c-d'],
      ['\'abc\'[0] != \'zz\' (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexNe/a-b-c-d'],
      ['!(\'abc\'[0] == \'a\') (int index on a string) → DENY', 'DENY', 'paStrIndexNot/a-b-c-d'],
      ['\'abc\'[0] == \'a\' || true (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexOrTrue/a-b-c-d'],
      ['\'abc\'[\'length\'] == 3 (string key on a string) → DENY', 'DENY', 'paStrLengthKeyEq/a-b-c-d'],
      ['\'abc\'[\'length\'] != 99 (string key on a string) → DENY', 'DENY', 'paStrLengthKeyNe/a-b-c-d'],
      ['!(\'abc\'[\'length\'] == 3) (string key on a string) → DENY', 'DENY', 'paStrLengthKeyNot/a-b-c-d'],
      ['\'abc\'[\'length\'] == 3 || true (string key on a string) → ALLOW', 'ALLOW', 'paStrLengthKeyOrTrue/a-b-c-d'],
      ['fileId.length == 7 (dot length on a string) → DENY', 'DENY', 'paStrLengthEq/a-b-c-d'],
      ['fileId.length != 99 (dot length on a string) → DENY', 'DENY', 'paStrLengthNe/a-b-c-d'],
      ['!(fileId.length == 7) (dot length on a string) → DENY', 'DENY', 'paStrLengthNot/a-b-c-d'],
      ['fileId.length == 7 || true (dot length on a string) → ALLOW', 'ALLOW', 'paStrLengthOrTrue/a-b-c-d'],
      ['request.path[0] == \'b\' (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexEq/a-b-c-d'],
      ['request.path[0] != \'zz\' (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexNe/a-b-c-d'],
      ['!(request.path[0] == \'b\') (int index on a path) → DENY', 'DENY', 'paPathIndexNot/a-b-c-d'],
      ['request.path[0] == \'b\' || true (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexOrTrue/a-b-c-d'],
      ['request.path[\'segments\'] == null (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyEq/a-b-c-d'],
      ['request.path[\'segments\'] != \'zz\' (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyNe/a-b-c-d'],
      ['!(request.path[\'segments\'] == null) (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyNot/a-b-c-d'],
      ['request.path[\'segments\'] == null || true (unbound string key on a path) → ALLOW', 'ALLOW', 'paPathSegmentsKeyOrTrue/a-b-c-d'],
      ['request.path.segments == null (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotEq/a-b-c-d'],
      ['request.path.segments != \'zz\' (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotNe/a-b-c-d'],
      ['!(request.path.segments == null) (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotNot/a-b-c-d'],
      ['request.path.segments == null || true (unbound name by dot access on a path) → ALLOW', 'ALLOW', 'paPathSegmentsDotOrTrue/a-b-c-d'],
      ['timestamp.value(0)[0] == null (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexEq/a-b-c-d'],
      ['timestamp.value(0)[0] != \'zz\' (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexNe/a-b-c-d'],
      ['!(timestamp.value(0)[0] == null) (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexNot/a-b-c-d'],
      ['timestamp.value(0)[0] == null || true (int index on a timestamp) → ALLOW', 'ALLOW', 'paTimestampIndexOrTrue/a-b-c-d'],
      ['latlng.value(1.0, 2.0)[0] == null (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexEq/a-b-c-d'],
      ['latlng.value(1.0, 2.0)[0] != \'zz\' (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexNe/a-b-c-d'],
      ['!(latlng.value(1.0, 2.0)[0] == null) (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexNot/a-b-c-d'],
      ['latlng.value(1.0, 2.0)[0] == null || true (int index on a latlng) → ALLOW', 'ALLOW', 'paLatLngIndexOrTrue/a-b-c-d'],
      ['duration.value(1, \'h\')[0] == null (int index on a duration) → DENY', 'DENY', 'paDurationIndexEq/a-b-c-d'],
      ['duration.value(1, \'h\')[0] != \'zz\' (int index on a duration) → DENY', 'DENY', 'paDurationIndexNe/a-b-c-d'],
      ['!(duration.value(1, \'h\')[0] == null) (int index on a duration) → DENY', 'DENY', 'paDurationIndexNot/a-b-c-d'],
      ['duration.value(1, \'h\')[0] == null || true (int index on a duration) → ALLOW', 'ALLOW', 'paDurationIndexOrTrue/a-b-c-d'],
      ['{\'a\': 1}.size == 1 (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldEq/a-b-c-d'],
      ['{\'a\': 1}.size != 99 (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldNe/a-b-c-d'],
      ['!({\'a\': 1}.size == 1) (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldNot/a-b-c-d'],
      ['{\'a\': 1}.size == 1 || true (dot size without a call on a map) → ALLOW', 'ALLOW', 'paMapSizeFieldOrTrue/a-b-c-d'],
    ] as const).map(([description, expectation, path]) => ({
      description, expectation, method: 'get' as const, path,
      auth: { uid: 'alice' }, existingResource: { size: 100 },
    })),
  ],
};
