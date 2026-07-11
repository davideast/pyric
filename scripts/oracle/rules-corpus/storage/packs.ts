/**
 * Storage rules conformance corpus — packs.
 *
 * One pack per feature area of the MERGED storage evaluator
 * (packages/pyric/src/storage/rules.ts): umbrella-vs-granular verbs,
 * user-defined functions (let + scoping), request.time / timestamp
 * constructors, string.matches(), custom-metadata access, cross-service
 * firestore.get()/exists(), plus a witness pack for the still-unsupported
 * resource.timeCreated / resource.updated fields.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ EXPECTATIONS ARE UNVERIFIED UNTIL CAPTURE.                               │
 * │                                                                         │
 * │ Every case's `expectation` is a BEST-KNOWN production truth, written    │
 * │ from the evaluator's documented behavior and the live-probed facts      │
 * │ about the Storage Rules Test API. It is NOT ground truth yet. The       │
 * │ capture run (scripts/oracle/run-rules-storage.ts, credentialed) posts   │
 * │ each pack to the PRODUCTION endpoint; that verdict is the source of     │
 * │ truth. A capture that disagrees with an `expectation` here flags a BAD  │
 * │ PACK (wrong rule, wrong case, or a wrong belief about production) — fix  │
 * │ the pack before drawing any conclusion. Do not treat these values as    │
 * │ settled.                                                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Rulesets are kept COMPILE-VALID for production on purpose: an invalid
 * ruleset makes the Rules Test API return `issues` with no results, which
 * aborts the whole capture. Constructs the evaluator guards against but
 * production rejects at COMPILE time (recursion / depth-cap, undefined-function
 * calls, duplicate function names) are therefore left to the evaluator's unit
 * tests, NOT the oracle — they cannot be captured as a clean production
 * verdict. What IS captured here is every runtime-observable behavior.
 */
import type { StoragePack } from './types.ts';

// ─── Pack 1: verbs-umbrella-granular ────────────────────────────────────────
// The stale storage matrix (#96/#104) claims granular verbs are unsupported.
// This pack proves the evaluator's read→{get,list} / write→{create,update,
// delete} expansion, granular single-verb grants, comma-separated verbs,
// per-verb deny-by-default, and create-vs-update keyed on object existence.
const VERBS_PACK: StoragePack = {
  id: 'verbs-umbrella-granular',
  fm: 'STORAGE-VERBS',
  rationale:
    'Umbrella read/write expansion, granular verb grants, comma-separated verbs, per-verb default-deny, and create-vs-update on resource existence.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /readonly/{fileId} {
      allow read: if true;
    }
    match /writeonly/{fileId} {
      allow write: if true;
    }
    match /getonly/{fileId} {
      allow get: if true;
    }
    match /pair/{fileId} {
      allow get, delete: if true;
    }
    match /existence/{fileId} {
      allow create: if resource == null;
      allow update: if resource != null;
    }
  }
}`,
  cases: [
    // read → get + list
    { description: 'read grant covers get', expectation: 'ALLOW', method: 'get', path: 'readonly/a.txt' },
    { description: 'read grant covers list', expectation: 'ALLOW', method: 'list', path: 'readonly/a.txt' },
    { description: 'read grant denies create (no write grant)', expectation: 'DENY', method: 'create', path: 'readonly/a.txt', resource: { size: 1024, contentType: 'text/plain' } },
    { description: 'read grant denies delete', expectation: 'DENY', method: 'delete', path: 'readonly/a.txt', existingResource: { size: 1024 } },
    // write → create + update + delete
    { description: 'write grant covers create', expectation: 'ALLOW', method: 'create', path: 'writeonly/b.png', resource: { size: 2048, contentType: 'image/png' } },
    { description: 'write grant covers update', expectation: 'ALLOW', method: 'update', path: 'writeonly/b.png', resource: { size: 2048, contentType: 'image/png' }, existingResource: { size: 1000 } },
    { description: 'write grant covers delete', expectation: 'ALLOW', method: 'delete', path: 'writeonly/b.png', existingResource: { size: 1000 } },
    { description: 'write grant denies get', expectation: 'DENY', method: 'get', path: 'writeonly/b.png', existingResource: { size: 1000 } },
    // granular single verb
    { description: 'get grant covers get', expectation: 'ALLOW', method: 'get', path: 'getonly/c.txt', existingResource: { size: 5 } },
    { description: 'get grant denies list (get is not read)', expectation: 'DENY', method: 'list', path: 'getonly/c.txt' },
    // comma-separated verbs
    { description: 'comma verbs grant get', expectation: 'ALLOW', method: 'get', path: 'pair/d.txt', existingResource: { size: 5 } },
    { description: 'comma verbs grant delete', expectation: 'ALLOW', method: 'delete', path: 'pair/d.txt', existingResource: { size: 5 } },
    { description: 'comma verbs deny create (not listed)', expectation: 'DENY', method: 'create', path: 'pair/d.txt', resource: { size: 5, contentType: 'text/plain' } },
    // create-vs-update keyed on existence
    // KNOWN DIVERGENCE (pinned in test/storage/rules-oracle-conformance.test.ts
    // KNOWN_DIVERGENCES, issue #134): the capture disagrees with this
    // `expectation`. Production throws a "Null value error" referencing
    // `resource` on a create where no object exists yet (live-probed with
    // both an omitted resource field and an explicit null — identical
    // result), and denies, instead of evaluating `resource == null` as
    // documented. The evaluator models resource as null on create and
    // allows, matching the documented semantics. Left as `expectation:
    // 'ALLOW'` — the pre-capture belief this pack was written from — per the
    // Firestore stress-pack convention of not rewriting expectations after
    // a divergence is captured and pinned.
    { description: 'create allowed when object does not exist (resource == null)', expectation: 'ALLOW', method: 'create', path: 'existence/e.txt', resource: { size: 10, contentType: 'text/plain' }, existingResource: null },
    { description: 'update allowed when object exists (resource != null)', expectation: 'ALLOW', method: 'update', path: 'existence/e.txt', resource: { size: 20, contentType: 'text/plain' }, existingResource: { size: 10 } },
    { description: 'create denied when object already exists (create rule requires resource == null)', expectation: 'DENY', method: 'create', path: 'existence/e.txt', resource: { size: 20, contentType: 'text/plain' }, existingResource: { size: 10 } },
  ],
};

// ─── Pack 2: functions-let-scope ────────────────────────────────────────────
// #96/#104 also claim user-defined functions are unsupported. This proves
// `let` bindings, functions calling functions, and match-block-scoped helper
// functions (lexical scoping). Same-name shadowing and undefined-function
// calls are deliberately omitted: production rejects those at compile, so they
// cannot be captured as a clean verdict (they live in the evaluator unit tests).
const FUNCTIONS_PACK: StoragePack = {
  id: 'functions-let-scope',
  fm: 'STORAGE-FUNC',
  rationale:
    'User-defined functions with let bindings, functions calling functions, and a match-block-scoped helper — the evaluator surface #96/#104 wrongly call unsupported.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function sizeUnder(limitMb) {
      let mb = 1024 * 1024;
      return request.resource.size < limitMb * mb;
    }
    function isImage() {
      return request.resource.contentType == 'image/png';
    }
    function allowedUpload() {
      return sizeUnder(5) && isImage();
    }
    match /uploads/{fileId} {
      allow create: if allowedUpload();
    }
    match /scoped/{fileId} {
      function tooBig() {
        return request.resource.size > 1024;
      }
      allow create: if !tooBig();
    }
  }
}`,
  cases: [
    { description: 'let + nested calls: small png under 5MB', expectation: 'ALLOW', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/png' } },
    { description: 'let + nested calls: oversized png denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 10485760, contentType: 'image/png' } },
    { description: 'nested call isImage(): wrong content type denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/jpeg' } },
    { description: 'block-scoped helper tooBig(): small file allowed', expectation: 'ALLOW', method: 'create', path: 'scoped/b.bin', resource: { size: 500, contentType: 'application/octet-stream' } },
    { description: 'block-scoped helper tooBig(): large file denied', expectation: 'DENY', method: 'create', path: 'scoped/b.bin', resource: { size: 5000, contentType: 'application/octet-stream' } },
  ],
};

// ─── Pack 3: request-time-timestamp ─────────────────────────────────────────
// request.time compared against the timestamp constructors timestamp.date()
// (UTC midnight) and timestamp.value() (epoch millis). #96/#104 mark time
// unsupported.
const TIME_PACK: StoragePack = {
  id: 'request-time-timestamp',
  fm: 'STORAGE-TIME',
  rationale:
    'request.time compared against timestamp.date(y,m,d) and timestamp.value(ms) — the time surface #96/#104 wrongly call unsupported.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /deadline/{fileId} {
      allow create: if request.time < timestamp.date(2030, 1, 1);
    }
    match /epoch/{fileId} {
      allow create: if request.time > timestamp.value(1000000000000);
    }
  }
}`,
  cases: [
    { description: 'timestamp.date(): before deadline allowed', expectation: 'ALLOW', method: 'create', path: 'deadline/a.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2025-06-01T00:00:00Z' },
    { description: 'timestamp.date(): after deadline denied', expectation: 'DENY', method: 'create', path: 'deadline/a.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2035-06-01T00:00:00Z' },
    { description: 'timestamp.value(): after epoch bound allowed', expectation: 'ALLOW', method: 'create', path: 'epoch/b.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2025-06-01T00:00:00Z' },
    { description: 'timestamp.value(): before epoch bound denied', expectation: 'DENY', method: 'create', path: 'epoch/b.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '1990-01-01T00:00:00Z' },
  ],
};

// ─── Pack 4: matches-regex ──────────────────────────────────────────────────
// string.matches() — whole-string anchoring (a partial match denies) and RE2
// inexpressibility (a lookaround pattern production's RE2 rejects → deny).
const MATCHES_PACK: StoragePack = {
  id: 'matches-regex',
  fm: 'STORAGE-MATCHES',
  rationale:
    'string.matches() whole-string anchoring: a partial match denies. (RE2-inexpressible patterns are rejected at ruleset compile time by production, so they are covered by evaluator unit tests, not oracle capture.)',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /typed/{fileId} {
      allow create: if request.resource.contentType.matches('image/.*');
    }
  }
}`,
  cases: [
    { description: 'matches whole string: image/png accepted', expectation: 'ALLOW', method: 'create', path: 'typed/a.png', resource: { size: 100, contentType: 'image/png' } },
    { description: 'matches whole string: text/plain rejected', expectation: 'DENY', method: 'create', path: 'typed/a.txt', resource: { size: 100, contentType: 'text/plain' } },
    { description: 'anchoring: leading-prefixed ximage/png rejected (not a partial match)', expectation: 'DENY', method: 'create', path: 'typed/a.png', resource: { size: 100, contentType: 'ximage/png' } },
  ],
};

// ─── Pack 5: metadata-access ────────────────────────────────────────────────
// Custom metadata in BOTH dotted (resource.metadata.owner) and bracket
// (resource.metadata['owner']) form — they must resolve identically — and a
// missing key (undefined → deny).
const METADATA_PACK: StoragePack = {
  id: 'metadata-access',
  fm: 'STORAGE-META',
  rationale:
    'resource.metadata custom-metadata access in dotted and bracket form (identical resolution) and missing-key deny.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /dotted/{fileId} {
      allow get: if resource.metadata.owner == request.auth.uid;
    }
    match /bracket/{fileId} {
      allow get: if resource.metadata['owner'] == request.auth.uid;
    }
  }
}`,
  cases: [
    { description: 'dotted metadata: owner matches → allow', expectation: 'ALLOW', method: 'get', path: 'dotted/a.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'dotted metadata: owner mismatch → deny', expectation: 'DENY', method: 'get', path: 'dotted/a.txt', auth: { uid: 'bob' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'dotted metadata: missing owner key → deny', expectation: 'DENY', method: 'get', path: 'dotted/a.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: {} } },
    { description: 'bracket metadata: owner matches → allow', expectation: 'ALLOW', method: 'get', path: 'bracket/b.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'bracket metadata: owner mismatch → deny', expectation: 'DENY', method: 'get', path: 'bracket/b.txt', auth: { uid: 'bob' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
  ],
};

// ─── Pack 6: firestore-lookup ───────────────────────────────────────────────
// Cross-service firestore.get()/exists() with $(expr) path interpolation
// (path param and request.auth.uid). Mocks use the QUALIFIED firestore.get /
// firestore.exists names; exists() mock is a bool.
const FIRESTORE_LOOKUP_PACK: StoragePack = {
  id: 'firestore-lookup',
  fm: 'STORAGE-XSVC',
  rationale:
    'firestore.get()/exists() cross-service lookups with $(expr) interpolation, qualified function-mock names, and bool exists() results.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /profiles/{userId}/{fileId} {
      allow get: if firestore.get(/databases/(default)/documents/users/$(userId)).data.uid == request.auth.uid;
      allow create: if firestore.exists(/databases/(default)/documents/members/$(request.auth.uid));
    }
  }
}`,
  cases: [
    {
      description: 'firestore.get(): profile uid matches caller → allow',
      expectation: 'ALLOW', method: 'get', path: 'profiles/alice/avatar.png', auth: { uid: 'alice' }, existingResource: { size: 100 },
      functionMocks: [{ function: 'get', path: 'users/alice', result: { uid: 'alice' } }],
    },
    {
      description: 'firestore.get(): profile uid mismatch → deny',
      expectation: 'DENY', method: 'get', path: 'profiles/alice/avatar.png', auth: { uid: 'bob' }, existingResource: { size: 100 },
      functionMocks: [{ function: 'get', path: 'users/alice', result: { uid: 'alice' } }],
    },
    {
      description: 'firestore.exists(): membership present → allow create',
      expectation: 'ALLOW', method: 'create', path: 'profiles/alice/avatar.png', auth: { uid: 'alice' }, resource: { size: 100, contentType: 'image/png' },
      functionMocks: [{ function: 'exists', path: 'members/alice', result: true }],
    },
    {
      description: 'firestore.exists(): membership absent → deny create',
      expectation: 'DENY', method: 'create', path: 'profiles/bob/avatar.png', auth: { uid: 'bob' }, resource: { size: 100, contentType: 'image/png' },
      functionMocks: [{ function: 'exists', path: 'members/bob', result: false }],
    },
  ],
};

// ─── Pack 7: resource-timestamp-witness (KNOWN GAP) ─────────────────────────
// The evaluator's resource model carries only size/contentType/metadata, so
// resource.timeCreated / resource.updated read `undefined` and any comparison
// DENIES in-process, while production evaluates a real server timestamp. These
// cases are the witness for that gap: their `knownGap` marker tells the replay
// suite to RECORD but NOT ASSERT the evaluator verdict (mirroring how the
// Firestore replay skips its simulator's UNSUPPORTED abstentions). The
// `expectation` is production's expected verdict, and stays UNVERIFIED until
// capture confirms it — at which point this pack is the evidence the field is
// still unsupported in the evaluator.
const TIMESTAMP_WITNESS_PACK: StoragePack = {
  id: 'resource-timestamp-witness',
  fm: 'STORAGE-RES-TS',
  rationale:
    'Witness: resource.timeCreated / resource.updated are production Storage fields the evaluator does not model (reads undefined → deny) — records the known gap.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /created/{fileId} {
      allow get: if resource.timeCreated < request.time;
    }
    match /updated/{fileId} {
      allow get: if resource.updated < request.time;
    }
  }
}`,
  cases: [
    {
      description: 'resource.timeCreated < request.time (prod: real timestamp)',
      expectation: 'ALLOW', method: 'get', path: 'created/a.txt', existingResource: { size: 10 }, requestTime: '2025-06-01T00:00:00Z',
      knownGap: 'resource.timeCreated is not modeled by the evaluator (reads undefined → deny)',
    },
    {
      description: 'resource.updated < request.time (prod: real timestamp)',
      expectation: 'ALLOW', method: 'get', path: 'updated/b.txt', existingResource: { size: 10 }, requestTime: '2025-06-01T00:00:00Z',
      knownGap: 'resource.updated is not modeled by the evaluator (reads undefined → deny)',
    },
  ],
};

/** Every Storage rules pack in the corpus, in a stable order. */
export const STORAGE_PACKS: StoragePack[] = [
  VERBS_PACK,
  FUNCTIONS_PACK,
  TIME_PACK,
  MATCHES_PACK,
  METADATA_PACK,
  FIRESTORE_LOOKUP_PACK,
  TIMESTAMP_WITNESS_PACK,
];
