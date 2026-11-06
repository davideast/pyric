/**
 * ─── Scenario: root-recursive-own-allow-write ────────────────────────────────
 * A root `match /{path=**}` with `allow write: if request.auth != null` on
 * the block itself allows a signed-in create of `c/1` and denies a
 * signed-out one.
 *
 * Captured as `c5e-root-recursive-own-allow-write` in the 2026-11-03
 * Firestore rules hunt (finding FS3-ROOT-1, #1894).
 */
import type { ScenarioRecord } from './types.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow write: if request.auth != null;
  }
}
`;

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'Coverage: root block own allow',
  rationale:
    'The write rules on a root recursive block apply, as on any other block.',
  rules: RULES,
  cases: [
    {
      description: 'root /{path=**} own write rule, signed out create c/1',
      expectation: 'DENY',
      method: 'create',
      path: 'c/1',
      data: {
        a: 1,
      },
    },
    {
      description: 'root /{path=**} own write rule, signed in create c/1',
      expectation: 'ALLOW',
      method: 'create',
      path: 'c/1',
      data: {
        a: 1,
      },
      auth: {
        uid: 'u',
      },
    },
  ],
};
