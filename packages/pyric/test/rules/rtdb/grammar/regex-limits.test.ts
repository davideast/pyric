/**
 * Resource limits on RTDB regex literals (#1247 S1 review). A literal's
 * repeat counts, size and nesting are bounded before any matcher is built,
 * so a short pattern cannot exhaust the CLI host, Studio or the sandbox, and
 * a match costs time linear in the subject. The count and size refusals use
 * production's texts (r58, r59, r60); the state and nesting limits are
 * pyric's own.
 */
import { describe, expect, test } from 'bun:test';
import {
  DETERMINIZE_MESSAGE,
  MAX_REGEX_NESTING,
  MAX_REGEX_POSITIONS,
  MAX_REGEX_STATES,
  compileRtdbRegex,
  rtdbRegexError,
} from '../../../../src/rules/rtdb/grammar/regex.js';
import { rtdbRules } from '../../../../src/rules/api/rtdb.js';

const MEMORY_BUDGET = 64 * 1024 * 1024;

/** Run `work`, and fail if it takes longer than `ms` or grows the heap past the budget. */
function withinBudget<T>(ms: number, work: () => T): T {
  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = work();
  const elapsed = performance.now() - started;
  const grown = process.memoryUsage().heapUsed - heapBefore;
  expect(elapsed).toBeLessThan(ms);
  expect(grown).toBeLessThan(MEMORY_BUDGET);
  return result;
}

describe('repeat counts', () => {
  test('a count past 2^31-1 fails with Java parseInt text, as production reports it (r58)', () => {
    expect(withinBudget(100, () => rtdbRegexError('^a{2147483648}$'))).toBe('For input string: "2147483648"');
    expect(withinBudget(100, () => rtdbRegexError('a{99999999999999999999}'))).toBe('For input string: "99999999999999999999"');
    // 2^31-1 itself reads as a count, then is too large to determinize.
    expect(rtdbRegexError('^a{2147483647}$')).toBe(DETERMINIZE_MESSAGE);
  });

  test('a pattern too large to determinize fails with production text, without building a matcher (r59, r60)', () => {
    expect(withinBudget(100, () => rtdbRegexError('^a{100000}$'))).toBe(DETERMINIZE_MESSAGE);
    expect(withinBudget(100, () => rtdbRegexError('^(a{1000}){1000}$'))).toBe(DETERMINIZE_MESSAGE);
    expect(withinBudget(100, () => rtdbRegexError('a{10000000}'))).toBe(DETERMINIZE_MESSAGE);
    expect(withinBudget(100, () => rtdbRegexError('((a{1000}){1000}){1000}'))).toBe(DETERMINIZE_MESSAGE);
  });

  test(`the position limit sits at ${MAX_REGEX_POSITIONS}, a threshold production has not shown`, () => {
    expect(rtdbRegexError(`^a{${MAX_REGEX_POSITIONS}}$`)).toBeNull();
    expect(rtdbRegexError(`^a{${MAX_REGEX_POSITIONS + 1}}$`)).toBe(DETERMINIZE_MESSAGE);
  });

  test('a repeat of an empty group has no positions but stops at the state limit', () => {
    expect(withinBudget(100, () => rtdbRegexError('^(){0,2147483647}$'))).toContain(`more than ${MAX_REGEX_STATES} matcher states`);
  });

  test('a large count that fits compiles and matches within budget', () => {
    const regex = compileRtdbRegex(`^a{${MAX_REGEX_POSITIONS}}$`, '');
    withinBudget(2000, () => {
      expect(regex.test('a'.repeat(MAX_REGEX_POSITIONS))).toBe(true);
      expect(regex.test('a'.repeat(MAX_REGEX_POSITIONS - 1))).toBe(false);
    });
  });

  test('an optional run matches a long subject in time linear in its length', () => {
    const regex = compileRtdbRegex('x{0,1000}', '');
    withinBudget(500, () => {
      expect(regex.test('y'.repeat(100000))).toBe(true);
      expect(regex.test('y'.repeat(100000))).toBe(true);
    });
  });
});

describe('nesting', () => {
  test(`groups nested past ${MAX_REGEX_NESTING} levels are refused with their own message`, () => {
    const deep = `${'('.repeat(MAX_REGEX_NESTING + 1)}a${')'.repeat(MAX_REGEX_NESTING + 1)}`;
    expect(rtdbRegexError(deep)).toContain(`nest more than ${MAX_REGEX_NESTING} levels deep`);
    const fits = `${'('.repeat(MAX_REGEX_NESTING)}a${')'.repeat(MAX_REGEX_NESTING)}`;
    expect(rtdbRegexError(fits)).toBeNull();
    expect(compileRtdbRegex(fits, '').test('a')).toBe(true);
  });

  test('20,000 nested groups lint as a regex limit, not as a chained-terms parse error', () => {
    const deep = `${'('.repeat(20000)}a${')'.repeat(20000)}`;
    const issues = rtdbRules({ rules: { a: { '.write': `newData.val().matches(/${deep}/)` } } }).lint();
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('INVALID_REGEX');
    expect(codes).not.toContain('PARSE_ERROR');
  });

  test('long alternations and quantifier chains do not overflow the stack', () => {
    expect(rtdbRegexError(`^${Array.from({ length: 9000 }, () => 'a').join('|')}$`)).toBeNull();
    expect(rtdbRegexError(`^${Array.from({ length: 50000 }, () => 'a').join('|')}$`)).toBe(DETERMINIZE_MESSAGE);
    expect(compileRtdbRegex(`^${Array.from({ length: 2000 }, (_, i) => `w${i}`).join('|')}$`, '').test('w1999')).toBe(true);
    expect(rtdbRegexError(`a${'*'.repeat(50000)}`)).toContain(`nest more than ${MAX_REGEX_NESTING} levels deep`);
  });
});

describe('surfaces', () => {
  test('lint and simulate refuse a pattern past the limits quickly', () => {
    const engine = rtdbRules({ rules: { a: { '.write': 'newData.val().matches(/((a{1000}){1000}){1000}/)' } } });
    withinBudget(1000, () => {
      expect(engine.lint().map((issue) => issue.code)).toContain('INVALID_REGEX');
      const report = engine.simulate([{ operation: 'write', path: '/a', auth: null, newData: 'a', expectation: 'DENY' }]);
      expect(report.cases[0]!.decision).toBe('UNSUPPORTED');
    });
  });
});
