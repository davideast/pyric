/**
 * ─── Scenario: st3-case-mapping-ascii ────────────────────────────────────────
 * Whether `lower()` and `upper()` map any letter outside ASCII. Production
 * maps the ASCII letters only: `'é'.upper()`, `'Ä'.lower()`, `'ΑΣ'.lower()`,
 * `'ж'.upper()`, `'İ'.lower()`, `'ı'.upper()` and `'ａ'.upper()` return their
 * receiver unchanged, `'aé'.upper()` is `'Aé'`, and
 * `'ÉVE@X.COM'.lower() == 'éve@x.com'` denies. Before #1885 pyric mapped
 * every Unicode letter, and all 12 cases differed.
 *
 * Captured by the 2026-11-03 Storage rules engine defect hunt (ST3-D-1);
 * the rules and case descriptions are the ones sent to production, and each
 * description still names the verdict pyric gave at the time.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, production: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  ['latin1-upper', "'é'.upper() == 'É'", 'DENY', 'ALLOW'],
  ['latin1-upper-unchanged', "'é'.upper() == 'é'", 'ALLOW', 'DENY'],
  ['latin1-lower', "'Ä'.lower() == 'ä'", 'DENY', 'ALLOW'],
  ['latin1-lower-unchanged', "'Ä'.lower() == 'Ä'", 'ALLOW', 'DENY'],
  ['greek-lower-unchanged', "'ΑΣ'.lower() == 'ΑΣ'", 'ALLOW', 'DENY'],
  ['cyrillic-upper', "'ж'.upper() == 'Ж'", 'DENY', 'ALLOW'],
  ['cyrillic-upper-unchanged', "'ж'.upper() == 'ж'", 'ALLOW', 'DENY'],
  ['dotted-i-lower-unchanged', "'İ'.lower() == 'İ'", 'ALLOW', 'DENY'],
  ['dotless-i-upper-unchanged', "'ı'.upper() == 'ı'", 'ALLOW', 'DENY'],
  ['mixed-ascii-part', "'aé'.upper() == 'Aé'", 'ALLOW', 'DENY'],
  ['fullwidth-upper', "'ａ'.upper() == 'Ａ'", 'DENY', 'ALLOW'],
  ['email-lower', "'ÉVE@X.COM'.lower() == 'éve@x.com'", 'DENY', 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'ST3-CASE-ASCII',
  rationale: 'lower() and upper() map the ASCII letters A-Z and a-z only; every other letter keeps its case.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /case/${key}/{f} { allow get: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, production, pyric]) => ({
    description: `${key}: ${condition} (pyric ${pyric})`,
    expectation: production,
    method: 'get' as const,
    path: `case/${key}/x`,
    existingResource: { size: 1 },
  })),
};
