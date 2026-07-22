/**
 * ─── Scenario 12: get-after-and-exists-after ──────────────────────────────────
 * Targets Item 7 — getAfter()/existsAfter() with projectAfterState. The hosted
 * production Test API accepts the ruleset but reports Function not found for
 * both functions, so this corpus pins the endpoint limitation. The documented
 * atomic projection semantics remain covered by the local target/batch tests.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 7',
  rationale: 'Hosted production diagnostics report Function not found for getAfter()/existsAfter(); retain the verdicts as a Test API limitation while local atomic-projection tests pin the documented contract.',
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
  group: 'stress',
};
