/**
 * ─── Scenario: ternary-and-error-absorption ──────────────────────────────────
 * The ternary operator `?:` — newly parseable and evaluable in storage rules
 * (PR #333 / issue #150). Both branch selections, plus the error-semantics
 * corners the Firestore engine already pinned (rules-firestore-int-float-and-
 * division): an erroring ternary CONDITION errors the whole expression (DENY,
 * even when both branches are `true`), and `error || true` absorbs to ALLOW.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: ternary ?:, error-in-condition, || absorption',
  rationale:
    'Ternary must select by condition; an erroring condition denies even with identical branches; error || true absorbs to allow — mirrors captured Firestore engine truth.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /ternary/{fileId} {
      // branch selection by auth state
      allow read: if request.auth != null ? fileId == 'ok.txt' : false;
      // erroring condition (div by zero) → expression errors → DENY,
      // even though BOTH branches are true
      allow update: if (request.resource.size / 0 == 0) ? true : true;
      // the same error absorbed by || → ALLOW
      allow delete: if ((1 / 0 == 0) ? true : true) || true;
    }
  }
}`,
  cases: [
    {
      description: 'authed read, true-branch condition holds → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'ternary/ok.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: 'authed read, true-branch condition fails → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'ternary/other.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
    {
      description: 'anonymous read takes false branch → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'ternary/ok.txt',
      existingResource: { size: 100 },
    },
    {
      description: 'erroring ternary condition denies despite true branches → DENY',
      expectation: 'DENY',
      method: 'update',
      path: 'ternary/ok.txt',
      auth: { uid: 'alice' },
      resource: { size: 100, contentType: 'text/plain' },
      existingResource: { size: 100 },
    },
    {
      description: 'erroring ternary absorbed by || true → ALLOW',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'ternary/ok.txt',
      auth: { uid: 'alice' },
      existingResource: { size: 100 },
    },
  ],
};
