/**
 * ─── Scenario: service-root-match-path ───────────────────────────────────────
 * The top-level match under `service cloud.firestore` is a path like any
 * other: its literal segments must match the request path. A root of
 * `/databases/{database}/documents/z` grants nothing outside the `z`
 * collection, even with a recursive wildcard beneath it. Only the `z/1`
 * control is allowed.
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/z {
    match /{d=**} {
      allow read, write: if true;
    }
  }
}`;

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: service root match path',
  rationale:
    'The literal segments of the root match path must match the request path; a root that names one collection grants nothing in another.',
  rules: RULES,
  cases: [
    {
      description: 'get outside the root collection DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'c/1',
      auth: { uid: 'u1' },
      resource: { a: 1 },
    },
    {
      description: 'create outside the root collection DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'c/2',
      auth: { uid: 'u1' },
      data: { a: 1 },
    },
    {
      description: 'get inside the root collection ALLOW (control)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'z/1',
      auth: { uid: 'u1' },
      resource: { a: 1 },
    },
  ],
};
