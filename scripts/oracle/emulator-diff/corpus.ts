/**
 * Emulator-diff corpus — disputed Firestore-rules semantics.
 *
 * Each entry is a self-contained rules ruleset + a single TestCase, plus
 * the verdict PRODUCTION returns (`expectedProd`). The harness
 * (./harness.ts) runs every case through BOTH pyric's local simulator and
 * the Firebase emulator's rules engine (same evaluator as prod) and diffs.
 *
 * `expectedProd` is the documented oracle: when the emulator is reachable
 * it is *verified* against the live emulator verdict; when it isn't, the
 * harness still diffs the pyric verdict against this documented value so
 * the behavior tracks have a deterministic target. The ledger
 * (design rationale) and the upstream
 * clone citation establish each `expectedProd`.
 *
 * Seeded with the RULES-B2..B9 repros called out in T0-5. Each `finding`
 * field ties the case back to the ledger so a track can grep for its rows.
 */
import type { TestCase } from '../../../packages/pyric/src/rules/test/spec.ts';

export interface CorpusCase {
  /** Stable id, e.g. 'RULES-B2-undefined-field'. */
  id: string;
  /** Ledger finding id this repro locks (RULES-B2 … RULES-B9). */
  finding: string;
  /** One-line description of the disputed semantic. */
  describe: string;
  /** The ruleset under test. */
  rules: string;
  /** The single request to evaluate. */
  testCase: TestCase;
  /** The verdict production / the emulator returns. The pyric simulator
   *  is *expected to disagree* on these today (that's the bug). */
  expectedProd: 'ALLOW' | 'DENY';
  /** Upstream / oracle citation for expectedProd. */
  citation: string;
  /** Whether pyric is EXPECTED to diverge from the oracle today (the bug is
   *  present). `false` marks a case that currently converges — kept as a
   *  regression anchor, excluded from the `--expect-known-bugs` "a fix
   *  landed" alarm. Defaults to true when omitted. */
  expectDivergence?: boolean;
}

/** Minimal Firestore ruleset wrapper around a single match block on
 *  /docs/{id} with one `allow` condition. */
function ruleset(condition: string, op = 'read'): string {
  return [
    'rules_version = "2";',
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /docs/{id} {',
    `      allow ${op}: if ${condition};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
}

export const CORPUS: CorpusCase[] = [
  {
    id: 'RULES-B2-undefined-field-eq-null',
    finding: 'RULES-B2',
    describe: 'Undefined-field access ERRORS in prod (→ deny via tri-state); pyric returns null so `typo == null` ALLOWs.',
    rules: ruleset('resource.data.typo == null'),
    testCase: { description: 'typo field absent; rule reads resource.data.typo', expectation: 'DENY', method: 'get', path: 'docs/d1', resource: { name: 'Alice' } },
    expectedProd: 'DENY',
    citation: 'evaluator.ts:286-311; prod errors on undefined-field access → tri-state deny',
  },
  {
    id: 'RULES-B3-error-absorption-or',
    finding: 'RULES-B3',
    describe: 'CEL `error || true` short-circuits to true (ALLOW) in prod. NOTE: pyric already returns ALLOW for the simple `(err) || true` form below, so this case CONVERGES today — the ledger\'s headline B3 repro does not reproduce. Kept as a regression anchor; T3 should probe the narrower `false || (err)` direction against the emulator (pyric returns DENY there — may or may not match prod).',
    rules: ruleset('(resource.data.s + 1 == 2) || true'),
    testCase: { description: 'left disjunct errors (string + int), right is true', expectation: 'ALLOW', method: 'get', path: 'docs/d1', resource: { s: 'x' } },
    expectedProd: 'ALLOW',
    citation: 'evaluator.ts:469-489; CEL short-circuit absorbs errors',
    expectDivergence: false,
  },
  {
    id: 'RULES-B4-matches-full-string',
    finding: 'RULES-B4',
    describe: 'matches() is anchored full-string RE2 in prod; pyric uses JS partial-match. "abc".matches("b") is FALSE in prod.',
    rules: ruleset('resource.data.name.matches("b")'),
    testCase: { description: 'partial pattern "b" against "abc"', expectation: 'DENY', method: 'get', path: 'docs/d1', resource: { name: 'abc' } },
    expectedProd: 'DENY',
    citation: 'evaluator.ts:850-852; RE2 anchored full match',
  },
  {
    id: 'RULES-B5-integer-division-truncates',
    finding: 'RULES-B5',
    describe: 'int ÷ int truncates in prod (7/2==3); pyric does float division (3.5), so `7/2 == 3` is false there.',
    rules: ruleset('resource.data.n / 2 == 3'),
    testCase: { description: '7 / 2 should truncate to 3', expectation: 'ALLOW', method: 'get', path: 'docs/d1', resource: { n: 7 } },
    expectedProd: 'ALLOW',
    citation: 'evaluator.ts:371-394; int÷int truncates',
  },
  {
    id: 'RULES-B6-string-plus-int-errors',
    finding: 'RULES-B6',
    describe: "Prod errors on `'a' + 1` (no implicit coercion) → deny; pyric coerces and may allow.",
    rules: ruleset("(resource.data.s + 1) == 'a1'"),
    testCase: { description: "'a' + 1 mixed-type concatenation", expectation: 'DENY', method: 'get', path: 'docs/d1', resource: { s: 'a' } },
    expectedProd: 'DENY',
    citation: 'evaluator.ts:279-282; prod errors on mixed +',
  },
  {
    id: 'RULES-B7-no-prototype-key-leakage',
    finding: 'RULES-B7',
    describe: "`'toString' in resource.data` is FALSE in prod (no proto keys); pyric leaks the JS prototype chain → true → ALLOW.",
    rules: ruleset("'toString' in resource.data"),
    testCase: { description: "in-operator must not see inherited keys", expectation: 'DENY', method: 'get', path: 'docs/d1', resource: { name: 'Alice' } },
    expectedProd: 'DENY',
    citation: 'evaluator.ts:367,761-762; prod has no proto keys',
  },
  {
    id: 'RULES-B8-get-missing-doc-errors',
    finding: 'RULES-B8',
    describe: 'get() of a missing doc ERRORS in prod (→ deny); pyric returns null so `get(...).data.x == null` ALLOWs.',
    rules: ruleset("get(/databases/$(database)/documents/other/$(id)).data.x == null"),
    testCase: { description: 'get() targets an unmocked doc → missing', expectation: 'DENY', method: 'get', path: 'docs/d1', resource: { name: 'Alice' } },
    expectedProd: 'DENY',
    citation: 'evaluator.ts:1072-1077; prod errors on missing get()',
  },
  {
    id: 'RULES-B9-hasAll-value-equality',
    finding: 'RULES-B9',
    describe: 'hasAll uses VALUE equality in prod; pyric uses JS identity on wrapper-value lists, so a value-equal member is "missing".',
    rules: ruleset("resource.data.tags.hasAll([['a','b']])"),
    testCase: { description: 'list-of-list member compared by value', expectation: 'ALLOW', method: 'get', path: 'docs/d1', resource: { tags: [['a', 'b']] } },
    expectedProd: 'ALLOW',
    citation: 'evaluator.ts:806-808; prod uses value equality',
  },
];
