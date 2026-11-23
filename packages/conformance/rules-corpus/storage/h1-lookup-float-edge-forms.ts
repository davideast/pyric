/**
 * Candidate scenario (#1815): h1-lookup-float-edge-forms
 *
 * Settles how production Storage Rules handle every float form left unproven by
 * h1-lookup-float-interpolation when interpolated via $(expr) into
 * firestore.get(...) or firestore.exists(...):
 *   - wrapped float literal $(1.5), float('1.5') cast, helper-built path
 *     literal, and negative non-integral float -1.5 (claim and document field);
 *   - integral floats $(2.0), $(float(2)), and 2^53 (9007199254740992 as auth
 *     claim and as Firestore document field), disambiguating '.0', plain
 *     integer digits, scientific notation, and refusal;
 *   - small (< 1e-3) and large (>= 1e7) magnitudes and exponents (0.0005,
 *     float('1e-7'), 10000000.5, 1e21), disambiguating Java Double.toString
 *     scientific notation ('5.0E-4', '1.00000005E7') from plain decimal;
 *   - negative zero $(-0.0) and $(-1.0 * 0.0);
 *   - non-finite floats NaN, Infinity, and -Infinity from float(...) casts and
 *     float division by zero.
 */
import type { StorageScenarioRecord, StorageTestCase } from './types.ts';

type StorageFunctionMock = NonNullable<StorageTestCase['functionMocks']>[number];

function existsMock(path: string): StorageFunctionMock {
  return { function: 'exists', path, result: true };
}

function getMock(path: string, result: Record<string, unknown>): StorageFunctionMock {
  return { function: 'get', path, result };
}

function claimCase(
  description: string,
  value: number,
  mocks: StorageFunctionMock[],
  expectation: 'ALLOW' | 'DENY' = 'DENY',
): StorageTestCase {
  return {
    description,
    expectation,
    method: 'create',
    path: 'claim/exists.bin',
    auth: { uid: 'alice', token: { v: value } },
    resource: { size: 1 },
    functionMocks: mocks,
  };
}

function fieldCase(
  description: string,
  value: number,
  mocks: StorageFunctionMock[],
): StorageTestCase {
  return {
    description,
    expectation: 'DENY',
    method: 'create',
    path: 'field/exists.bin',
    auth: { uid: 'alice' },
    resource: { size: 1 },
    functionMocks: [getMock('cfg/main', { v: value }), ...mocks],
  };
}

function ruleCase(
  description: string,
  objectPath: string,
  mocks: StorageFunctionMock[],
): StorageTestCase {
  return {
    description,
    expectation: 'DENY',
    method: 'create',
    path: objectPath,
    auth: { uid: 'alice' },
    resource: { size: 1 },
    functionMocks: mocks,
  };
}

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-LOOKUP-FLOAT-EDGE-FORMS',
  rationale:
    'Whether Storage lookup-path $(expr) interpolation accepts or refuses integral floats, scientific-notation magnitudes, 2^53, negative zero, NaN, infinities, negative floats, float literals/casts, and helper-built path literals (#1815).',
  pendingRowLink: true,
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function itemDoc(v) {
      return /databases/(default)/documents/items/$(v);
    }
    match /claim/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(request.auth.token.v));
    }
    match /helper/get.bin {
      allow create: if firestore.get(itemDoc(request.auth.token.v)).data.ok == true;
    }
    match /field/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(firestore.get(/databases/(default)/documents/cfg/main).data.v));
    }
    match /lit15/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(1.5));
    }
    match /cast15/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('1.5')));
    }
    match /lit20/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(2.0));
    }
    match /cast2/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float(2)));
    }
    match /cast1em7/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('1e-7')));
    }
    match /negzero/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(-0.0));
    }
    match /negzeroprod/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(-1.0 * 0.0));
    }
    match /nan/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('NaN')));
    }
    match /nandiv/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(0.0 / 0.0));
    }
    match /inf/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('Infinity')));
    }
    match /neginf/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(float('-Infinity')));
    }
    match /infdiv/exists.bin {
      allow create: if firestore.exists(/databases/(default)/documents/items/$(1.0 / 0.0));
    }
  }
}`,
  cases: [
    claimCase('control: int auth claim 7 in firestore.exists path', 7, [existsMock('items/7')], 'ALLOW'),
    ruleCase('literal 1.5: $(1.5) in firestore.exists path', 'lit15/exists.bin', [existsMock('items/1.5')]),
    ruleCase("cast 1.5: $(float('1.5')) in firestore.exists path", 'cast15/exists.bin', [existsMock('items/1.5')]),
    {
      description: 'helper path literal: float auth claim 1.5 via helper path literal in firestore.get',
      expectation: 'DENY',
      method: 'create',
      path: 'helper/get.bin',
      auth: { uid: 'alice', token: { v: 1.5 } },
      resource: { size: 1 },
      functionMocks: [getMock('items/1.5', { ok: true })],
    },
    claimCase('negative float claim: auth claim -1.5 in firestore.exists path', -1.5, [existsMock('items/-1.5')]),
    fieldCase('negative float field: document field -1.5 in firestore.exists path', -1.5, [existsMock('items/-1.5')]),

    ruleCase('integral float 2.0 as 2.0: $(2.0) mocked at items/2.0', 'lit20/exists.bin', [existsMock('items/2.0')]),
    ruleCase('integral float 2.0 as 2: $(2.0) mocked at items/2', 'lit20/exists.bin', [existsMock('items/2')]),
    ruleCase('integral float(2) as 2.0: $(float(2)) mocked at items/2.0', 'cast2/exists.bin', [existsMock('items/2.0')]),
    ruleCase('integral float(2) as 2: $(float(2)) mocked at items/2', 'cast2/exists.bin', [existsMock('items/2')]),
    claimCase('2^53 claim plain: auth claim 9007199254740992 mocked at items/9007199254740992', 9007199254740992, [existsMock('items/9007199254740992')], 'ALLOW'),
    claimCase('2^53 claim scientific: auth claim 9007199254740992 mocked at items/9.007199254740992E15', 9007199254740992, [existsMock('items/9.007199254740992E15')]),
    fieldCase('2^53 field plain: document field 9007199254740992 mocked at items/9007199254740992', 9007199254740992, [existsMock('items/9007199254740992')]),
    fieldCase('2^53 field scientific: document field 9007199254740992 mocked at items/9.007199254740992E15', 9007199254740992, [existsMock('items/9.007199254740992E15')]),

    claimCase('small claim 0.0005 scientific: auth claim 0.0005 mocked at items/5.0E-4', 0.0005, [existsMock('items/5.0E-4')]),
    claimCase('small claim 0.0005 plain: auth claim 0.0005 mocked at items/0.0005', 0.0005, [existsMock('items/0.0005')]),
    fieldCase('small field 0.0005 scientific: document field 0.0005 mocked at items/5.0E-4', 0.0005, [existsMock('items/5.0E-4')]),
    fieldCase('small field 0.0005 plain: document field 0.0005 mocked at items/0.0005', 0.0005, [existsMock('items/0.0005')]),
    ruleCase(
      "exponent cast 1e-7: $(float('1e-7')) mocked at Java and JS exponent/plain forms",
      'cast1em7/exists.bin',
      [existsMock('items/1.0E-7'), existsMock('items/1e-7'), existsMock('items/0.0000001')],
    ),

    claimCase('large claim 10000000.5 scientific: auth claim 10000000.5 mocked at items/1.00000005E7', 10000000.5, [existsMock('items/1.00000005E7')]),
    claimCase('large claim 10000000.5 plain: auth claim 10000000.5 mocked at items/10000000.5', 10000000.5, [existsMock('items/10000000.5')]),
    fieldCase('large field 10000000.5 scientific: document field 10000000.5 mocked at items/1.00000005E7', 10000000.5, [existsMock('items/1.00000005E7')]),
    fieldCase('large field 10000000.5 plain: document field 10000000.5 mocked at items/10000000.5', 10000000.5, [existsMock('items/10000000.5')]),
    claimCase(
      'large claim 1e21: auth claim 1e21 mocked at Java and JS exponent forms',
      1e21,
      [existsMock('items/1.0E21'), existsMock('items/1e+21')],
    ),

    ruleCase('negative zero literal as -0.0: $(-0.0) mocked at items/-0.0', 'negzero/exists.bin', [existsMock('items/-0.0')]),
    ruleCase('negative zero literal as 0.0 or 0: $(-0.0) mocked at items/0.0 and items/0', 'negzero/exists.bin', [existsMock('items/0.0'), existsMock('items/0')]),
    ruleCase(
      'negative zero product: $(-1.0 * 0.0) mocked at items/-0.0, items/0.0, and items/0',
      'negzeroprod/exists.bin',
      [existsMock('items/-0.0'), existsMock('items/0.0'), existsMock('items/0')],
    ),

    ruleCase("nan cast: $(float('NaN')) mocked at items/NaN", 'nan/exists.bin', [existsMock('items/NaN')]),
    ruleCase('nan division: $(0.0 / 0.0) mocked at items/NaN', 'nandiv/exists.bin', [existsMock('items/NaN')]),
    ruleCase("infinity cast: $(float('Infinity')) mocked at items/Infinity", 'inf/exists.bin', [existsMock('items/Infinity')]),
    ruleCase("neg infinity cast: $(float('-Infinity')) mocked at items/-Infinity", 'neginf/exists.bin', [existsMock('items/-Infinity')]),
    ruleCase('infinity division: $(1.0 / 0.0) mocked at items/Infinity', 'infdiv/exists.bin', [existsMock('items/Infinity')]),
  ],
};
