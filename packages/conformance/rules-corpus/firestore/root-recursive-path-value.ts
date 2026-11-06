/**
 * ─── Scenario: root-recursive-path-value ─────────────────────────────────────
 * A root `match /{path=**}` binds `path` to the full resource name, so
 * `path == path('databases/(default)/documents/c/1')` holds for get `c/1`.
 *
 * Captured as `c4c-root-recursive-path-value` in the 2026-11-03 Firestore
 * rules hunt (finding FS3-ROOT-1, #1894).
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow get: if path == path('databases/(default)/documents/c/1');
  }
}
`;

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: root block own allow',
  rationale:
    'The root recursive wildcard binds the full resource name as a path.',
  rules: RULES,
  cases: [
    {
      description: 'root recursive binds the full resource name',
      expectation: 'ALLOW',
      method: 'get',
      path: 'c/1',
    },
  ],
};
