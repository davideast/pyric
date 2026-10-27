/**
 * RTDB's regex dialect (#1247: SP-1, SP-2a, SP-2b, SP-8, LD-6). Each verdict
 * or error text below is a production observation under
 * packages/conformance/observations/rtdb-rules/, named per case.
 */
import { describe, expect, test } from 'bun:test';
import {
  MISPLACED_ANCHOR_MESSAGE,
  compileRtdbRegex,
  rtdbRegexError,
} from '../../../../src/rules/rtdb/grammar/regex.js';
import { rtdbRules } from '../../../../src/rules/api/rtdb.js';
import { rtdbRulesSourceRejection } from '../../../../src/rules/rtdb/source-rejection.js';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS } from '../../../../../../packages/conformance/rules-corpus/rtdb/index.ts';
import { replayRtdbDeployScenario } from '../../../../../../packages/conformance/src/rules-rtdb-replay.ts';

const matches = (body: string, subject: string, flags = ''): boolean => compileRtdbRegex(body, flags).test(subject);

describe('load-time check', () => {
  test('refuses a ^ that is not first and a $ that is not last (r46, r51)', () => {
    for (const body of ['^red$|^blue$', '(^a)', 'a$|b', '(a$)']) {
      expect(rtdbRegexError(body), body).toBe(MISPLACED_ANCHOR_MESSAGE);
    }
  });

  test('accepts an escaped $ and a ^ that negates a set (r51, r44)', () => {
    expect(rtdbRegexError('a\\$b')).toBeNull();
    expect(rtdbRegexError('^[^/]+$')).toBeNull();
    expect(rtdbRegexError('^[a-z0-9-]+$')).toBeNull();
  });

  test('refuses \\p{L} with production position (r46)', () => {
    expect(rtdbRegexError('^\\p{L}+$')).toBe('Illegal regular expression, integer expected at position 3');
  });

  test('reports parenthesis errors at production positions (r44, r53)', () => {
    expect(rtdbRegexError('(')).toBe("Illegal regular expression, expected ')' at position 5");
    expect(rtdbRegexError('^(a$')).toBe("Illegal regular expression, expected ')' at position 2");
    expect(rtdbRegexError(')')).toBe('Illegal regular expression, end-of-string expected');
    expect(rtdbRegexError('^)')).toBeNull();
    expect(matches('^)$', ')')).toBe(true);
  });

  test('accepts the constructs production deploys (r44, r46)', () => {
    for (const body of ['^(?=.*[0-9]).+$', '^(?!admin).*$', '^(a)\\1$', '\\bcat\\b', '^a+?$', '+', '[z-a]', 'a{2,1}']) {
      expect(rtdbRegexError(body), body).toBeNull();
    }
  });
});

test('every regex literal production refused at deploy fails with its exact text', () => {
  let checked = 0;
  for (const scenario of ALL_RULES_RTDB_DEPLOY_SCENARIOS) {
    const results = replayRtdbDeployScenario(scenario);
    scenario.deployCases.forEach((deployCase, index) => {
      const { expectation } = deployCase;
      const isRefusedRegex = deployCase.construct === 'rtdb.semantic.regex-literal' && expectation.verdict === 'REJECTED';
      if (!isRefusedRegex) return;
      const errors = results[index]!.localErrors.map((error) => error.replace(/^.* \.(read|write|validate): /, ''));
      expect(errors, `${scenario.id} :: ${deployCase.description}`).toEqual([expectation.error]);
      checked++;
    });
  }
  expect(checked).toBeGreaterThanOrEqual(14);
});

describe('matching', () => {
  test('lookahead and negative lookahead never match as JavaScript does (r47, r50)', () => {
    expect(matches('^(?=.*[0-9]).+$', 'ab1')).toBe(false);
    expect(matches('^(?!admin).*$', 'guest')).toBe(false);
    expect(matches('^(?!admin).*$', 'admin')).toBe(false);
  });

  test('\\b reads as b and \\1 as 1 (r47, r50)', () => {
    expect(matches('\\bcat\\b', 'a cat sat')).toBe(false);
    expect(matches('\\bcat\\b', 'bcatb')).toBe(true);
    expect(matches('^(a)\\1$', 'aa')).toBe(false);
    expect(matches('^(a)\\1$', 'a1')).toBe(true);
  });

  test('. matches \\n and \\r (r47, r50)', () => {
    expect(matches('^a.b$', 'a\nb')).toBe(true);
    expect(matches('^a.b$', 'a\rb')).toBe(true);
    expect(matches('^a.b$', 'axb')).toBe(true);
  });

  test('anchors, flags and unanchored search (r11, r47)', () => {
    expect(matches('^[a-z]+$', 'abc\n')).toBe(false);
    expect(matches('^[a-z]+$', 'abc')).toBe(true);
    expect(matches('^[a-z0-9-]+$', 'My Slug')).toBe(false);
    expect(matches('^yes$', 'YES', 'i')).toBe(true);
    expect(matches('foo', 'xfoox')).toBe(true);
    expect(matches('^(red|blue)$', 'green')).toBe(false);
    expect(matches('^a+?$', 'aaa')).toBe(true);
    expect(matches('^admin$', 'admin')).toBe(true);
  });

  test('named classes keep their sets, in and out of character sets', () => {
    expect(matches('^\\d+$', '123')).toBe(true);
    expect(matches('^\\w+$', 'a_1')).toBe(true);
    expect(matches('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', 'a@b.co')).toBe(true);
    expect(matches('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', 'a b@c.co')).toBe(false);
  });

  test('\\s, \\w and \\d are ASCII, and i folds the pattern character (r56)', () => {
    expect(matches('^\\s$', '\t')).toBe(true);
    expect(matches('^\\s$', '\u00a0')).toBe(false);
    expect(matches('^\\S$', '\u00a0')).toBe(true);
    expect(matches('^\\w$', 'é')).toBe(false);
    expect(matches('^k$', '\u212a', 'i')).toBe(false);
    expect(matches('^ı$', 'I', 'i')).toBe(true);
    expect(matches('^[a-z]$', 'Q', 'i')).toBe(true);
    expect(matches('^[a-z]$', '\u212a', 'i')).toBe(false);
    expect(matches('^[^a]$', 'A', 'i')).toBe(false);
  });

  test('an empty pattern is the empty string (r55)', () => {
    expect(rtdbRegexError('^$')).toBeNull();
    expect(matches('^$', '')).toBe(true);
    expect(matches('^$', 'x')).toBe(false);
  });

  test('the anchor rewrite puts no group around a top-level alternation (r54)', () => {
    expect(matches('cat|dog', 'a cat here')).toBe(false);
    expect(matches('cat|dog', 'bobcat')).toBe(true);
    expect(matches('cat|dog', 'dogs')).toBe(true);
    expect(matches('^a|b$', 'ax')).toBe(false);
    expect(matches('(cat|dog)', 'a cat here')).toBe(true);
  });

  test('an empty range never matches (r44)', () => {
    expect(matches('^[z-a]$', 'm')).toBe(false);
    expect(matches('^a{2,1}$', 'aa')).toBe(false);
  });

  test('nested quantifiers run in linear time (LD-6)', () => {
    const started = performance.now();
    expect(matches('^(a+)+$', `${'a'.repeat(5000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('surfaces', () => {
  const refused = { rules: { a: { '.write': 'newData.val().matches(/(^a)/)' } } };
  const deployed = { rules: { b: { '.write': '!newData.val().matches(/\\bcat\\b/)' } } };

  test('lint and the load-time check refuse what production refuses (r46)', () => {
    const lintCodes = rtdbRules(refused).lint().map((issue) => [issue.code, issue.message]);
    expect(lintCodes).toContainEqual(['INVALID_REGEX', MISPLACED_ANCHOR_MESSAGE]);
    expect(rtdbRulesSourceRejection(refused)?.message).toContain(MISPLACED_ANCHOR_MESSAGE);
    expect(rtdbRulesSourceRejection(deployed)).toBeNull();
  });

  test('simulate grants !matches() over \\b where production does (r50)', () => {
    const report = rtdbRules(deployed).simulate([
      { operation: 'write', path: '/b', auth: null, newData: 'a cat sat', expectation: 'ALLOW' },
      { operation: 'write', path: '/b', auth: null, newData: 'bcatb', expectation: 'DENY' },
    ]);
    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });
});
