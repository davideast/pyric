/**
 * ─── Pack 6: get-missing-doc (RULES-B8) ───────────────────────────────────
 * Production: get() of a non-existent document is a runtime error (→ deny),
 * NOT a silent null; and the resource a successful get() returns carries
 * `id` and `__name__` alongside `data`. Pre-fix the simulator returned null
 * for missing docs and a bare `{data}` for present ones. In the Rules Test
 * API "missing" = not provided via functionMocks; "present" = mocked.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
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
    // mocked doc: production CANNOT express resource identity (.id) via a
    // function mock — the API returns "Property id is undefined on
    // object." → DENY. Kept as a documented witness of the limitation.
    match /getResourceIdAllow/{id} {
      allow create: if get(/databases/$(database)/documents/cfg/site).id == 'site';
    }
    // mocked doc: same limitation for __name__ — a mocked get() result has
    // no resource identity attached, so this also errors → DENY.
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
      // Production cannot express resource identity (.id) through a
      // function mock: get(mocked).id errors with "Property id is
      // undefined on object." → DENY. This case documents that API
      // limitation rather than testing an achievable ALLOW.
      description: "get(mocked).id == 'site' → DENY (mocked get() has no resource identity in production)",
      expectation: 'DENY',
      method: 'create',
      path: 'getResourceIdAllow/d6',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'cfg/site', result: { flag: true } },
      ],
    },
    {
      // Same limitation as above, for __name__.
      description: 'get(mocked).__name__ == path literal → DENY (mocked get() has no resource identity in production)',
      expectation: 'DENY',
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
  group: 'fix-class',
};
