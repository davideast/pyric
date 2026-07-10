/**
 * Firestore rules corpus — round-1/2 fix-class packs.
 *
 * Migrated verbatim (byte-identical pack literals) out of the inline
 * definitions in
 * `packages/pyric/test/rules/parity/round-fix-classes.test.ts`.
 *
 * One focused pack per fixed ledger class:
 *   - RULES-B3  error-absorption in && / || (CEL commutative tri-state)
 *   - RULES-B2  undefined-field access is a runtime error (not null)
 *   - RULES-B5  int/float distinction + integer division + div-by-zero
 *   - RULES-B4  matches() is a full-string RE2 match (not JS partial)
 *   - RULES-B7  no prototype-chain key leakage (own keys only)
 *   - RULES-B8  get() of a missing doc errors; get() resource has id/__name__
 *
 * The resurrected stress packs predate the remediation rounds, so they would
 * come back green even if the round-1/2 fix classes regressed. These packs
 * are the focused regression gate. Any SIM_BUG row here is a round-4 ledger
 * candidate — record the row, do not "fix" the test.
 */
import type { Pack } from './types.ts';

// ─── Pack 1: error-absorption-and-or (RULES-B3) ───────────────────────────
// CEL's && and || are COMMUTATIVE error-absorbing operators: `error || true`
// is true (the true branch absorbs the error), `error && false` is false,
// while `error || false` / `error && true` propagate the error → DENY.
// Pre-fix the simulator short-circuited left-to-right JS-style, so
// `error || true` denied where production allows. The error generator here
// is a missing-field access (a runtime error post-RULES-B2).

const PACK_ERROR_ABSORPTION: Pack = {
  id: 'error-absorption-and-or',
  fm: 'RULES-B3',
  rationale: 'CEL tri-state: `error || true` → ALLOW, `error && false` → DENY-as-false; errors absorb commutatively, not JS left-to-right.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // error || true → true (absorbed) → ALLOW
    match /errOrTrueAllow/{id} {
      allow create: if request.resource.data.missing > 0 || true;
    }
    // true || error → true → ALLOW (JS-compatible direction, control)
    match /trueOrErrAllow/{id} {
      allow create: if true || request.resource.data.missing > 0;
    }
    // error || false → error propagates → DENY
    match /errOrFalseDeny/{id} {
      allow create: if request.resource.data.missing > 0 || false;
    }
    // error && false → false (absorbed) → DENY (as false, not error)
    match /errAndFalseDeny/{id} {
      allow create: if request.resource.data.missing > 0 && false;
    }
    // false && error → false → DENY (JS-compatible direction, control)
    match /falseAndErrDeny/{id} {
      allow create: if false && request.resource.data.missing > 0;
    }
    // error && true → error propagates → DENY
    match /errAndTrueDeny/{id} {
      allow create: if request.resource.data.missing > 0 && true;
    }
    // absorbed-error result feeds an outer || → ALLOW
    match /nestedAbsorbAllow/{id} {
      allow create: if (request.resource.data.missing > 0 && false) || true;
    }
  }
}`,
  cases: [
    {
      description: 'error || true → ALLOW (commutative absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'errOrTrueAllow/d1',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'true || error → ALLOW (short-circuit control)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'trueOrErrAllow/d2',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error || false → DENY (error propagates)',
      expectation: 'DENY',
      method: 'create',
      path: 'errOrFalseDeny/d3',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error && false → DENY (absorbed to false)',
      expectation: 'DENY',
      method: 'create',
      path: 'errAndFalseDeny/d4',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'false && error → DENY (short-circuit control)',
      expectation: 'DENY',
      method: 'create',
      path: 'falseAndErrDeny/d5',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: 'error && true → DENY (error propagates)',
      expectation: 'DENY',
      method: 'create',
      path: 'errAndTrueDeny/d6',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
    {
      description: '(error && false) || true → ALLOW (nested absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'nestedAbsorbAllow/d7',
      auth: { uid: 'alice' },
      data: { present: 1 },
    },
  ],
};

// ─── Pack 2: undefined-field-access (RULES-B2) ────────────────────────────
// Production: reading a key that does not exist on a map is a runtime ERROR
// (→ deny via tri-state), NOT a silent null. Pre-fix the simulator returned
// null, which INVERTED the commonest rules-debug idiom:
// `request.resource.data.typo == null` allowed in sim, denies in prod.
// The correct absence check is the `in` operator.

const PACK_UNDEFINED_FIELD: Pack = {
  id: 'undefined-field-access',
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
  ],
};

// ─── Pack 3: int-float-and-division (RULES-B5) ────────────────────────────
// Production distinguishes int and float as separate types; `/` on two ints
// is INTEGER division (truncating toward zero) and division by zero is a
// runtime error (→ deny), not Infinity. Pre-fix the simulator used JS
// float division for everything.

const PACK_INT_FLOAT_DIVISION: Pack = {
  id: 'int-float-and-division',
  fm: 'RULES-B5',
  rationale: 'int ÷ int truncates toward zero, float division stays float, div-by-zero errors (deny); `is int` / `is float` are distinct types.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // int ÷ int truncates: 10 / 4 == 2
    match /intDivTruncAllow/{id} {
      allow create: if 10 / 4 == 2;
    }
    // int ÷ int is NOT float division
    match /intDivNotFloatDeny/{id} {
      allow create: if 10 / 4 == 2.5;
    }
    // truncation is toward zero for negatives: -7 / 2 == -3
    match /negIntDivAllow/{id} {
      allow create: if -7 / 2 == -3;
    }
    // float division: 10.0 / 4.0 == 2.5
    match /floatDivAllow/{id} {
      allow create: if 10.0 / 4.0 == 2.5;
    }
    // mixed int/float promotes to float: 10 / 4.0 == 2.5
    match /mixedDivAllow/{id} {
      allow create: if 10 / 4.0 == 2.5;
    }
    // integer modulo: 10 % 3 == 1
    match /modAllow/{id} {
      allow create: if 10 % 3 == 1;
    }
    // division by zero is an error → DENY (not Infinity)
    match /divByZeroDeny/{id} {
      allow create: if 10 / 0 == 0;
    }
    // div-by-zero error absorbed by || true (RULES-B3 interplay) → ALLOW
    match /divByZeroAbsorbAllow/{id} {
      allow create: if 10 / 0 == 0 || true;
    }
    // wire int payload satisfies "is int", not float
    match /isIntAllow/{id} {
      allow create: if request.resource.data.n is int
        && !(request.resource.data.n is float);
    }
    // wire float payload satisfies "is float", not int
    match /isFloatAllow/{id} {
      allow create: if request.resource.data.x is float
        && !(request.resource.data.x is int);
    }
  }
}`,
  cases: [
    {
      description: '10 / 4 == 2 (integer truncation) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'intDivTruncAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 4 == 2.5 (float result from int operands) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'intDivNotFloatDeny/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '-7 / 2 == -3 (truncation toward zero) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'negIntDivAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10.0 / 4.0 == 2.5 (float division) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'floatDivAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 4.0 == 2.5 (mixed promotes to float) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'mixedDivAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 % 3 == 1 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'modAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 0 errors → DENY (not Infinity)',
      expectation: 'DENY',
      method: 'create',
      path: 'divByZeroDeny/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: '10 / 0 error || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'divByZeroAbsorbAllow/d8',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'integer payload is int / not float ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isIntAllow/d9',
      auth: { uid: 'alice' },
      data: { n: 5 },
    },
    {
      description: 'float payload is float / not int ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isFloatAllow/d10',
      auth: { uid: 'alice' },
      data: { x: 5.5 },
    },
  ],
};

// ─── Pack 4: matches-full-string-regex (RULES-B4) ─────────────────────────
// Production's matches() requires the RE2 pattern to consume the ENTIRE
// string (implicit anchoring). Pre-fix the simulator used JS RegExp.test()
// partial matching, so any substring hit allowed. The discriminating cases
// are patterns that match a SUBSTRING but not the full string — JS-partial
// says true, prod says false.

const PACK_MATCHES_FULL_STRING: Pack = {
  id: 'matches-full-string-regex',
  fm: 'RULES-B4',
  rationale: 'matches() is an anchored full-string RE2 match; a pattern matching only a substring must be false (JS partial-match said true).',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // substring pattern does NOT full-match → DENY
    match /partialNoMatchDeny/{id} {
      allow create: if 'hello world'.matches('world');
    }
    // exact pattern full-matches → ALLOW
    match /exactMatchAllow/{id} {
      allow create: if 'hello'.matches('hello');
    }
    // wildcard prefix makes it consume the whole string → ALLOW
    match /wildcardAllow/{id} {
      allow create: if 'hello world'.matches('.*world');
    }
    // class pattern consuming the full string → ALLOW
    match /classFullAllow/{id} {
      allow create: if 'abc123'.matches('[a-z]+[0-9]+');
    }
    // same pattern, one trailing char unconsumed → DENY (partial would hit)
    match /classTrailingDeny/{id} {
      allow create: if 'abc123!'.matches('[a-z]+[0-9]+');
    }
    // email domain check with escaped dot, full string → ALLOW
    match /emailFullAllow/{id} {
      allow create: if request.auth.token.email.matches('[a-z]+@acme\\\\.com');
    }
    // leading char outside the class → full match fails → DENY
    // (the substring 'alice@acme.com' WOULD partial-match)
    match /emailPrefixedDeny/{id} {
      allow create: if request.auth.token.email.matches('[a-z]+@acme\\\\.com');
    }
  }
}`,
  cases: [
    {
      description: "'hello world'.matches('world') → DENY (no partial match)",
      expectation: 'DENY',
      method: 'create',
      path: 'partialNoMatchDeny/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'hello'.matches('hello') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'exactMatchAllow/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'hello world'.matches('.*world') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'wildcardAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'abc123'.matches('[a-z]+[0-9]+') → ALLOW (full consume)",
      expectation: 'ALLOW',
      method: 'create',
      path: 'classFullAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "'abc123!'.matches('[a-z]+[0-9]+') → DENY (trailing char)",
      expectation: 'DENY',
      method: 'create',
      path: 'classTrailingDeny/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'alice@acme.com vs full-string email pattern → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'emailFullAllow/d6',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
      data: { _: 1 },
    },
    {
      description: '1alice@acme.com vs same pattern → DENY (substring would partial-match)',
      expectation: 'DENY',
      method: 'create',
      path: 'emailPrefixedDeny/d7',
      auth: { uid: 'bob', token: { email: '1alice@acme.com' } },
      data: { _: 1 },
    },
  ],
};

// ─── Pack 5: prototype-chain-keys (RULES-B7) ──────────────────────────────
// Production maps expose OWN keys only — `'toString' in data` is false
// unless the document literally has a `toString` field, and
// `data.constructor` is a missing-field error. Pre-fix the simulator's
// `in` walked the JS prototype chain, so `'toString' in data` allowed and
// `data.constructor` returned the Object constructor.

const PACK_PROTOTYPE_KEYS: Pack = {
  id: 'prototype-chain-keys',
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
  ],
};

// ─── Pack 6: get-missing-doc (RULES-B8) ───────────────────────────────────
// Production: get() of a non-existent document is a runtime error (→ deny),
// NOT a silent null; and the resource a successful get() returns carries
// `id` and `__name__` alongside `data`. Pre-fix the simulator returned null
// for missing docs and a bare `{data}` for present ones. In the Rules Test
// API "missing" = not provided via functionMocks; "present" = mocked.

const PACK_GET_MISSING_DOC: Pack = {
  id: 'get-missing-doc',
  fm: 'RULES-B8',
  rationale: 'get() of a missing doc must deny via error (null made `== null` probes ALLOW); get() resource must expose id/__name__.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // get() of an unmocked (missing) doc → error → DENY
    match /getMissingDeny/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/missing).data.flag == true;
    }
    // the pre-fix footgun: comparing missing get() to null must NOT allow
    match /getMissingNullProbeDeny/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/missing) == null;
    }
    // missing-get error absorbed by || true (RULES-B3 interplay) → ALLOW
    match /getMissingAbsorbAllow/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/missing).data.flag == true || true;
    }
    // exists() guard pattern with nothing mocked → false/error → DENY
    match /guardedGetDeny/{id} {
      allow create: if exists(/databases/$(database)/documents/cfg/missing)
        && get(/databases/$(database)/documents/cfg/missing).data.flag == true;
    }
    // mocked doc: data flows through → ALLOW
    match /getMockedAllow/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/site).data.flag == true;
    }
    // mocked doc: resource carries id → ALLOW
    match /getResourceIdAllow/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/site).id == 'site';
    }
    // mocked doc: resource carries __name__ as a Path → ALLOW
    match /getResourceNameAllow/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/site).__name__
        == /databases/$(database)/documents/cfg/site;
    }
    // mocked exists() → ALLOW (control for the guard pattern)
    match /existsMockedAllow/{id} {
      allow create: if exists(/databases/$(database)/documents/other/x);
    }
  }
}`,
  cases: [
    {
      description: 'get(missing).data.flag == true → DENY (error, not null)',
      expectation: 'DENY',
      method: 'create',
      path: 'getMissingDeny/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'get(missing) == null → DENY (pre-fix footgun allowed)',
      expectation: 'DENY',
      method: 'create',
      path: 'getMissingNullProbeDeny/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'get(missing) error || true → ALLOW (absorption)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'getMissingAbsorbAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'exists(missing) && get(missing)... → DENY (guard pattern)',
      expectation: 'DENY',
      method: 'create',
      path: 'guardedGetDeny/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'get(mocked).data.flag == true → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'getMockedAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'cfg/site', result: { flag: true } },
      ],
    },
    {
      description: "get(mocked).id == 'site' → ALLOW (resource identity)",
      expectation: 'ALLOW',
      method: 'create',
      path: 'getResourceIdAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'cfg/site', result: { flag: true } },
      ],
    },
    {
      description: 'get(mocked).__name__ == path literal → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'getResourceNameAllow/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'cfg/site', result: { flag: true } },
      ],
    },
    {
      description: 'exists(mocked true) → ALLOW (control)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'existsMockedAllow/d8',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'exists', path: 'other/x', result: true },
      ],
    },
  ],
};

/** The 6 round-1/2 fix-class packs, in original source order. */
export const FIX_CLASS_PACKS: Pack[] = [
  PACK_ERROR_ABSORPTION,
  PACK_UNDEFINED_FIELD,
  PACK_INT_FLOAT_DIVISION,
  PACK_MATCHES_FULL_STRING,
  PACK_PROTOTYPE_KEYS,
  PACK_GET_MISSING_DOC,
];
