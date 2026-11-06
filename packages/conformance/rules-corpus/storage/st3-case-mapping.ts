/**
 * ─── Scenario: st3-case-mapping ──────────────────────────────────────────────
 * `lower()` and `upper()` where full Unicode case mapping (JavaScript's) and
 * per-character simple mapping differ. Production changes none of these
 * letters: `'ß'.upper()`, `'ﬁ'.upper()`, `'İ'.lower()`, `'ı'.upper()`,
 * `'ſ'.upper()`, `'ǅ'.upper()` and `'և'.upper()` return their receiver
 * unchanged, and `'ΑΣ'.lower()` is not `'ασ'`. Before #1885 pyric mapped every
 * Unicode letter, and 8 of the 12 case-mapping cases differed.
 *
 * The last case reads a one-key `{path: ...}` map from a `firestore.get()`
 * function mock (ST3-D-3, pinned): production keeps it a map whose `.path`
 * is a path; pyric reads the whole map as a path.
 *
 * Captured by the 2026-11-03 Storage rules engine defect hunt (ST3-D-1);
 * the rules and case descriptions are the ones sent to production, and each
 * description still names the verdict pyric gave at the time.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, production: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  ['ascii-upper', "'aB'.upper() == 'AB'", 'ALLOW', 'ALLOW'],
  ['sharp-s-upper-unchanged', "'ß'.upper() == 'ß'", 'ALLOW', 'DENY'],
  ['sharp-s-upper-size', "'ß'.upper().size() == 1", 'ALLOW', 'DENY'],
  ['sigma-lower-simple', "'ΑΣ'.lower() == 'ασ'", 'DENY', 'DENY'],
  ['ligature-upper-unchanged', "'ﬁ'.upper() == 'ﬁ'", 'ALLOW', 'DENY'],
  ['dotted-i-lower-plain-i', "'İ'.lower() == 'i'", 'DENY', 'DENY'],
  ['dotted-i-lower-size-1', "'İ'.lower().size() == 1", 'ALLOW', 'DENY'],
  ['dotless-i-upper', "'ı'.upper() == 'I'", 'DENY', 'ALLOW'],
  ['long-s-upper', "'ſ'.upper() == 'S'", 'DENY', 'ALLOW'],
  ['titlecase-dz-upper', "'ǅ'.upper() == 'Ǆ'", 'DENY', 'ALLOW'],
  ['armenian-ligature-upper-size', "'և'.upper().size() == 1", 'ALLOW', 'DENY'],
  ['upper-sharp-s-to-capital', "'ß'.upper() == 'ẞ'", 'DENY', 'DENY'],
];

const pathMock = [{ function: 'get' as const, path: 'a/b', result: { ref: { path: '/databases/(default)/documents/a/b' } } }];

export const scenario: StorageScenarioRecord = {
  fm: 'ST3-CASE-MAPPING',
  rationale: 'lower() and upper() where full and simple Unicode case mapping differ.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /case/${key}/{f} { allow get: if ${condition}; }`).join('\n')}
    match /pathtype/{f} { allow get: if firestore.get(/databases/(default)/documents/a/b).data.ref.path is path; }
  }
}`,
  cases: [
    ...cases.map(([key, condition, production, pyric]) => ({
      description: `${key}: ${condition} (pyric ${pyric})`,
      expectation: production,
      method: 'get' as const,
      path: `case/${key}/x`,
      existingResource: { size: 1 },
    })),
    {
      description: 'lookup map with one path key: .path is path (pyric DENY)',
      expectation: 'ALLOW',
      method: 'get',
      path: 'pathtype/x',
      existingResource: { size: 1 },
      functionMocks: pathMock,
    },
  ],
};
