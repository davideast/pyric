/**
 * Regression suite for RE2 string functions in Firestore and Storage rules
 * (#1890, #1891, #1892, #1895).
 *
 * Replays the committed production Rules Test API observations from the
 * 2026-11-03 Firestore defect hunt under
 * `packages/conformance/observations/firestore-rules/`:
 * - `rules-firestore-re2-replace-and-split-dialect.json` (`c1-re2-replace-split`, 32 cases)
 * - `rules-firestore-re2-more-classes-and-escapes.json` (`c9-re2-more`, 15 cases)
 * - `rules-firestore-script-classes-and-nested-repeats.json` (`c10-script-classes-and-redos`, 8 cases)
 *
 * Also verifies Firestore and Storage parity on every targeted behavior and
 * bounds wall-clock evaluation time on nested repeats (`(a+)+b`, `((a+)+)b`,
 * `(a*)*b`) for both `split()` and `replace()`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../../conformance/rules-corpus/firestore/index.ts';
import { normalizeRe2ForJsRegExp, scanRe2Pattern } from '../../src/grammar/re2-pattern.js';
import { firestoreRules, storageRules } from '../../src/index.js';
import { SimulateFirestoreRulesHandler } from '../../src/simulator/handler.js';

type Verdict = 'ALLOW' | 'DENY';

const OBSERVATIONS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore-rules',
);

function readObservedBehavior(scenarioId: string): Record<string, Verdict> {
  const filePath = join(OBSERVATIONS_DIR, `rules-firestore-${scenarioId}.json`);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
    behavior: Record<string, Verdict>;
  };
  return parsed.behavior;
}

function requireExpectedVerdict(
  behavior: Readonly<Record<string, Verdict>>,
  description: string,
): Verdict {
  const verdict = behavior[description];
  if (verdict === undefined) {
    throw new Error(`Missing observed case: ${description}`);
  }
  return verdict;
}

function replayScenarioVerdicts(scenarioId: string): Record<string, Verdict> {
  const scenario = ALL_RULES_FIRESTORE_SCENARIOS.find((entry) => entry.id === scenarioId);
  if (scenario === undefined) {
    throw new Error(`Missing Firestore corpus scenario: ${scenarioId}`);
  }
  const result = new SimulateFirestoreRulesHandler().simulate(scenario.rules, scenario.cases);
  if (!result.success) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  const out: Record<string, Verdict> = {};
  for (const item of result.data.results) {
    if (item.decision !== 'ALLOW' && item.decision !== 'DENY') {
      throw new Error(`Unexpected decision ${String(item.decision)} for ${item.description}`);
    }
    out[item.description] = item.decision;
  }
  return out;
}

function evalGuardBoth(
  guard: string,
  subject = '',
): { firestore: string; storage: string } {
  const fsRules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    `      allow create: if ${guard};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const fsSummary = firestoreRules(fsRules).simulate([
    {
      description: guard,
      expectation: 'ALLOW',
      method: 'create',
      path: 'items/1',
      data: { s: subject },
    },
  ]);
  const fsCase = fsSummary.cases[0];
  if (fsCase === undefined) {
    throw new Error('Missing Firestore simulation case result');
  }

  const storageGuard = guard.replaceAll('request.resource.data.s', 'request.resource.metadata.s');
  const stRules = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    `      allow create: if ${storageGuard};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const stSummary = storageRules(stRules, { bucket: 'b1' }).simulate([
    {
      description: storageGuard,
      expectation: 'ALLOW',
      method: 'create',
      path: '/items/1',
      requestResource: { size: 1, metadata: { s: subject } },
    },
  ]);
  const stCase = stSummary.cases[0];
  if (stCase === undefined) {
    throw new Error('Missing Storage simulation case result');
  }

  return {
    firestore: fsCase.decision,
    storage: stCase.decision,
  };
}

describe('committed production observations replay without divergence (#1890, #1891, #1892, #1895)', () => {
  const scenarios: ReadonlyArray<readonly [scenarioId: string, expectedCount: number]> = [
    ['re2-replace-and-split-dialect', 32],
    ['re2-more-classes-and-escapes', 15],
    ['script-classes-and-nested-repeats', 8],
  ];

  for (const [scenarioId, expectedCount] of scenarios) {
    describe(scenarioId, () => {
      const observed = readObservedBehavior(scenarioId);
      const simulated = replayScenarioVerdicts(scenarioId);
      const entries = Object.entries(observed);

      test(`replays all ${expectedCount} captured cases`, () => {
        expect(entries).toHaveLength(expectedCount);
      });

      for (const [description, expected] of entries) {
        test(description, () => {
          expect(simulated[description]).toBe(expected);
        });
      }
    });
  }
});

describe('#1890: replace() and split() read astral characters as single code points', () => {
  const c1Observed = readObservedBehavior('re2-replace-and-split-dialect');
  const c9Observed = readObservedBehavior('re2-more-classes-and-escapes');

  const capturedAstralCases: ReadonlyArray<{
    readonly behavior: Readonly<Record<string, Verdict>>;
    readonly key: string;
    readonly guard: string;
  }> = [
    {
      behavior: c1Observed,
      key: "as0: '\u{1F600}'.replace('.', 'x') == 'x'",
      guard: "'\u{1F600}'.replace('.', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "as1: '\u{1F600}'.replace('[^a]', 'x') == 'x'",
      guard: "'\u{1F600}'.replace('[^a]', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "as2: 'a\u{1F600}b'.split('[^ab]') == ['a', 'b']",
      guard: "'a\u{1F600}b'.split('[^ab]') == ['a', 'b']",
    },
    {
      behavior: c1Observed,
      key: "as3: '\u{1F600}'.replace('[\\\\x{1F600}]', 'x') == 'x'",
      guard: "'\u{1F600}'.replace('[\\\\x{1F600}]', 'x') == 'x'",
    },
    {
      behavior: c1Observed,
      key: "as7: 'a\u{1F600}b'.split('').size() == 3",
      guard: "'a\u{1F600}b'.split('').size() == 3",
    },
    {
      behavior: c9Observed,
      key: "ar0: '\u{1F600}'.replace('[\u{1F600}-\u{1F602}]', 'x') == 'x'",
      guard: "'\u{1F600}'.replace('[\u{1F600}-\u{1F602}]', 'x') == 'x'",
    },
    {
      behavior: c9Observed,
      key: "ar1: 'a\u{1F600}'.split('[\u{1F600}-\u{1F602}]') == ['a']",
      guard: "'a\u{1F600}'.split('[\u{1F600}-\u{1F602}]') == ['a']",
    },
  ];

  for (const item of capturedAstralCases) {
    test(`matches production on Firestore and Storage: ${item.key}`, () => {
      const expected = requireExpectedVerdict(item.behavior, item.key);
      expect(evalGuardBoth(item.guard)).toEqual({
        firestore: expected,
        storage: expected,
      });
    });
  }

  test('reads astral code points in capture groups, hex ranges, quoted repeats, and negated classes', () => {
    const extraGuards: readonly string[] = [
      "'a\u{1F600}b'.replace('(.)', '[$1]') == '[a][\u{1F600}][b]'",
      "'\u{1F600}'.replace('(?P<emoji>.)', '<${emoji}>') == '<\u{1F600}>'",
      "'\u{1F601}'.replace('[\\\\x{1F600}-\\\\x{1F602}]', 'x') == 'x'",
      "'a\u{1F601}b'.split('[\\\\x{1F600}-\\\\x{1F602}]') == ['a', 'b']",
      "'\u{1F600}\u{1F600}'.replace('\\\\Q\u{1F600}\\\\E+', 'x') == 'x'",
      "'\u{1F600}\u{1F602}a'.replace('[^\u{1F600}]', 'x') == '\u{1F600}xx'",
    ];
    for (const guard of extraGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });
});

describe('#1891: (?U) makes repeats ungreedy in replace() and split()', () => {
  const c1Observed = readObservedBehavior('re2-replace-and-split-dialect');

  test('matches production on ug0 (ALLOW) and ug1 (DENY) across Firestore and Storage', () => {
    const ug0Key = "ug0: 'aaa'.replace('(?U)a+', 'x') == 'xxx'";
    const ug1Key = "ug1: 'aaa'.replace('(?U)a+', 'x') == 'x'";
    expect(requireExpectedVerdict(c1Observed, ug0Key)).toBe('ALLOW');
    expect(requireExpectedVerdict(c1Observed, ug1Key)).toBe('DENY');

    expect(evalGuardBoth("'aaa'.replace('(?U)a+', 'x') == 'xxx'")).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
    expect(evalGuardBoth("'aaa'.replace('(?U)a+', 'x') == 'x'")).toEqual({
      firestore: 'DENY',
      storage: 'DENY',
    });
  });

  test('applies (?U), trailing ?, (?-U), and group scoping consistently in replace() and split()', () => {
    const ungreedyGuards: readonly string[] = [
      "'aXbcXbd'.split('(?U)X.*b') == ['a', 'c', 'd']",
      "'aXbcXbd'.split('(?U)X.*?b') == ['a', 'd']",
      "'aXbcXbd'.split('X.*b') == ['a', 'd']",
      "'aaa'.replace('(?U)a+?', 'x') == 'x'",
      "'aaa'.replace('(?U)a{1,3}', 'x') == 'xxx'",
      "'aaa'.replace('(?U)a{1,3}?', 'x') == 'x'",
      "'aaaa'.replace('(?U:(a+))(a+)', '$1-$2') == 'a-aaa'",
      "'aaaa'.replace('((?U)a+)(a+)', '$1-$2') == 'a-aaa'",
      "'aaaa'.replace('(?U)(a+)(?-U)(a+)', '$1-$2') == 'a-aaa'",
      "'aaa'.replace('(?U-U)a+', 'x') == 'x'",
    ];
    for (const guard of ungreedyGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });

  test('accepts (?U), (?-U), and (?U:...) in normalizeRe2ForJsRegExp and scanRe2Pattern', () => {
    expect(scanRe2Pattern('(?U)a+')).toEqual({ unsupported: null, inlineFlags: '' });
    expect(scanRe2Pattern('(?U:a+)b+')).toEqual({ unsupported: null, inlineFlags: '' });
    expect(normalizeRe2ForJsRegExp('(?U)a+')).toBe('(?:)a+');
    expect(normalizeRe2ForJsRegExp('(?U:a+)b+')).toBe('(?:a+)b+');
  });
});

describe('#1892: \\z and \\A stay absolute anchors under (?m) in replace() and split()', () => {
  const c1Observed = readObservedBehavior('re2-replace-and-split-dialect');

  test('matches production on za0, za1, and za2 across Firestore and Storage', () => {
    const za0Key = "za0: 'a\\nb'.replace('(?m)a\\\\z', 'x') == 'a\\nb'";
    const za1Key = "za1: 'a\\nb'.replace('(?m)\\\\Ab', 'x') == 'a\\nb'";
    const za2Key = "za2: !'a\\nb'.matches('(?m)a\\\\z.*')";
    expect(requireExpectedVerdict(c1Observed, za0Key)).toBe('ALLOW');
    expect(requireExpectedVerdict(c1Observed, za1Key)).toBe('ALLOW');
    expect(requireExpectedVerdict(c1Observed, za2Key)).toBe('ALLOW');

    expect(evalGuardBoth("'a\\nb'.replace('(?m)a\\\\z', 'x') == 'a\\nb'")).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
    expect(evalGuardBoth("'a\\nb'.replace('(?m)\\\\Ab', 'x') == 'a\\nb'")).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
    expect(evalGuardBoth("!'a\\nb'.matches('(?m)a\\\\z.*')")).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
  });

  test('keeps \\A and \\z at string boundaries while ^ and $ match line boundaries under (?m)', () => {
    const anchorGuards: readonly string[] = [
      "'a\\na\\na'.replace('(?m)\\\\Aa', 'x') == 'x\\na\\na'",
      "'a\\na\\na'.replace('(?m)a\\\\z', 'x') == 'a\\na\\nx'",
      "'a\\n'.replace('(?m)a\\\\z', 'x') == 'a\\n'",
      "'a\\na'.replace('(?m)^a', 'x') == 'x\\nx'",
      "'a\\na'.replace('(?m)a$', 'x') == 'x\\nx'",
      "'a\\nb'.split('(?m)a\\\\z') == ['a\\nb']",
      "'a\\nb'.split('(?m)\\\\Ab') == ['a\\nb']",
      "'a\\na'.split('(?m)\\\\Aa') == ['', '\\na']",
      "'b\\na'.split('(?m)a\\\\z') == ['b\\n']",
      "'a\\nb'.split('(?m)a$') == ['', '\\nb']",
    ];
    for (const guard of anchorGuards) {
      expect(evalGuardBoth(guard)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    }
  });
});

describe('#1895: split() and replace() evaluate nested repeats in linear time', () => {
  const c10Observed = readObservedBehavior('script-classes-and-nested-repeats');

  test('matches production on rd0 and rd1 across Firestore and Storage', () => {
    const rd0Key = "rd0: request.resource.data.s.split('(a+)+b').size() == 1";
    const rd1Key = "rd1: request.resource.data.s.replace('(a+)+b', '') == request.resource.data.s";
    expect(requireExpectedVerdict(c10Observed, rd0Key)).toBe('ALLOW');
    expect(requireExpectedVerdict(c10Observed, rd1Key)).toBe('ALLOW');

    const capturedSubject = `${'a'.repeat(26)}!`;
    expect(evalGuardBoth("request.resource.data.s.split('(a+)+b').size() == 1", capturedSubject)).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
    expect(
      evalGuardBoth(
        "request.resource.data.s.replace('(a+)+b', '') == request.resource.data.s",
        capturedSubject,
      ),
    ).toEqual({
      firestore: 'ALLOW',
      storage: 'ALLOW',
    });
  });

  const nestedPatterns: readonly string[] = ['(a+)+b', '((a+)+)b', '(a*)*b'];
  const longSubject = `${'a'.repeat(2000)}!`;

  for (const pattern of nestedPatterns) {
    test(`bounds split('${pattern}') and replace('${pattern}', '') on 2,001 characters within 250 ms`, () => {
      const splitExpr = `request.resource.data.s.split('${pattern}').size() == 1`;
      const replaceExpr = `request.resource.data.s.replace('${pattern}', '') == request.resource.data.s`;

      // Warm up compilation and evaluator paths before measuring wall-clock time.
      evalGuardBoth(splitExpr, 'warmup!');
      evalGuardBoth(replaceExpr, 'warmup!');

      const splitStart = performance.now();
      const splitResult = evalGuardBoth(splitExpr, longSubject);
      const splitElapsedMs = performance.now() - splitStart;
      expect(splitResult).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(splitElapsedMs).toBeLessThan(250);

      const replaceStart = performance.now();
      const replaceResult = evalGuardBoth(replaceExpr, longSubject);
      const replaceElapsedMs = performance.now() - replaceStart;
      expect(replaceResult).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
      expect(replaceElapsedMs).toBeLessThan(250);
    });
  }

  test('bounds .*x|a across 8,000 matches in split() and replace() within 400 ms', () => {
    const repeatedSubject = 'a'.repeat(8000);
    const splitExpr = "request.resource.data.s.split('.*x|a').size() == 1";
    const replaceExpr = "request.resource.data.s.replace('.*x|a', '') == ''";

    evalGuardBoth(splitExpr, 'warmup');
    evalGuardBoth(replaceExpr, 'warmup');

    const splitStart = performance.now();
    expect(evalGuardBoth(splitExpr, repeatedSubject)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    expect(performance.now() - splitStart).toBeLessThan(400);

    const replaceStart = performance.now();
    expect(evalGuardBoth(replaceExpr, repeatedSubject)).toEqual({ firestore: 'ALLOW', storage: 'ALLOW' });
    expect(performance.now() - replaceStart).toBeLessThan(400);
  });
});
