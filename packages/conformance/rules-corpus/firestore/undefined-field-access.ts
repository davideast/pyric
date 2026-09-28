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
  ],
  group: 'fix-class',
};
