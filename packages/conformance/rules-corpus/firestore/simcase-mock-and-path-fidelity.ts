/**
 * ─── simcase-mock-and-path-fidelity (#1058 PR 3) ─────────────────────────────
 * Production verdicts for the test-case surface `simulate()` models:
 *
 * - FS-CON-6 / FS-COV-6a / FS-MET-6b (functionMocks). In the Rules Test API,
 *   `get` and `exists` are separate service functions, each mocked by its own
 *   `FunctionMock`. An `exists` mock says nothing about `get`, and mock order
 *   has no meaning. Mock args are normalized document names, so `'/users/x'`
 *   and `'users/x'` name the same mock (`buildFunctionMock` →
 *   `normalizeDocPath`).
 * - FS-COV-6b (list widening). A sibling `{document=**}` deny does not revoke
 *   a `match /menuItems/{id}` list grant: production ORs every matching block.
 *   This is the document-path form the Test API evaluates. The simulator's
 *   collection-path convenience form must agree with it.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'FS-CON-6',
  rationale: 'functionMocks are per-function and order-free; a sibling recursive deny cannot revoke a list grant.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // exists() mocked true, get() NOT mocked: get() must not see a fabricated doc
    match /existsMockOnlyGet/{id} {
      allow create: if get(/databases/$(database)/documents/other/x).data.size() == 0;
    }
    // exists() mocked false alongside a get() mock: exists() returns the exists mock
    match /existsFalseWithGet/{id} {
      allow create: if !exists(/databases/$(database)/documents/users/alice);
    }
    // both mocks for one path: each function reads its own mock, in any order
    match /bothMocks/{id} {
      allow create: if exists(/databases/$(database)/documents/users/alice)
        && get(/databases/$(database)/documents/users/alice).data.role == 'admin';
    }
    // a mock path with a leading slash names the same document
    match /slashMockPath/{id} {
      allow create: if exists(/databases/$(database)/documents/other/x);
    }
    // sibling recursive deny next to a list grant
    match /{document=**} {
      allow read: if false;
    }
    match /menuItems/{id} {
      allow list: if true;
    }
  }
}`,
  cases: [
    {
      description: 'exists mocked true, get unmocked → get() errors → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'existsMockOnlyGet/d1',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [{ function: 'exists', path: 'other/x', result: true }],
    },
    {
      description: 'exists mocked false with a get mock → !exists() → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'existsFalseWithGet/d2',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'users/alice', result: { role: 'admin' } },
        { function: 'exists', path: 'users/alice', result: false },
      ],
    },
    {
      description: 'mocks [exists, get] → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'bothMocks/d3',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'exists', path: 'users/alice', result: true },
        { function: 'get', path: 'users/alice', result: { role: 'admin' } },
      ],
    },
    {
      description: 'mocks [get, exists] → ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'bothMocks/d4',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [
        { function: 'get', path: 'users/alice', result: { role: 'admin' } },
        { function: 'exists', path: 'users/alice', result: true },
      ],
    },
    {
      description: "exists mock path '/other/x' (leading slash) → ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'slashMockPath/d5',
      auth: { uid: 'alice' },
      data: { _: 1 },
      functionMocks: [{ function: 'exists', path: '/other/x', result: true }],
    },
    {
      description: 'list menuItems/{id} beside a {document=**} read deny → ALLOW',
      expectation: 'ALLOW',
      method: 'list',
      path: 'menuItems/m1',
      auth: { uid: 'alice' },
    },
  ],
  group: 'fix-class',
};
