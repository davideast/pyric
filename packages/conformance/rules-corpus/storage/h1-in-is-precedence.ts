/**
 * ─── Candidate scenario (hunt H1, ST-H1-5): h1-in-is-precedence ──────────────
 * The documented precedence table (https://firebase.google.com/docs/rules/rules-language,
 * "Operators and operator precedence") puts `a in b` and `a is type` above
 * `a==b a!=b`, all left to right. The shared grammar puts them below `==`, so
 * pyric reads `'a' in ['a','b'] == true` as `'a' in (['a','b'] == true)`.
 * Every case here parses in pyric; the parse-rejected forms are in
 * h1-in-is-precedence-deploy.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, documented: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  ['in-then-eq-true', "'a' in ['a','b'] == true", 'ALLOW', 'DENY'],
  ['in-then-eq-false', "'c' in ['a','b'] == false", 'ALLOW', 'DENY'],
  ['eq-then-in', "false == 'c' in ['a','b']", 'ALLOW', 'DENY'],
  ['map-in-then-neq', "'a' in {'a': 1} != false", 'ALLOW', 'DENY'],
  ['control-parenthesized', "('a' in ['a','b']) == true", 'ALLOW', 'ALLOW'],
  // The table lists the ternary as "left to right"; CEL nests it to the right.
  // Right-nested this is true; left-nested it is false. Records production.
  ['ternary-nesting', 'true ? true : false ? false : false', 'ALLOW', 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-IN-IS-PRECEDENCE',
  rationale: 'Documented precedence binds in/is tighter than ==; pyric binds them looser.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /prec/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, documented, pyric]) => ({
    description: `${key}: ${condition} (pyric ${pyric})`,
    expectation: documented,
    method: 'create' as const,
    path: `prec/${key}.bin`,
    resource: { size: 1 },
  })),
};
