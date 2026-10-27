/**
 * ─── Candidate scenario (hunt H1, ST-H1-4): h1-int64-precision ───────────────
 * rules.Integer is "a signed 64-bit integer value"
 * (https://firebase.google.com/docs/reference/rules/rules.Integer). pyric holds
 * ints as JavaScript doubles, so values above 2^53 collapse. The overflow cases
 * at the end have no documented answer (wrap, error, or saturate); they record
 * what production does.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, expected: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  ['distinct-literals-equal', '9007199254740993 == 9007199254740992', 'DENY', 'ALLOW'],
  ['int-of-string-equal', "int(request.resource.metadata.v) == 9007199254740992", 'DENY', 'ALLOW'],
  ['max-greater-than-max-minus-one', '9223372036854775807 > 9223372036854775806', 'ALLOW', 'DENY'],
  ['exact-subtraction', '9007199254740993 - 1 == 9007199254740992', 'ALLOW', 'DENY'],
  ['string-of-int64', "string(9007199254740993) == '9007199254740993'", 'ALLOW', 'DENY'],
  ['overflow-wraps-negative', '9223372036854775807 + 1 < 0', 'DENY', 'DENY'],
  ['overflow-stays-positive', '9223372036854775807 + 1 > 0', 'DENY', 'ALLOW'],
  ['overflow-is-error-absorbed', '(9223372036854775807 + 1 == 0) || true', 'ALLOW', 'ALLOW'],
  ['overflow-not-is-error', '!(9223372036854775807 + 1 == 0)', 'ALLOW', 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-INT64',
  rationale: 'Ints are documented as 64-bit; JavaScript doubles make distinct values above 2^53 equal and leave overflow unmodeled.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /int/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, expected, pyric]) => ({
    description: `${key}: ${condition} (pyric ${pyric})`,
    expectation: expected,
    method: 'create' as const,
    path: `int/${key}.bin`,
    resource: { size: 1, metadata: { v: '9007199254740993' } },
  })),
};
