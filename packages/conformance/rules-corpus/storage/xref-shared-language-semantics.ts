/**
 * ─── Scenario: xref-shared-language-semantics ────────────────────────────────
 * Storage cross-check of shared-language disagreements the Firestore hunt found
 * (2026-10-26): split()/replace() regex behavior, trim()'s whitespace set, int64
 * precision and overflow, timestamp and duration range errors, and unary minus
 * on a duration. One case per behavior, each under its own match path, so a
 * Storage verdict can be set beside the Firestore one.
 *
 * Conditions are plain JS strings with doubled backslashes, so "'\\u00a0'" is
 * the rules literal ' ' (NBSP). `expectation` is the production answer the
 * Firestore capture reported; the observation records what Storage production
 * decides.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, expected: 'ALLOW' | 'DENY']> = [
  ['split-drops-capture-text', "'a1b'.split('(1)').size() == 2", 'ALLOW'],
  ['split-honors-ignore-case', "'aXb'.split('(?i)x').size() == 2", 'ALLOW'],
  ['replace-honors-ignore-case', "'aXb'.replace('(?i)x', '-') == 'a-b'", 'ALLOW'],
  ['split-drops-trailing-empty', "'a,b,'.split(',').size() == 2", 'ALLOW'],
  ['trim-keeps-nbsp', "'\\u00a0a'.trim() == '\\u00a0a'", 'ALLOW'],
  ['trim-strips-ascii-space', "' a '.trim() == 'a'", 'ALLOW'],
  ['int-above-2-53-distinct', '9007199254740993 != 9007199254740992', 'ALLOW'],
  ['int-add-overflow-errors', '!(9223372036854775807 + 1 < 0)', 'DENY'],
  ['int-min-div-minus-one', '(-9223372036854775807 - 1) / -1 == (-9223372036854775807 - 1)', 'ALLOW'],
  ['timestamp-plus-duration-past-range-errors', '!(timestamp.date(9999, 12, 31) + duration.value(2, \'d\') < timestamp.date(9999, 1, 1))', 'DENY'],
  ['duration-value-past-range-errors', '!(duration.value(999999999999, \'s\') < duration.value(1, \'s\'))', 'DENY'],
  ['duration-unary-minus', "-duration.value(1, 's') < duration.value(0, 's')", 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-XREF-SHARED-LANGUAGE',
  rationale:
    'Shared-language disagreements first confirmed under cloud.firestore: does Storage production decide the same, and does the Storage evaluator share the defect?',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /x/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, expected]) => ({
    description: `${key}: ${condition}`,
    expectation: expected,
    method: 'create' as const,
    path: `x/${key}.bin`,
    resource: { size: 1 },
  })),
};
