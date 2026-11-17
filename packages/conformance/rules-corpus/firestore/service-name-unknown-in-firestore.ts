/**
 * Firestore Rules Test API compile-check probe for a ruleset declaring an
 * unrecognized service name (`service foo.bar`) (#1434).
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  allowCompileError: true,
  fm: 'Service declaration validation (#1434)',
  rationale:
    'Records whether projects.test rejects an unknown service name (service foo.bar) and captures the exact issue message, line, and column.',
  rules: `rules_version = '2';
service foo.bar {
  match /items/{id} {
    allow read: if true;
  }
}`,
  cases: [
    {
      description: 'firestore get request against an unknown service foo.bar ruleset',
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
