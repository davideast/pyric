/**
 * ─── Candidate scenario (hunt H1, ST-H1-9): h1-string-ordering ───────────────
 * String `<` across the BMP / supplementary boundary. Code point order (which
 * production uses for Map.keys(), rules-firestore-required-fields-and-mapdiff)
 * puts U+FF5A and U+E000 before U+1F600; UTF-16 code unit order (pyric's
 * JavaScript `<`) puts the emoji first. Records production's string order.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, codePoint: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  // Plain strings with doubled backslashes: Bun rewrites \u escapes inside String.raw.
  ['fullwidth-z-before-emoji', "'\\uff5a' < '\\ud83d\\ude00'", 'ALLOW', 'DENY'],
  ['private-use-before-emoji', "'\\ue000' < '\\ud83d\\ude00'", 'ALLOW', 'DENY'],
  ['emoji-after-uffff', "'\\ud83d\\ude00' > '\\uffff'", 'ALLOW', 'DENY'],
  ['control-ascii', "'a' < 'b' && 'B' < 'a'", 'ALLOW', 'ALLOW'],
  ['control-keys-code-point', "{'\\ud83d\\ude00': 1, '\\uff5a': 2}.keys() == ['\\uff5a', '\\ud83d\\ude00']", 'ALLOW', 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-STRING-ORDER',
  rationale: 'String ordering above the BMP separates code point order from UTF-16 code unit order.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /ord/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, codePoint, pyric]) => ({
    description: `${key}: ${condition} (pyric ${pyric})`,
    expectation: codePoint,
    method: 'create' as const,
    path: `ord/${key}.bin`,
    resource: { size: 1 },
  })),
};
