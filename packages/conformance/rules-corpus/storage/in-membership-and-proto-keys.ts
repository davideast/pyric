/**
 * ─── Scenario: in-membership-and-proto-keys ──────────────────────────────────
 * The `in` operator — newly evaluable in storage rules (PR #333 / #150) — on
 * list literals and on maps (custom metadata plus map literals), INCLUDING the
 * prototype-chain adversarial cases the Firestore engine already pinned
 * (rules-firestore-prototype-chain-keys): production maps expose OWN keys
 * only, so `'toString' in map` is false unless the map literally carries a
 * `toString` key. A JS-`in`-backed evaluator false-ALLOWs these.
 *
 * The negated membership cases separate an error from false, with the same
 * text Firestore reports: `in` over null is `Null value error.`, `in` over a
 * string, int, float, bool, timestamp, path or map diff is `Function not found
 * error: Name: [in].`, and an int key into a map is `Unsupported operation
 * error. Received: map.in(int). Expected: map.in(string).`. Each error denies,
 * so its negation denies too.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: in (list, map keys), prototype-key adversarial',
  rationale:
    "`in` must test list membership and OWN map keys only — 'toString'/'constructor'/'hasOwnProperty' in a metadata map or map literal must be false, matching captured Firestore engine truth.",
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /inlist/{fileId} {
      allow create: if request.resource.contentType in ['image/png', 'image/jpeg'];
    }
    match /inmap/{fileId} {
      allow create: if 'owner' in request.resource.metadata;
    }
    // proto method name is NOT a key → false → DENY
    match /protodeny/{fileId} {
      allow create: if 'toString' in request.resource.metadata;
    }
    // negated forms over all three classic prototype names → ALLOW
    match /protonot/{fileId} {
      allow create: if !('toString' in request.resource.metadata)
        && !('constructor' in request.resource.metadata)
        && !('hasOwnProperty' in request.resource.metadata);
    }
    // a REAL metadata key named toString IS a key → ALLOW
    match /realkey/{fileId} {
      allow create: if 'toString' in request.resource.metadata
        && request.resource.metadata.toString == 'present';
    }
    // map literals behave identically: own keys in, proto keys out
    match /literalmap/{fileId} {
      allow create: if 'a' in {'a': 1, 'b': 2} && !('toString' in {'a': 1});
    }
    // negated membership over a value that is not a collection → error → DENY
    match /notinnull/{fileId} {
      allow create: if !('a' in request.resource.metadata.get('missing', null));
    }
    match /notinstring/{fileId} {
      allow create: if !('a' in request.resource.contentType);
    }
    match /notinint/{fileId} {
      allow create: if !('a' in request.resource.size);
    }
    match /notinfloat/{fileId} {
      allow create: if !('a' in float(request.resource.size));
    }
    match /notinbool/{fileId} {
      allow create: if !('a' in (request.resource.size > 0));
    }
    // negated int key into a map → error → DENY
    match /intkeynotinmap/{fileId} {
      allow create: if !(1 in request.resource.metadata);
    }
    // negated membership over a timestamp, a path or a map diff → error → DENY
    match /notintimestamp/{fileId} {
      allow create: if !('a' in request.time);
    }
    match /notinpath/{fileId} {
      allow create: if !('a' in request.path);
    }
    match /notinmapdiff/{fileId} {
      allow create: if !('a' in request.resource.metadata.diff({}));
    }
  }
}`,
  cases: [
    {
      description: 'contentType in list literal (member) → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'inlist/photo.png',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'image/png' },
    },
    {
      description: 'contentType in list literal (non-member) → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'inlist/notes.txt',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'text/plain' },
    },
    {
      description: "'owner' in metadata (key present) → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'inmap/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { owner: 'alice' } },
    },
    {
      description: "'owner' in metadata (key absent) → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'inmap/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { other: 'x' } },
    },
    {
      description: "'toString' in metadata (no such key) → DENY",
      expectation: 'DENY',
      method: 'create',
      path: 'protodeny/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { name: 'alice' } },
    },
    {
      description: 'no proto names leak into `in` → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'protonot/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { name: 'alice' } },
    },
    {
      description: "literal metadata key named 'toString' IS a key → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'realkey/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { toString: 'present' } },
    },
    {
      description: 'map literal: own key in, proto key out → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'literalmap/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf' },
    },
    ...([
      ["!('a' in null) is a null value error → DENY", 'notinnull'],
      ["!('a' in contentType) is a function not found error → DENY", 'notinstring'],
      ["!('a' in size) is a function not found error → DENY", 'notinint'],
      ["!('a' in float(size)) is a function not found error → DENY", 'notinfloat'],
      ["!('a' in (size > 0)) is a function not found error → DENY", 'notinbool'],
      ["!(1 in metadata) is an unsupported operation error → DENY", 'intkeynotinmap'],
      ["!('a' in request.time) is an error → DENY", 'notintimestamp'],
      ["!('a' in request.path) is an error → DENY", 'notinpath'],
      ["!('a' in a map diff) is an error → DENY", 'notinmapdiff'],
    ] as const).map(([description, match]) => ({
      description,
      expectation: 'DENY' as const,
      method: 'create' as const,
      path: `${match}/doc.pdf`,
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'application/pdf', metadata: { a: 'x' } },
      requestTime: '2025-06-15T00:00:00Z',
    })),
  ],
};
