/**
 * Firestore Rules Test API compile-check probe for a ruleset declaring only
 * `service firebase.storage` when tested with a Firestore document request
 * (#1434).
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'Service declaration validation (#1434)',
  rationale:
    'Records whether projects.test compiles or rejects a ruleset whose sole service block is service firebase.storage when evaluated against a Firestore document request.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read: if true;
    }
  }
}`,
  cases: [
    {
      description: 'firestore get request against a sole service firebase.storage ruleset',
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
