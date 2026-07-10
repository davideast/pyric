/**
 * Firestore rules corpus — production-parity stress packs.
 *
 * Migrated verbatim (byte-identical pack literals) out of the inline
 * definitions in
 * `packages/pyric/test/rules/parity/parity-stress.test.ts` so the corpus is
 * the single source and both the live parity harness and the oracle capture
 * runner read the same packs. The 12 packs were resurrected from the
 * pre-cutover suite (deleted in be3c2b2; restored per the design rationale
 * section 5 and round-3 track P3).
 *
 * Provenance / classification legend lives in the harness (harness.ts):
 *   OK / SIM_BUG / SIM_NOT_SUPPORTED / BAD_RULE / ERR.
 */
import type { Pack } from './types.ts';

// ─── Pack 1: builtins-time-and-math ────────────────────────────────────────
// Targets FM3 (missing builtins). Rules only use built-in functions on
// literal arguments (no request.time), so production should evaluate them
// deterministically. The simulator's evaluator (evaluator.ts:256-273) has
// no entries for math.* / timestamp.* / duration.* — they parse as method
// calls on a namespace identifier that resolves to `undefined` and throws.
// The throw is caught at handler.ts:126 and counted as deny, so every
// ALLOW-expectation case in this pack should be reported as SIM_BUG.

const PACK_BUILTINS_TIME_AND_MATH: Pack = {
  id: 'builtins-time-and-math',
  fm: 'FM3',
  rationale: 'Simulator throws on math.*, timestamp.*, duration.* — agent rules using these silently deny in the simulator while production evaluates them.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 1. math.abs() — bounded delta validation.
    match /scoresAllow/{id} {
      allow create: if request.auth != null
        && math.abs(request.resource.data.delta) <= 100;
    }
    match /scoresDeny/{id} {
      allow create: if request.auth != null
        && math.abs(request.resource.data.delta) <= 100;
    }

    // 2. math.ceil() — round-up bound check.
    match /pricingAllow/{id} {
      allow create: if request.auth != null
        && math.ceil(request.resource.data.price) <= 100;
    }
    match /pricingDeny/{id} {
      allow create: if request.auth != null
        && math.ceil(request.resource.data.price) <= 100;
    }

    // 3. timestamp.date() — pure literal comparison, no request.time.
    match /datesAllow/{id} {
      allow create: if request.auth != null
        && timestamp.date(2099, 1, 1) > timestamp.date(2025, 1, 1);
    }
    match /datesDeny/{id} {
      allow create: if request.auth != null
        && timestamp.date(2025, 1, 1) > timestamp.date(2099, 1, 1);
    }

    // 4. duration.value() — pure duration comparison, no request.time.
    match /durAllow/{id} {
      allow create: if request.auth != null
        && duration.value(2, 'h') > duration.value(1, 'h');
    }
    match /durDeny/{id} {
      allow create: if request.auth != null
        && duration.value(1, 'h') > duration.value(2, 'h');
    }
  }
}`,
  cases: [
    // math.abs
    {
      description: 'math.abs(-75) <= 100 → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'scoresAllow/s1',
      auth: { uid: 'alice' },
      data: { delta: -75 },
    },
    {
      description: 'math.abs(200) <= 100 → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'scoresDeny/s2',
      auth: { uid: 'alice' },
      data: { delta: 200 },
    },

    // math.ceil
    {
      description: 'math.ceil(99.3) = 100 <= 100 → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pricingAllow/p1',
      auth: { uid: 'alice' },
      data: { price: 99.3 },
    },
    {
      description: 'math.ceil(100.1) = 101 <= 100 → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'pricingDeny/p2',
      auth: { uid: 'alice' },
      data: { price: 100.1 },
    },

    // timestamp.date — pure literal comparison
    {
      description: 'timestamp.date(2099,1,1) > timestamp.date(2025,1,1) → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'datesAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'timestamp.date(2025,1,1) > timestamp.date(2099,1,1) → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'datesDeny/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },

    // duration.value — pure duration comparison
    {
      description: "duration.value(2,'h') > duration.value(1,'h') → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'durAllow/u1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: "duration.value(1,'h') > duration.value(2,'h') → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'durDeny/u2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
  ],
};

// ─── Pack 2: string-literals-and-regex ────────────────────────────────────
// Targets Class B (matches-string-escape) — surfaced 2026-05-02 by
// email_domain_validation × gemma4:26b. Models writing `.matches('...\\.com')`
// expect production semantics: `\\` escapes to `\`, then `\.` is a literal-dot
// regex pattern. Pre-fix the simulator did not process string escapes, so
// `\\.` reached `new RegExp()` as `\\.` (literal backslash + any char) and
// silently denied every email-domain check.
//
// We restrict this pack to escape forms production *accepts* (`\\` and no
// escape). The lone-backslash forms `\.` and `@acme\.com` are syntax errors
// in production — those are tracked separately as Bug 2 in REBUILD_PLAN.md
// (sim accepts unknown escapes that prod rejects); they cannot be exercised
// here without making the entire pack throw at the prod call boundary.

const PACK_STRING_LITERALS_AND_REGEX: Pack = {
  id: 'string-literals-and-regex',
  fm: 'Class B',
  rationale: 'Pre-fix the simulator forwarded raw `\\\\.` to RegExp without unescaping; production-style `.matches(\'...\\\\.com\')` denied silently.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /escapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /escapedDeny/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /unescapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme.com');
    }
    match /tabReject/{id} {
      allow read: if !request.auth.token.name.matches('.*\\t.*');
    }
  }
}`,
  cases: [
    {
      description: "matches('.*@acme\\\\.com') vs alice@acme.com → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'escapedAllow/d1',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "matches('.*@acme\\\\.com') vs bob@other.com → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'escapedDeny/d2',
      auth: { uid: 'bob', token: { email: 'bob@other.com' } },
    },
    {
      description: "matches('.*@acme.com') vs alice@acme.com → ALLOW (no-escape control)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'unescapedAllow/d3',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "!matches('.*\\t.*') vs name without tab → ALLOW (tab escape literal)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'tabReject/d4',
      auth: { uid: 'alice', token: { name: 'Alice Smith' } },
    },
  ],
};

// ─── Pack 3: unsupported-feature-witness ──────────────────────────────────
// Targets Item 0.A — proves the SIM_NOT_SUPPORTED path in the harness.
// `hashing.crc32` is a real Firestore Rules built-in we have not yet
// implemented. Production evaluates it; the simulator must abstain
// (state: UNSUPPORTED) instead of silently denying. This pack is the
// regression gate for "did we forget to plumb UNSUPPORTED end-to-end?"

const PACK_UNSUPPORTED_FEATURE_WITNESS: Pack = {
  id: 'unsupported-feature-witness',
  fm: 'Item 0.A',
  rationale: 'Sim must report UNSUPPORTED (not silently DENY) when it hits a real built-in it has not implemented.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if hashing.crc32(request.auth.token.email).toBase64() != '';
    }
  }
}`,
  cases: [
    {
      description: 'hashing.crc32(...) — sim should ABSTAIN, prod should ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
  ],
};

// ─── Pack 4: cross-type-operator-overloads ────────────────────────────────
// Targets Item 2 of the rebuild plan — operator overloads in
// `evaluateBinaryOp` for Timestamp/Duration cross-type arithmetic. Pre-fix
// (before Item 1.2/1.3), the namespace constructors returned bare epoch-ms
// Numbers, so `Timestamp + Duration` was silent numeric add and the
// resulting "Timestamp" lost its type identity. Production evaluates the
// type-preserving cases natively. This pack proves the simulator now
// matches across all four cross-type arithmetic forms plus `<` `>`
// comparisons that depend on the wrappers' field-wise compareTo (not
// numeric coercion).

const PACK_CROSS_TYPE_OPERATOR_OVERLOADS: Pack = {
  id: 'cross-type-operator-overloads',
  fm: 'Item 2',
  rationale: 'Wrapper binaryOp must produce typed results for Timestamp/Duration cross-type ops; numeric coercion would silently lose type identity and (post-Risk 2 guard) silently DENY.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Timestamp + Duration → Timestamp
    match /tsPlusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(60000);
    }
    // Timestamp - Duration → Timestamp
    match /tsMinusDurAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - duration.value(60, 's') == timestamp.value(0);
    }
    // Timestamp - Timestamp → Duration
    match /tsMinusTsAllow/{id} {
      allow create: if request.auth != null
        && timestamp.value(60000) - timestamp.value(0) == duration.value(60, 's');
    }
    // Duration + Duration → Duration
    match /durPlusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(30, 's') + duration.value(30, 's') == duration.value(60, 's');
    }
    // Duration - Duration → Duration
    match /durMinusDurAllow/{id} {
      allow create: if request.auth != null
        && duration.value(60, 's') - duration.value(30, 's') == duration.value(30, 's');
    }
    // Timestamp comparison via field-wise compareTo (not numeric coercion)
    match /tsLessThanAllow/{id} {
      allow create: if request.auth != null
        && timestamp.date(2025, 1, 1) < timestamp.date(2099, 1, 1);
    }
    // DENY witness — wrong arithmetic should still fail
    match /tsPlusDurDeny/{id} {
      allow create: if request.auth != null
        && timestamp.value(0) + duration.value(60, 's') == timestamp.value(0);
    }
  }
}`,
  cases: [
    {
      description: 'Timestamp + Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsPlusDurAllow/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Duration → Timestamp ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusDurAllow/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp - Timestamp → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsMinusTsAllow/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration + Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durPlusDurAllow/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Duration - Duration → Duration ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'durMinusDurAllow/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'Timestamp < Timestamp via field compare ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'tsLessThanAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
    {
      description: 'wrong arithmetic — Timestamp + Duration ≠ original Timestamp DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'tsPlusDurDeny/d7',
      auth: { uid: 'alice' },
      data: { _: 1 },
    },
  ],
};

// ─── Pack 5: map-get-string-and-list-form ─────────────────────────────────
// Targets Item 3 of the rebuild plan — `Map.get(key, default)`, including
// list-form for nested traversal. Pre-fix the simulator threw
// UnsupportedError on `m.get(...)`, so every ALLOW case was a SIM_BUG via
// silent DENY. Production behavior was locked in by the 0.H parity probe:
// production *always* returns `default` on any walk failure (missing key,
// missing intermediate, non-map intermediate). It never returns null from
// a walk failure. This pack mirrors all 8 probe scenarios as a parity
// check against prod, plus a DENY witness for a present-key compare.

const PACK_MAP_GET_STRING_AND_LIST_FORM: Pack = {
  id: 'map-get-string-and-list-form',
  fm: 'Item 3',
  rationale: 'Sim must implement Map.get(key, default) including list-form nested traversal; pre-fix it threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Single-key form, key present → returns value
    match /singleKeyPresentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('a', 'DEF') == 'X';
    }
    // Single-key form, key absent → returns default
    match /singleKeyAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('z', 'DEF') == 'DEF';
    }
    // List-form, full path present → returns leaf
    match /listLeafPresentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b','c'], 'DEF') == 'X';
    }
    // List-form, leaf missing under existing parent → returns default
    match /listLeafAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b','z'], 'DEF') == 'DEF';
    }
    // List-form, intermediate missing → returns default
    match /listMidAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','z','c'], 'DEF') == 'DEF';
    }
    // List-form, top-level key missing → returns default
    match /listParentAbsentAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['z','b','c'], 'DEF') == 'DEF';
    }
    // List-form, intermediate is a string (cannot descend) → returns default
    match /listMidStringAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b'], 'DEF') == 'DEF';
    }
    // List-form, intermediate is an int (cannot descend) → returns default
    match /listMidIntAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get(['a','b'], 'DEF') == 'DEF';
    }
    // DENY witness — present-key compare against wrong value should fail
    match /singleKeyPresentDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.get('a', 'DEF') == 'WRONG';
    }
  }
}`,
  cases: [
    {
      description: 'single-key present → returns value ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'singleKeyPresentAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
    {
      description: 'single-key absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'singleKeyAbsentAllow/d2',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
    {
      description: 'list-form leaf present → returns leaf ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listLeafPresentAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form leaf absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listLeafAbsentAllow/d4',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form intermediate absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidAbsentAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form top-level absent → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listParentAbsentAllow/d6',
      auth: { uid: 'alice' },
      data: { m: { a: { b: { c: 'X' } } } },
    },
    {
      description: 'list-form intermediate is string → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidStringAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 'leaf-string' } },
    },
    {
      description: 'list-form intermediate is int → returns default ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidIntAllow/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 7 } },
    },
    {
      description: 'present-key compare against wrong value DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'singleKeyPresentDeny/d9',
      auth: { uid: 'alice' },
      data: { m: { a: 'X' } },
    },
  ],
};

// ─── Pack 6: range-slice-list-and-string ──────────────────────────────────
// Targets Item 4 of the rebuild plan — range slice `[i:j]` for List and
// String. Pre-fix the simulator threw a parse error on slice syntax (the
// grammar's `bracketAccess` only matched a single Expr). This pack
// exercises the documented surface: j-exclusive sub-list / substring,
// OOB clamping behavior, empty slice (i==j), and DENY witnesses.

const PACK_RANGE_SLICE_LIST_AND_STRING: Pack = {
  id: 'range-slice-list-and-string',
  fm: 'Item 4',
  rationale: 'Sim must parse and evaluate range slice [i:j] for List and String; pre-fix grammar rejected the syntax outright.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // List slice — mid range
    match /listMidAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:3].size() == 2;
    }
    // List slice — value at slice index
    match /listValueAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:3][0] == 'b';
    }
    // List slice — full length
    match /listFullAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[0:4].size() == 4;
    }
    // List slice — i==j → empty
    match /listEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[2:2].size() == 0;
    }
    // List slice — end OOB clamps
    match /listClampAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[1:99].size() == 3;
    }
    // String slice — substring
    match /strSubAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[6:11] == 'world';
    }
    // String slice — prefix
    match /strPrefAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[0:5] == 'hello';
    }
    // String slice — empty (i==j)
    match /strEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[3:3] == '';
    }
    // String slice — end OOB clamps
    match /strClampAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.s[6:99] == 'world';
    }
    // DENY witness — list slice with wrong expected size
    match /listSliceDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.arr[0:2].size() == 5;
    }
  }
}`,
  cases: [
    {
      description: 'list mid-slice → sub-list of size 2 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listMidAllow/d1',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list slice indexing → element at slice[0] ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listValueAllow/d2',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list full-length slice → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listFullAllow/d3',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list slice [i:i] → empty ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listEmptyAllow/d4',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'list slice end OOB clamps to length ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'listClampAllow/d5',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c', 'd'] },
    },
    {
      description: 'string mid-substring ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strSubAllow/d6',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'string prefix substring ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strPrefAllow/d7',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'string slice [i:i] → empty string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strEmptyAllow/d8',
      auth: { uid: 'alice' },
      data: { s: 'hello' },
    },
    {
      description: 'string slice end OOB clamps to length ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'strClampAllow/d9',
      auth: { uid: 'alice' },
      data: { s: 'hello world' },
    },
    {
      description: 'list slice with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'listSliceDeny/d10',
      auth: { uid: 'alice' },
      data: { arr: ['a', 'b', 'c'] },
    },
  ],
};

// ─── Pack 7: set-algebra-difference-union-intersection ────────────────────
// Targets Item 5.1 of the rebuild plan — Set.difference / union /
// intersection. Pre-fix the simulator only implemented hasOnly/hasAll/
// hasAny/size on FirestoreSet; the three set-algebra methods threw
// UnsupportedError. Sets are constructed via Map.keys() (the only
// public constructor) — pack chains through there.

const PACK_SET_ALGEBRA: Pack = {
  id: 'set-algebra-difference-union-intersection',
  fm: 'Item 5.1',
  rationale: 'Sim must implement Set.difference/union/intersection; pre-fix all three threw UnsupportedError on FirestoreSet.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // difference — items in this not in other (list arg)
    match /diffListAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a','b']).hasOnly(['c']);
    }
    // difference — Set arg via .keys()
    match /diffSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.keys().difference(request.resource.data.b.keys()).hasOnly(['x']);
    }
    // union — items in either
    match /unionAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c','d']).size() == 4;
    }
    // union — overlap dedupes
    match /unionDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['b','c']).size() == 3;
    }
    // intersection — items in both
    match /interAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['b','c','d']).hasOnly(['b','c']);
    }
    // intersection — empty when no overlap
    match /interEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['x','y']).size() == 0;
    }
    // chained: union then difference
    match /chainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c']).difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — wrong size after difference
    match /diffDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a']).size() == 99;
    }
  }
}`,
  cases: [
    {
      description: 'set difference (list arg) → hasOnly([c]) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'diffListAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set difference (set arg) → hasOnly([x]) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'diffSetAllow/d2',
      auth: { uid: 'alice' },
      data: { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    },
    {
      description: 'set union → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'unionAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set union dedupes overlap → size 3 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'unionDedupAllow/d4',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set intersection → hasOnly([b,c]) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'interAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set intersection no overlap → empty ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'interEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'chained union+difference → hasOnly([b,c]) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'chainAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'difference with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'diffDeny/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
  ],
};

// ─── Pack 8: list-methods-concat-removeall-toset ──────────────────────────
// Targets Item 5.2 of the rebuild plan — List.concat / removeAll / toSet.
// Pre-fix all three threw UnsupportedError. toSet bridges into Set.* (5.1)
// — a few cases chain through to verify the produced Set is fully usable.

const PACK_LIST_METHODS: Pack = {
  id: 'list-methods-concat-removeall-toset',
  fm: 'Item 5.2',
  rationale: 'Sim must implement List.concat/removeAll/toSet; pre-fix all three threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // concat — basic
    match /concatAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(request.resource.data.b).size() == 4;
    }
    // concat — preserves order
    match /concatOrderAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c'])[2] == 'c';
    }
    // concat — does NOT dedupe
    match /concatNoDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['a','b']).size() == 4;
    }
    // removeAll — basic
    match /removeAllAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — removes all matching occurrences
    match /removeAllManyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — empty arg → identity
    match /removeAllEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll([]).size() == 3;
    }
    // toSet — dedupes
    match /toSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().size() == 3;
    }
    // toSet — chains to Set.difference (5.1 + 5.2 wiring)
    match /toSetChainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — concat with wrong expected size
    match /concatDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c']).size() == 99;
    }
  }
}`,
  cases: [
    {
      description: 'list concat → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatAllow/d1',
      auth: { uid: 'alice' },
      data: { a: ['x', 'y'], b: ['p', 'q'] },
    },
    {
      description: 'list concat preserves order ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatOrderAllow/d2',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list concat does NOT dedupe ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatNoDedupAllow/d3',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list removeAll basic ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllAllow/d4',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list removeAll removes all occurrences ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllManyAllow/d5',
      auth: { uid: 'alice' },
      data: { a: ['b', 'a', 'b', 'c'] },
    },
    {
      description: 'list removeAll empty arg → identity ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list toSet dedupes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'toSetAllow/d7',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a', 'b'] },
    },
    {
      description: 'list toSet().difference chain (5.1 wiring) ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'toSetChainAllow/d8',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a'] },
    },
    {
      description: 'list concat with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'concatDeny/d9',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
  ],
};

// ─── Pack 9: bytes-toutf8-and-hashing ─────────────────────────────────────
// Targets Item 5.3 — Bytes wrapper + String.toUtf8() + hashing.*. Pre-fix:
// hashing.* threw UnsupportedError ('Unknown method on undefined' because
// `hashing` resolved to undefined), and String.toUtf8 threw UnsupportedError.
// Each case here exercises a wrapper-level invariant (size/round-trip) and
// a hash with a well-known reference value. Picked rules where the literal
// outputs are stable across runs (no random/time inputs).

const PACK_BYTES_AND_HASHING: Pack = {
  id: 'bytes-toutf8-and-hashing',
  fm: 'Item 5.3',
  rationale: 'Sim must implement Bytes + String.toUtf8() + hashing.{md5,sha256,crc32,crc32c}. Pre-fix: every reference hashing rule denied silently and toUtf8 threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // toUtf8 → Bytes, .size() returns byte count
    match /utf8SizeAllow/{id} {
      allow create: if request.auth != null
        && 'hello'.toUtf8().size() == 5;
    }
    // multi-byte UTF-8 length
    match /utf8MultibyteAllow/{id} {
      allow create: if request.auth != null
        && 'é'.toUtf8().size() == 2;
    }
    // toBase64 round-trip (no padding, URL-safe)
    match /base64Allow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toBase64() == 'aGk';
    }
    // toHexString round-trip
    match /hexAllow/{id} {
      allow create: if request.auth != null
        && 'hi'.toUtf8().toHexString() == '6869';
    }
    // is bytes
    match /isBytesAllow/{id} {
      allow create: if request.auth != null
        && 'x'.toUtf8() is bytes;
    }
    // md5 of empty string — well-known reference
    match /md5EmptyAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('').toHexString() == 'd41d8cd98f00b204e9800998ecf8427e';
    }
    // sha256 of 'abc' — NIST FIPS 180-4 reference
    match /sha256AbcAllow/{id} {
      allow create: if request.auth != null
        && hashing.sha256('abc').toHexString() == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    }
    // crc32 reference (IEEE 802.3, '123456789' → 0xCBF43926)
    match /crc32RefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32('123456789').toHexString() == 'cbf43926';
    }
    // crc32c reference (Castagnoli, '123456789' → 0xE3069283)
    match /crc32cRefAllow/{id} {
      allow create: if request.auth != null
        && hashing.crc32c('123456789').toHexString() == 'e3069283';
    }
    // hashing accepts pre-encoded Bytes too
    match /hashAcceptsBytesAllow/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello'.toUtf8()) == hashing.md5('hello');
    }
    // DENY witness — wrong digest
    match /md5WrongDeny/{id} {
      allow create: if request.auth != null
        && hashing.md5('hello').toHexString() == 'deadbeef';
    }
  }
}`,
  cases: [
    {
      description: "toUtf8().size() == 5 ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8SizeAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: "multi-byte UTF-8 size ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'utf8MultibyteAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toBase64 round-trip ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'base64Allow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'toHexString round-trip ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hexAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'is bytes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'isBytesAllow/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'md5 empty string ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'md5EmptyAllow/d6',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'sha256 abc ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'sha256AbcAllow/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32 IEEE 802.3 ref ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32RefAllow/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'crc32c Castagnoli ref ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'crc32cRefAllow/d9',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'hashing accepts Bytes input ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'hashAcceptsBytesAllow/d10',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong md5 digest DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'md5WrongDeny/d11',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
};

// ─── Pack 10: path-constructor-and-bind ───────────────────────────────────
// Targets Item 5.4 — Path wrapper + `path()` constructor + `Path.bind()`.
// Pre-fix: literal /foo/$(x) returned a plain string, so `is path` was
// false; `path("...")` threw UnsupportedError; `bind` had no dispatch.
// Each case here pins one wrapper invariant against prod.

const PACK_PATH_AND_BIND: Pack = {
  id: 'path-constructor-and-bind',
  fm: 'Item 5.4',
  rationale: 'Sim must implement Path wrapper, path() constructor, and Path.bind(). Pre-fix: pathLiteral returned string (so `is path` was false), path() threw UnsupportedError, bind had no dispatch.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // path literal is path
    match /literalIsPathAllow/{id} {
      allow create: if request.auth != null
        && /databases/$(database)/documents/users/alice is path;
    }
    // path() builtin returns Path
    match /constructorIsPathAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') is path;
    }
    // Path equality across two constructions
    match /pathEqAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') == path('users/alice');
    }
    // Path inequality
    match /pathNeqAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') != path('users/bob');
    }
    // Path is NOT string / NOT map (typeName specificity)
    match /pathSpecificityAllow/{id} {
      allow create: if request.auth != null
        && !(path('a/b') is string)
        && !(path('a/b') is map);
    }
    // Path.bind substitutes placeholder
    match /bindAllow/{id} {
      allow create: if request.auth != null
        && path('users/{uid}').bind({'uid': 'alice'}) == path('users/alice');
    }
    // Path numeric index
    match /pathIndexAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice')[1] == 'alice';
    }
    // path() idempotent on Path arg
    match /pathIdempotentAllow/{id} {
      allow create: if request.auth != null
        && path(path('users/alice')) == path('users/alice');
    }
    // DENY witness — wrong path equality
    match /wrongPathDeny/{id} {
      allow create: if request.auth != null
        && path('users/alice') == path('users/bob');
    }
  }
}`,
  cases: [
    {
      description: 'literal /foo/$(db)/... is path ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'literalIsPathAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: "path('users/alice') is path ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'constructorIsPathAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path equality ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathEqAllow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path inequality ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathNeqAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path is not string / not map ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathSpecificityAllow/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'Path.bind substitutes placeholder ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'bindAllow/d6',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'Path[1] returns segment ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathIndexAllow/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path() idempotent on Path arg ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathIdempotentAllow/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong path equality DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'wrongPathDeny/d9',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
};

// ─── Pack 11: globals-request-path-and-resource-id ────────────────────────
// Targets Item 6 — populates request.path / request.query / resource.id /
// resource.__name__. Pre-fix: all four were undefined; rules touching them
// silently denied. Each case asserts a wrapper invariant against prod so
// any divergence (e.g. prod uses a different path canonical form) shows up
// as SIM_BUG in the divergence accountant.

const PACK_GLOBALS: Pack = {
  id: 'globals-request-path-and-resource-id',
  fm: 'Item 6',
  rationale: 'Sim must populate request.path (Path), request.query (Map), resource.id (String), resource.__name__ (Path). Pre-fix: all undefined; rules using them silently denied.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // request.path is path
    match /reqPathIsPathAllow/{id} {
      allow create: if request.auth != null
        && request.path is path;
    }
    // request.path equality with literal
    match /reqPathEqAllow/{id} {
      allow create: if request.auth != null
        && request.path == /databases/$(database)/documents/reqPathEqAllow/$(id);
    }
    // request.query is map (empty for non-list)
    match /reqQueryAllow/{id} {
      allow create: if request.auth != null
        && request.query is map
        && request.query.size() == 0;
    }
    // resource.id on a CREATE: production makes resource null (the target
    // doc does not exist pre-write), so resource.id errors and it DENYs.
    match /resourceIdOnCreateDeny/{id} {
      allow create: if request.auth != null
        && resource.id == id
        && resource.id is string;
    }
    // resource.__name__ on a CREATE: same, resource is null pre-write, so
    // resource.__name__ errors and it DENYs.
    match /resourceNameOnCreateDeny/{id} {
      allow create: if request.auth != null
        && resource.__name__ == request.path
        && resource.__name__ is path;
    }
    // DENY witness — wrong resource.id
    match /resourceIdWrongDeny/{id} {
      allow create: if request.auth != null
        && resource.id == 'definitelyNotThisId';
    }
  }
}`,
  cases: [
    {
      description: 'request.path is path ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqPathIsPathAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'request.path equals literal ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqPathEqAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'request.query empty map ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqQueryAllow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      // On a create the target doc does not exist yet, so `resource` is
      // null and `resource.id` errors → DENY. (Was mis-stated as ALLOW; the
      // sim previously synthesized a resource identity — a false-allow.)
      description: 'resource.id on create → DENY (resource is null pre-write)',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceIdOnCreateDeny/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      // Same as above for __name__: `resource` is null on create → DENY.
      description: 'resource.__name__ on create → DENY (resource is null pre-write)',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceNameOnCreateDeny/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong resource.id DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceIdWrongDeny/d6',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
};

// ─── Pack 12: get-after-and-exists-after ──────────────────────────────────
// Targets Item 7 — getAfter()/existsAfter() with projectAfterState. Pre-fix:
// both threw UnsupportedError. The 0.D trap (top-level update REPLACES
// nested map) only shows up in prod when the agent makes an `update` write
// with a partial nested map; this pack pins the projection against prod
// for create + delete (the writeMode-free defaults) so the basic surface
// is locked in. The recursive merge / dot-path semantics are unit-tested
// in projectAfterState (no prod equivalent: the prod Test API doesn't
// expose writeMode either, but it computes the same projection internally
// from the Test request shape).

const PACK_GET_AFTER: Pack = {
  id: 'get-after-and-exists-after',
  fm: 'Item 7',
  rationale: 'Sim must implement getAfter()/existsAfter(). Pre-fix: both threw UnsupportedError; rules using them silently denied.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // getAfter on request target == request.resource.data
    match /getAfterTargetAllow/{id} {
      allow create: if request.auth != null
        && getAfter(request.path).data.x == request.resource.data.x;
    }
    // existsAfter on create is true
    match /existsAfterCreateAllow/{id} {
      allow create: if request.auth != null
        && existsAfter(request.path) == true;
    }
    // existsAfter on delete is false
    match /existsAfterDeleteAllow/{id} {
      allow delete: if request.auth != null
        && existsAfter(request.path) == false;
    }
    // existsAfter on unrelated mocked path uses exists()
    match /existsAfterMockAllow/{id} {
      allow create: if request.auth != null
        && existsAfter(/databases/$(database)/documents/other/x) == true;
    }
    // DENY witness — wrong existsAfter
    match /existsAfterWrongDeny/{id} {
      allow create: if request.auth != null
        && existsAfter(request.path) == false;
    }
  }
}`,
  cases: [
    {
      description: 'getAfter target == request.resource.data ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'getAfterTargetAllow/d1',
      auth: { uid: 'alice' },
      data: { x: 'value' },
    },
    {
      description: 'existsAfter create true ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'existsAfterCreateAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'existsAfter delete false ALLOW',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'existsAfterDeleteAllow/d3',
      auth: { uid: 'alice' },
      resource: { x: 'gone' },
    },
    {
      description: 'existsAfter unrelated mocked path ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'existsAfterMockAllow/d4',
      auth: { uid: 'alice' },
      data: {},
      functionMocks: [
        { function: 'exists', path: 'other/x', result: true },
      ],
    },
    {
      description: 'wrong existsAfter on create DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'existsAfterWrongDeny/d5',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
};

/** The 12 production-parity stress packs, in original source order. */
export const STRESS_PACKS: Pack[] = [
  PACK_BUILTINS_TIME_AND_MATH,
  PACK_STRING_LITERALS_AND_REGEX,
  PACK_UNSUPPORTED_FEATURE_WITNESS,
  PACK_CROSS_TYPE_OPERATOR_OVERLOADS,
  PACK_MAP_GET_STRING_AND_LIST_FORM,
  PACK_RANGE_SLICE_LIST_AND_STRING,
  PACK_SET_ALGEBRA,
  PACK_LIST_METHODS,
  PACK_BYTES_AND_HASHING,
  PACK_PATH_AND_BIND,
  PACK_GLOBALS,
  PACK_GET_AFTER,
];
