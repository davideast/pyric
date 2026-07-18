/**
 * ─── Scenario: optional-rules-version ────────────────────────────────────────
 * A ruleset with NO `rules_version` declaration. Production accepts it and
 * defaults to v1 (PR #333 / #150 grammar fix; the corpus file
 * 001-missing-version.rules was reclassified from invalid to edge-cases on
 * the same evidence). v1 has no granular get/list split, so the scenario
 * sticks to `read`/`write` verbs and a single-segment wildcard — verbs whose
 * meaning is identical across versions; what is under test is that the
 * version-less file parses, deploys, and evaluates at all.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: rules_version omitted (production defaults to v1)',
  rationale:
    'A ruleset without rules_version must be accepted and evaluate (production defaults it to v1); the old grammar rejected the file at parse.',
  rules: `service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == 'alice';
    }
  }
}`,
  cases: [
    {
      description: 'version-less ruleset: authed read → ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice' },
      resource: { title: 'X' },
    },
    {
      description: 'version-less ruleset: anonymous read → DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      resource: { title: 'X' },
    },
    {
      description: 'version-less ruleset: wrong uid write → DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'docs/d2',
      auth: { uid: 'bob' },
      data: { title: 'X' },
    },
  ],
  group: 'fix-class',
};
