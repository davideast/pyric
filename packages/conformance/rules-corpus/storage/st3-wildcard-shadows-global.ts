/**
 * ─── Scenario: st3-wildcard-shadows-global ───────────────────────────────────
 * A path wildcard named like a global, `{request}` or `{resource}`. Production
 * reads the wildcard inside its block: `request == 'q'` and `resource == 'q'`
 * allow a get of the segment `q`, and `request.method == 'get'` denies,
 * because `request` is the string `'q'`. Before #1886 pyric read the globals
 * first, and all 3 cases differed.
 *
 * Captured by the 2026-11-03 Storage rules engine defect hunt (ST3-D-2);
 * the rules and case descriptions are the ones sent to production, and each
 * description still names the verdict pyric gave at the time.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'ST3-WILDCARD-SHADOWS-GLOBAL',
  rationale: 'A path wildcard named request or resource shadows the global of the same name inside its block.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pr/{request} { allow get: if request == 'q'; }
    match /ps/{resource} { allow get: if resource == 'q'; }
    match /pt/{request} { allow get: if request.method == 'get'; }
  }
}`,
  cases: [
    {
      description: 'wildcard named request equals the segment (pyric DENY)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'pr/q',
      existingResource: { size: 1 },
    },
    {
      description: 'wildcard named resource equals the segment (pyric DENY)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'ps/q',
      existingResource: { size: 1 },
    },
    {
      description: 'wildcard named request still has .method (pyric ALLOW)',
      expectation: 'DENY',
      method: 'get',
      path: 'pt/q',
      existingResource: { size: 1 },
    },
  ],
};
