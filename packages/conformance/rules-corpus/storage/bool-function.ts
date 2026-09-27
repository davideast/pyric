/**
 * ─── Scenario: bool-function ─────────────────────────────────────────────────
 * `bool()` in Storage rules. The rules.Boolean reference page shows
 * `bool("true") == true`, but production has no global `bool()` function: every
 * call is a "Function not found error" for any argument type, including string,
 * int, bool, null, list, and a metadata value.
 *
 * Each input is checked twice, as `bool(x) == v` and as `!(bool(x) == v)`. A
 * conversion that succeeded would allow exactly one of the pair; production
 * denies both, so the call is an error value. A bare `bool('true')` condition
 * denies, `|| true` absorbs the error, and `!(bool('true') && false)` allows.
 * A ruleset function named `bool` is callable.
 */
import type { StorageScenarioRecord, StorageTestCase } from './types.ts';

interface BoolCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

const inputs: Array<[key: string, arg: string, value: string]> = [
  ['TrueString', "'true'", 'true'],
  ['FalseString', "'false'", 'false'],
  ['UpperString', "'TRUE'", 'true'],
  ['OneString', "'1'", 'true'],
  ['IntOne', '1', 'true'],
  ['IntZero', '0', 'false'],
  ['Bool', 'true', 'true'],
  ['Null', 'null', 'false'],
  ['List', '[]', 'false'],
  ['Metadata', 'request.resource.metadata.t', 'true'],
];

const cases: BoolCase[] = [
  ...inputs.flatMap(([key, arg, value]): BoolCase[] => [
    { key: `bool${key}`, condition: `bool(${arg}) == ${value}`, expectation: 'DENY' },
    { key: `bool${key}Not`, condition: `!(bool(${arg}) == ${value})`, expectation: 'DENY' },
  ]),
  { key: 'boolBare', condition: "bool('true')", expectation: 'DENY' },
  { key: 'boolIsBool', condition: "bool('true') is bool", expectation: 'DENY' },
  { key: 'boolOrTrue', condition: "bool('true') == true || true", expectation: 'ALLOW' },
  { key: 'boolAndFalse', condition: "!(bool('true') && false)", expectation: 'ALLOW' },
];

const upload = {
  size: 2,
  contentType: 'text/plain',
  metadata: { t: 'true' },
};

function uploadCase(path: string, description: string, expectation: 'ALLOW' | 'DENY'): StorageTestCase {
  return { description, expectation, method: 'create', path, auth: { uid: 'alice' }, resource: upload };
}

const matchBlocks = cases
  .map(({ key, condition }) => `    match /${key}/{file} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: bool() is not a global function',
  rationale:
    'Storage rules have no global bool() function: a call with any argument type is a Function not found error value that denies through == and !, that || true and && false absorb, and that a ruleset function named bool replaces.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${matchBlocks}
    match /shadowed/{file} {
      function bool(x) { return x == 'yes'; }
      allow create: if bool('yes');
    }
  }
}`,
  cases: [
    ...cases.map(({ key, condition, expectation }) =>
      uploadCase(`${key}/a.txt`, `${condition} → ${expectation}`, expectation)),
    uploadCase('shadowed/a.txt', "a ruleset function bool(x) is callable: bool('yes') → ALLOW", 'ALLOW'),
  ],
};
