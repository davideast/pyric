/**
 * ─── Candidate scenario (hunt H1, ST-H1-8): h1-unknown-method-absorption ─────
 * A method name no receiver defines. Production absorbs an undefined global
 * function under `|| true` (rules-storage-conversion-functions:
 * "foo(1) == 1 || true → ALLOW") and reports wrong-receiver methods as
 * "Function not found error"; whether it compiles and absorbs an undefined
 * method name is not captured. pyric's Storage evaluator fails these closed
 * (RuleUnsupportedError, never absorbed); its Firestore simulator absorbs them.
 * If production rejects the ruleset at compile, that is the answer too.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string]> = [
  ['string-foo-or-true', "'a'.foo() || true"],
  ['list-indexof-or-true', '[1, 2].indexOf(2) == 1 || true'],
  ['map-abs-or-true', "{'abs': 1}.abs() == 1 || true"],
  ['not-foo-and-false', "!('a'.foo() == 1 && false)"],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-UNKNOWN-METHOD',
  rationale: 'An undefined method name should be an absorbable function-not-found error, as an undefined function is.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /um/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition]) => ({
    description: `${key}: ${condition} (pyric DENY)`,
    expectation: 'ALLOW' as const,
    method: 'create' as const,
    path: `um/${key}.bin`,
    resource: { size: 1 },
  })),
};
