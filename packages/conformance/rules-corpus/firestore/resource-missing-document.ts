/**
 * RULES-B13 — request-target resource semantics when the document is missing.
 *
 * Production represents the pre-request `resource` as a null error value when
 * the target document does not exist. Touching or comparing that value errors
 * and absorbs to DENY. The simulator instead constructed `{ data: {} }` for
 * missing get/update/delete requests, so the ordinary `resource != null`
 * existence guard false-ALLOWED all three operations.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-B13',
  rationale:
    'A missing request target makes resource a null error value. The simulator constructed a non-null empty resource for get/update/delete, so `resource != null` ALLOWed where production DENIES.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /existsGuard/{id} {
      allow get, update, delete: if resource != null;
    }
    match /nullGuard/{id} {
      allow get: if resource == null;
    }
    match /dataRead/{id} {
      allow get: if resource.data.value == 'before';
    }
  }
}`,
  cases: [
    {
      description: 'missing document get with resource != null → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'existsGuard/missing-get',
    },
    {
      description: 'missing document update with resource != null → DENY',
      expectation: 'DENY',
      method: 'update',
      path: 'existsGuard/missing-update',
      data: { value: 'after' },
    },
    {
      description: 'missing document delete with resource != null → DENY',
      expectation: 'DENY',
      method: 'delete',
      path: 'existsGuard/missing-delete',
    },
    {
      description: 'existing document get with resource != null → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'existsGuard/existing-get',
      resource: { value: 'before' },
    },
    {
      description: 'existing document update with resource != null → ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'existsGuard/existing-update',
      resource: { value: 'before' },
      data: { value: 'after' },
    },
    {
      description: 'existing document delete with resource != null → ALLOW',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'existsGuard/existing-delete',
      resource: { value: 'before' },
    },
    {
      description: 'missing document resource == null → DENY (comparison errors)',
      expectation: 'DENY',
      method: 'get',
      path: 'nullGuard/missing',
    },
    {
      description: 'missing document resource.data.value touch → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'dataRead/missing',
    },
    {
      description: 'existing document resource.data.value touch → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'dataRead/existing',
      resource: { value: 'before' },
    },
  ],
  group: 'fix-class',
};
