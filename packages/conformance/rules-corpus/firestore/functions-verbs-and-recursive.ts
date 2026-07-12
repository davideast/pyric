/**
 * ─── Scenario: functions-verbs-and-recursive ──────────────────────────────────
 * The rule-structure surface: user-defined `function` declarations with `let`
 * bindings, the granular `allow get` / `allow list` / `allow update` /
 * `allow write` verbs, the ternary operator, and a recursive `{document=**}`
 * wildcard match. A role-gated `docs` collection plus a public recursive
 * subtree — the structural constructs a real ruleset is built from.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: functions/let, granular verbs, ternary, recursive wildcard',
  rationale:
    'Production must accept function declarations with let bindings, allow get/list/update/write verbs, the ternary operator, and a recursive {document=**} match.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }
    function roleLevel() {
      let base = isSignedIn() ? 1 : 0;
      let boosted = base * 2;
      return boosted;
    }
    match /docs/{docId} {
      allow get: if isSignedIn();
      allow list: if isSignedIn() && roleLevel() >= 2;
      allow update: if isSignedIn() && roleLevel() >= 2;
      allow write: if isSignedIn() && roleLevel() >= 2;
    }
    match /trees/{treeId}/{document=**} {
      allow read: if isSignedIn();
    }
  }
}`,
  cases: [
    {
      description: 'signed-in get ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice' },
      resource: { title: 'X' },
    },
    {
      description: 'anonymous get DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      auth: null,
      resource: { title: 'X' },
    },
    {
      description: 'signed-in list with roleLevel 2 ALLOW (let + ternary + mul)',
      expectation: 'ALLOW',
      method: 'list',
      path: 'docs/d1',
      auth: { uid: 'alice' },
    },
    {
      description: 'signed-in update with roleLevel 2 ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'docs/d2',
      auth: { uid: 'alice' },
      resource: { title: 'Old' },
      data: { title: 'New' },
    },
    {
      description: 'signed-in create covered by write grant ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'docs/d3',
      auth: { uid: 'alice' },
      data: { title: 'New' },
    },
    {
      description: 'recursive subtree read when signed-in ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'trees/t1/a/b/c',
      auth: { uid: 'alice' },
      resource: { leaf: true },
    },
    {
      description: 'recursive subtree read denied when anonymous DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'trees/t1/a/b/c',
      auth: null,
      resource: { leaf: true },
    },
  ],
  group: 'stress',
};
