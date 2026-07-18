/**
 * ─── Scenario: list-map-literals-and-slice ───────────────────────────────────
 * List/map literals and range-slice access `[i:j]` — newly evaluable in
 * storage rules (PR #333 / #150). Mirrors the slice truth the Firestore
 * engine already pinned (rules-firestore-range-slice-list-and-string):
 * mid-slices on lists AND strings work, but an out-of-bounds slice END
 * ERRORS (→ DENY) — it does NOT clamp to length the way JS `.slice()` does.
 */
import type { StorageScenarioRecord } from './types.ts';

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
  ],
};
