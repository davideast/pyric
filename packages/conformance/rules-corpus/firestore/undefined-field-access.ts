/**
 * ─── Scenario 2: undefined-field-access (RULES-B2) ────────────────────────────
 * Production: reading a key that does not exist on a map is a runtime ERROR
 * (→ deny via tri-state), NOT a silent null. Pre-fix the simulator returned
 * null, which INVERTED the commonest rules-debug idiom:
 * `request.resource.data.typo == null` allowed in sim, denies in prod.
 * The correct absence check is the `in` operator.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B2',
  rationale: 'Missing-field access is a runtime error in prod (deny), not null; `typo == null` must DENY and `!(key in map)` is the real absence check.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // The inverted-idiom witness: missing field compared to null → error → DENY
    match /typoEqNullDeny/{id} {
      allow create: if request.resource.data.typo == null;
    }
    // Present-field control → ALLOW
    match /presentEqAllow/{id} {
      allow create: if request.resource.data.name == 'alice';
    }
    // Correct absence check via the "in" operator → ALLOW
    match /notInAllow/{id} {
      allow create: if !('typo' in request.resource.data);
    }
    // Nested missing field under an existing map → error → DENY
    match /nestedTypoDeny/{id} {
      allow create: if request.resource.data.m.typo == 'x';
    }
    // Error propagates through unary ! (no boolean coercion) → DENY
    match /negatedErrorDeny/{id} {
      allow create: if !(request.resource.data.typo == 'x');
    }
    // Missing-field error absorbed by || true (RULES-B3 interplay) → ALLOW
    match /absorbedAllow/{id} {
      allow create: if request.resource.data.typo == 'x' || true;
    }
    // ── Bracket access of a missing key on an existing document's data.
    match /bkEqTrue/{id} {
      allow get: if resource.data['missing'] == true;
    }
    match /bkNeTrue/{id} {
      allow get: if resource.data['missing'] != true;
    }
    match /bkEqNull/{id} {
      allow get: if resource.data['missing'] == null;
    }
    match /bkNotEqTrue/{id} {
      allow get: if !(resource.data['missing'] == true);
    }
    match /bkNotNeTrue/{id} {
      allow get: if !(resource.data['missing'] != true);
    }
    match /bkOrTrue/{id} {
      allow get: if resource.data['missing'] == true || true;
    }
    match /bkTrueOr/{id} {
      allow get: if true || resource.data['missing'] == true;
    }
    match /bkNotAndFalse/{id} {
      allow get: if !(resource.data['missing'] == true && false);
    }
    match /bkIsString/{id} {
      allow get: if resource.data['missing'] is string;
    }
    match /bkNotIsString/{id} {
      allow get: if !(resource.data['missing'] is string);
    }
    match /bkInList/{id} {
      allow get: if resource.data['missing'] in ['a', 'b'];
    }
    match /bkNotInList/{id} {
      allow get: if !(resource.data['missing'] in ['a', 'b']);
    }
    match /bkSize/{id} {
      allow get: if resource.data['missing'].size() == 0;
    }
    match /bkNestedEqNull/{id} {
      allow get: if resource.data['m']['missing'] == null;
    }
    match /bkNestedPresent/{id} {
      allow get: if resource.data['m']['a'] == 1;
    }
    match /bkLetUnused/{id} {
      function letUnused(d) {
        let x = d['missing'];
        return true;
      }
      allow get: if letUnused(resource.data);
    }
    match /bkLetUsed/{id} {
      function letUsed(d) {
        let x = d['missing'];
        return x != true;
      }
      allow get: if letUsed(resource.data);
    }
    match /bkComputedMissing/{id} {
      allow get: if resource.data['miss' + 'ing'] != true;
    }
    match /bkComputedPresent/{id} {
      allow get: if resource.data['na' + 'me'] == 'alice';
    }
    match /bkPathKey/{field} {
      allow get: if resource.data[field] != true;
    }
    match /bkPresent/{id} {
      allow get: if resource.data['name'] == 'alice';
    }
    match /bkPresentNull/{id} {
      allow get: if resource.data['nul'] == null;
    }
    match /bkGuardedIn/{id} {
      allow get: if !('missing' in resource.data) || resource.data['missing'] != true;
    }
    // ── Contrast forms on the same existing document.
    match /dotNeTrue/{id} {
      allow get: if resource.data.missing != true;
    }
    match /getDefaultNull/{id} {
      allow get: if resource.data.get('missing', null) == null;
    }
    // ── Bracket access of a missing key on the incoming payload.
    match /reqBkNeTrue/{id} {
      allow create: if request.resource.data['missing'] != true;
    }
    match /reqBkEqNull/{id} {
      allow create: if request.resource.data['missing'] == null;
    }
    match /reqBkOrTrue/{id} {
      allow create: if request.resource.data['missing'] == null || true;
    }
    // ── List index past the end, and a missing key on the auth token map.
    match /listPastEnd/{id} {
      allow get: if resource.data['l'][5] == null;
    }
    match /listNotPastEnd/{id} {
      allow get: if !(resource.data['l'][5] == 1);
    }
    match /listInRange/{id} {
      allow get: if resource.data['l'][1] == 2;
    }
    match /listNegative/{id} {
      allow get: if resource.data['l'][-1] == 2;
    }
    match /listLengthKey/{id} {
      allow get: if resource.data['l']['length'] == 2;
    }
    match /mapProtoKey/{id} {
      allow get: if resource.data['constructor'] == null;
    }
    match /tokenBkEqNull/{id} {
      allow get: if request.auth.token['missing'] == null;
    }
    // ── Property and index access on values that are not maps: a list, a
    // string, a path, a duration, a timestamp, a latlng, and size read as a
    // field of a map.
    // Dot length on a list.
    match /paListLengthEq/{id} {
      allow get: if resource.data.l.length == 2;
    }
    match /paListLengthNe/{id} {
      allow get: if resource.data.l.length != 99;
    }
    match /paListLengthNot/{id} {
      allow get: if !(resource.data.l.length == 2);
    }
    match /paListLengthOrTrue/{id} {
      allow get: if resource.data.l.length == 2 || true;
    }
    // Dot size without a call on a list.
    match /paListSizeFieldEq/{id} {
      allow get: if resource.data.l.size == 2;
    }
    match /paListSizeFieldNe/{id} {
      allow get: if resource.data.l.size != 99;
    }
    match /paListSizeFieldNot/{id} {
      allow get: if !(resource.data.l.size == 2);
    }
    match /paListSizeFieldOrTrue/{id} {
      allow get: if resource.data.l.size == 2 || true;
    }
    // Int index on a string.
    match /paStrIndexEq/{id} {
      allow get: if 'abc'[0] == 'a';
    }
    match /paStrIndexNe/{id} {
      allow get: if 'abc'[0] != 'zz';
    }
    match /paStrIndexNot/{id} {
      allow get: if !('abc'[0] == 'a');
    }
    match /paStrIndexOrTrue/{id} {
      allow get: if 'abc'[0] == 'a' || true;
    }
    // String key on a string.
    match /paStrLengthKeyEq/{id} {
      allow get: if 'abc'['length'] == 3;
    }
    match /paStrLengthKeyNe/{id} {
      allow get: if 'abc'['length'] != 99;
    }
    match /paStrLengthKeyNot/{id} {
      allow get: if !('abc'['length'] == 3);
    }
    match /paStrLengthKeyOrTrue/{id} {
      allow get: if 'abc'['length'] == 3 || true;
    }
    // Dot length on a string.
    match /paStrLengthEq/{id} {
      allow get: if resource.data.name.length == 5;
    }
    match /paStrLengthNe/{id} {
      allow get: if resource.data.name.length != 99;
    }
    match /paStrLengthNot/{id} {
      allow get: if !(resource.data.name.length == 5);
    }
    match /paStrLengthOrTrue/{id} {
      allow get: if resource.data.name.length == 5 || true;
    }
    // Int index on a path.
    match /paPathIndexEq/{id} {
      allow get: if request.path[0] == 'databases';
    }
    match /paPathIndexNe/{id} {
      allow get: if request.path[0] != 'zz';
    }
    match /paPathIndexNot/{id} {
      allow get: if !(request.path[0] == 'databases');
    }
    match /paPathIndexOrTrue/{id} {
      allow get: if request.path[0] == 'databases' || true;
    }
    // Unbound string key on a path.
    match /paPathSegmentsKeyEq/{id} {
      allow get: if request.path['segments'] == null;
    }
    match /paPathSegmentsKeyNe/{id} {
      allow get: if request.path['segments'] != 'zz';
    }
    match /paPathSegmentsKeyNot/{id} {
      allow get: if !(request.path['segments'] == null);
    }
    match /paPathSegmentsKeyOrTrue/{id} {
      allow get: if request.path['segments'] == null || true;
    }
    // Unbound name read by dot access on a path.
    match /paPathSegmentsDotEq/{id} {
      allow get: if request.path.segments == null;
    }
    match /paPathSegmentsDotNe/{id} {
      allow get: if request.path.segments != 'zz';
    }
    match /paPathSegmentsDotNot/{id} {
      allow get: if !(request.path.segments == null);
    }
    match /paPathSegmentsDotOrTrue/{id} {
      allow get: if request.path.segments == null || true;
    }
    // Int index on a timestamp.
    match /paTimestampIndexEq/{id} {
      allow get: if timestamp.value(0)[0] == null;
    }
    match /paTimestampIndexNe/{id} {
      allow get: if timestamp.value(0)[0] != 'zz';
    }
    match /paTimestampIndexNot/{id} {
      allow get: if !(timestamp.value(0)[0] == null);
    }
    match /paTimestampIndexOrTrue/{id} {
      allow get: if timestamp.value(0)[0] == null || true;
    }
    // Int index on a latlng.
    match /paLatLngIndexEq/{id} {
      allow get: if latlng.value(1.0, 2.0)[0] == null;
    }
    match /paLatLngIndexNe/{id} {
      allow get: if latlng.value(1.0, 2.0)[0] != 'zz';
    }
    match /paLatLngIndexNot/{id} {
      allow get: if !(latlng.value(1.0, 2.0)[0] == null);
    }
    match /paLatLngIndexOrTrue/{id} {
      allow get: if latlng.value(1.0, 2.0)[0] == null || true;
    }
    // Int index on a duration.
    match /paDurationIndexEq/{id} {
      allow get: if duration.value(1, 'h')[0] == null;
    }
    match /paDurationIndexNe/{id} {
      allow get: if duration.value(1, 'h')[0] != 'zz';
    }
    match /paDurationIndexNot/{id} {
      allow get: if !(duration.value(1, 'h')[0] == null);
    }
    match /paDurationIndexOrTrue/{id} {
      allow get: if duration.value(1, 'h')[0] == null || true;
    }
    // Dot size without a call on a map.
    match /paMapSizeFieldEq/{id} {
      allow get: if resource.data.m.size == 1;
    }
    match /paMapSizeFieldNe/{id} {
      allow get: if resource.data.m.size != 99;
    }
    match /paMapSizeFieldNot/{id} {
      allow get: if !(resource.data.m.size == 1);
    }
    match /paMapSizeFieldOrTrue/{id} {
      allow get: if resource.data.m.size == 1 || true;
    }
  }
}`,
  cases: [
    {
      description: 'missing field == null → DENY (error, not null)',
      expectation: 'DENY',
      method: 'create',
      path: 'typoEqNullDeny/d1',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'present field == value → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'presentEqAllow/d2',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: "!('typo' in data) → ALLOW (correct absence check)",
      expectation: 'ALLOW',
      method: 'create',
      path: 'notInAllow/d3',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'nested missing field under existing map → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'nestedTypoDeny/d4',
      auth: { uid: 'alice' },
      data: { m: { a: 1 } },
    },
    {
      description: '!(missing == value) → DENY (error propagates through !)',
      expectation: 'DENY',
      method: 'create',
      path: 'negatedErrorDeny/d5',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'missing-field error || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'absorbedAllow/d6',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'data[\'missing\'] == true on existing doc → DENY (missing bracket key errors)',
      expectation: 'DENY',
      method: 'get',
      path: 'bkEqTrue/e1',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'] != true on existing doc → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNeTrue/e2',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'] == null on existing doc → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkEqNull/e3',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(data[\'missing\'] == true) → DENY (error propagates through !)',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNotEqTrue/e4',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(data[\'missing\'] != true) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNotNeTrue/e5',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'] == true || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkOrTrue/e6',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'true || data[\'missing\'] == true → ALLOW (short circuit)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkTrueOr/e7',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(data[\'missing\'] == true && false) → ALLOW (error && false is false)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkNotAndFalse/e8',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'] is string → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkIsString/e9',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(data[\'missing\'] is string) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNotIsString/e10',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'] in [\'a\', \'b\'] → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkInList/e11',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(data[\'missing\'] in [\'a\', \'b\']) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNotInList/e12',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'missing\'].size() == 0 → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkSize/e13',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'m\'][\'missing\'] == null (nested) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkNestedEqNull/e14',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'m\'][\'a\'] == 1 (nested present) → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkNestedPresent/e15',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'let bound to data[\'missing\'] and unused → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkLetUnused/e16',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'let bound to data[\'missing\'] and used → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkLetUsed/e17',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'miss\' + \'ing\'] != true (computed missing key) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkComputedMissing/e18',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'na\' + \'me\'] == \'alice\' (computed present key) → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkComputedPresent/e19',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[field] != true with a path variable naming a missing key → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'bkPathKey/deleted',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'name\'] == \'alice\' (present key) → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkPresent/e21',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data[\'nul\'] == null (key present with null) → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkPresentNull/e22',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: '!(\'missing\' in data) || data[\'missing\'] != true → ALLOW (guarded)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'bkGuardedIn/e23',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data.missing != true on existing doc → DENY (dot access errors)',
      expectation: 'DENY',
      method: 'get',
      path: 'dotNeTrue/e24',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'data.get(\'missing\', null) == null → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'getDefaultNull/e25',
      auth: { uid: 'alice' },
      resource: { name: 'alice', m: { a: 1 }, nul: null },
    },
    {
      description: 'request.resource.data[\'missing\'] != true → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'reqBkNeTrue/r1',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'request.resource.data[\'missing\'] == null → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'reqBkEqNull/r2',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'request.resource.data[\'missing\'] == null || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqBkOrTrue/r3',
      auth: { uid: 'alice' },
      data: { name: 'alice' },
    },
    {
      description: 'data[\'l\'][5] == null (list index past the end) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'listPastEnd/l1',
      auth: { uid: 'alice' },
      resource: { l: [1, 2] },
    },
    {
      description: '!(data[\'l\'][5] == 1) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'listNotPastEnd/l2',
      auth: { uid: 'alice' },
      resource: { l: [1, 2] },
    },
    {
      description: 'data[\'l\'][1] == 2 (list index in range) → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'listInRange/l3',
      auth: { uid: 'alice' },
      resource: { l: [1, 2] },
    },
    {
      description: 'request.auth.token[\'missing\'] == null → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'tokenBkEqNull/t1',
      auth: { uid: 'alice' },
      resource: { name: 'alice' },
    },
    {
      description: 'data[\'l\'][-1] == 2 (negative list index) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'listNegative/l4',
      auth: { uid: 'alice' },
      resource: { l: [1, 2] },
    },
    {
      description: 'data[\'l\'][\'length\'] == 2 (string key on a list) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'listLengthKey/l5',
      auth: { uid: 'alice' },
      resource: { l: [1, 2] },
    },
    {
      description: 'data[\'constructor\'] == null (inherited name, not a key) → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'mapProtoKey/p1',
      auth: { uid: 'alice' },
      resource: { name: 'alice' },
    },
    ...([
      ['resource.data.l.length == 2 (dot length on a list) → DENY', 'DENY', 'paListLengthEq/p1'],
      ['resource.data.l.length != 99 (dot length on a list) → DENY', 'DENY', 'paListLengthNe/p1'],
      ['!(resource.data.l.length == 2) (dot length on a list) → DENY', 'DENY', 'paListLengthNot/p1'],
      ['resource.data.l.length == 2 || true (dot length on a list) → ALLOW', 'ALLOW', 'paListLengthOrTrue/p1'],
      ['resource.data.l.size == 2 (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldEq/p1'],
      ['resource.data.l.size != 99 (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldNe/p1'],
      ['!(resource.data.l.size == 2) (dot size without a call on a list) → DENY', 'DENY', 'paListSizeFieldNot/p1'],
      ['resource.data.l.size == 2 || true (dot size without a call on a list) → ALLOW', 'ALLOW', 'paListSizeFieldOrTrue/p1'],
      ['\'abc\'[0] == \'a\' (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexEq/p1'],
      ['\'abc\'[0] != \'zz\' (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexNe/p1'],
      ['!(\'abc\'[0] == \'a\') (int index on a string) → DENY', 'DENY', 'paStrIndexNot/p1'],
      ['\'abc\'[0] == \'a\' || true (int index on a string) → ALLOW', 'ALLOW', 'paStrIndexOrTrue/p1'],
      ['\'abc\'[\'length\'] == 3 (string key on a string) → DENY', 'DENY', 'paStrLengthKeyEq/p1'],
      ['\'abc\'[\'length\'] != 99 (string key on a string) → DENY', 'DENY', 'paStrLengthKeyNe/p1'],
      ['!(\'abc\'[\'length\'] == 3) (string key on a string) → DENY', 'DENY', 'paStrLengthKeyNot/p1'],
      ['\'abc\'[\'length\'] == 3 || true (string key on a string) → ALLOW', 'ALLOW', 'paStrLengthKeyOrTrue/p1'],
      ['resource.data.name.length == 5 (dot length on a string) → DENY', 'DENY', 'paStrLengthEq/p1'],
      ['resource.data.name.length != 99 (dot length on a string) → DENY', 'DENY', 'paStrLengthNe/p1'],
      ['!(resource.data.name.length == 5) (dot length on a string) → DENY', 'DENY', 'paStrLengthNot/p1'],
      ['resource.data.name.length == 5 || true (dot length on a string) → ALLOW', 'ALLOW', 'paStrLengthOrTrue/p1'],
      ['request.path[0] == \'databases\' (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexEq/p1'],
      ['request.path[0] != \'zz\' (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexNe/p1'],
      ['!(request.path[0] == \'databases\') (int index on a path) → DENY', 'DENY', 'paPathIndexNot/p1'],
      ['request.path[0] == \'databases\' || true (int index on a path) → ALLOW', 'ALLOW', 'paPathIndexOrTrue/p1'],
      ['request.path[\'segments\'] == null (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyEq/p1'],
      ['request.path[\'segments\'] != \'zz\' (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyNe/p1'],
      ['!(request.path[\'segments\'] == null) (unbound string key on a path) → DENY', 'DENY', 'paPathSegmentsKeyNot/p1'],
      ['request.path[\'segments\'] == null || true (unbound string key on a path) → ALLOW', 'ALLOW', 'paPathSegmentsKeyOrTrue/p1'],
      ['request.path.segments == null (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotEq/p1'],
      ['request.path.segments != \'zz\' (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotNe/p1'],
      ['!(request.path.segments == null) (unbound name by dot access on a path) → DENY', 'DENY', 'paPathSegmentsDotNot/p1'],
      ['request.path.segments == null || true (unbound name by dot access on a path) → ALLOW', 'ALLOW', 'paPathSegmentsDotOrTrue/p1'],
      ['timestamp.value(0)[0] == null (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexEq/p1'],
      ['timestamp.value(0)[0] != \'zz\' (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexNe/p1'],
      ['!(timestamp.value(0)[0] == null) (int index on a timestamp) → DENY', 'DENY', 'paTimestampIndexNot/p1'],
      ['timestamp.value(0)[0] == null || true (int index on a timestamp) → ALLOW', 'ALLOW', 'paTimestampIndexOrTrue/p1'],
      ['latlng.value(1.0, 2.0)[0] == null (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexEq/p1'],
      ['latlng.value(1.0, 2.0)[0] != \'zz\' (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexNe/p1'],
      ['!(latlng.value(1.0, 2.0)[0] == null) (int index on a latlng) → DENY', 'DENY', 'paLatLngIndexNot/p1'],
      ['latlng.value(1.0, 2.0)[0] == null || true (int index on a latlng) → ALLOW', 'ALLOW', 'paLatLngIndexOrTrue/p1'],
      ['duration.value(1, \'h\')[0] == null (int index on a duration) → DENY', 'DENY', 'paDurationIndexEq/p1'],
      ['duration.value(1, \'h\')[0] != \'zz\' (int index on a duration) → DENY', 'DENY', 'paDurationIndexNe/p1'],
      ['!(duration.value(1, \'h\')[0] == null) (int index on a duration) → DENY', 'DENY', 'paDurationIndexNot/p1'],
      ['duration.value(1, \'h\')[0] == null || true (int index on a duration) → ALLOW', 'ALLOW', 'paDurationIndexOrTrue/p1'],
      ['resource.data.m.size == 1 (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldEq/p1'],
      ['resource.data.m.size != 99 (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldNe/p1'],
      ['!(resource.data.m.size == 1) (dot size without a call on a map) → DENY', 'DENY', 'paMapSizeFieldNot/p1'],
      ['resource.data.m.size == 1 || true (dot size without a call on a map) → ALLOW', 'ALLOW', 'paMapSizeFieldOrTrue/p1'],
    ] as const).map(([description, expectation, path]) => ({
      description, expectation, method: 'get' as const, path,
      auth: { uid: 'alice' }, resource: { name: 'alice', m: { a: 1 }, l: [1, 2] },
    })),
  ],
  group: 'fix-class',
};
