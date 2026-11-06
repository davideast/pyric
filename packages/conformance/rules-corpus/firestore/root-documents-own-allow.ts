/**
 * ─── Scenario: root-documents-own-allow ──────────────────────────────────────
 * A root `match /databases/{database}/documents` does not match a
 * document's full resource name, so an `allow` written on the root block
 * itself grants no document. Only its children can.
 *
 * Captured as `c4b-root-documents-own-allow` in the 2026-11-03 Firestore
 * rules hunt (finding FS3-ROOT-1, #1894).
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    allow read: if true;
  }
}
`;

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: root block own allow',
  rationale:
    'The rules on a root that stops at documents grant no document.',
  rules: RULES,
  cases: [
    {
      description: 'allow on the root block itself grants get c/1',
      expectation: 'ALLOW',
      method: 'get',
      path: 'c/1',
    },
  ],
};
