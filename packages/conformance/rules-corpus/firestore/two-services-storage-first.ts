/**
 * ─── Scenario: two-services-storage-first ────────────────────────────────────
 * A rules file with a `service firebase.storage` block before its
 * `service cloud.firestore` block. Production compiles the file and
 * evaluates the Firestore block, so its `allow get: if false` denies get
 * `c/1`. Before #1900 pyric refused the file at load, because its grammar
 * took one service block; pyric now loads it and agrees.
 *
 * Found by the 2026-11-03 rules engine defect hunt (FS3-VAL-4) and captured
 * on 2026-11-04 as `c5a-two-services-storage-first`; the rules and case
 * description are the ones sent to production.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: a Storage service before the Firestore service',
  rationale: 'A file with a Storage service block before its Firestore block compiles, and the Firestore block decides, as production does.',
  cases: [
    {
      description: 'two services: firestore block denies c/1',
      expectation: 'ALLOW',
      method: 'get',
      path: 'c/1',
    },
  ],
  rules: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{a=**} { allow read: if true; }\n  }\n}\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if false; }\n  }\n}\n",
};
