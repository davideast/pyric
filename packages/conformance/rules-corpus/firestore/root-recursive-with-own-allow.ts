/**
 * ─── Scenario: root-recursive-with-own-allow ─────────────────────────────────
 * A root `match /{path=**}` matches the full resource name of every
 * document, so the `allow` written on the root block itself applies: get
 * `c/1` and list `c` are allowed.
 *
 * Captured as `c4a-root-recursive-with-own-allow` in the 2026-11-03
 * Firestore rules hunt (finding FS3-ROOT-1, #1894).
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow read: if true;
  }
}
`;

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: root block own allow',
  rationale:
    'The rules on a root recursive block apply, as on any other block.',
  rules: RULES,
  cases: [
    {
      description: 'root recursive own allow grants get c/1',
      expectation: 'ALLOW',
      method: 'get',
      path: 'c/1',
    },
    {
      description: 'root recursive own allow grants list c',
      expectation: 'ALLOW',
      method: 'list',
      path: 'c',
    },
  ],
};
