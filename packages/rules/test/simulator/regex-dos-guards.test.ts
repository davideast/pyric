/**
 * Regression tests for regex empty-repeat DoS and deep-nesting guards (#1692).
 *
 * Verifies that zero-state bodies under large or nested repeats and deeply
 * nested groups fail fast across RE2 (Firestore/Storage) and the shared
 * Thompson NFA builder.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_REGEX_NESTING,
  MAX_REGEX_STATES,
} from '../../src/rtdb/grammar/regex-limits.js';
import {
  compileRegexNode,
  matchesRegexNode,
  type RegexNode,
} from '../../src/simulator/regex-nfa.js';
import {
  compileRe2Search,
  parseRe2Ast,
  re2FullMatch,
  re2SizeRefusal,
} from '../../src/simulator/rules-type.js';

function withinMs<T>(limitMs: number, work: () => T): T {
  const start = performance.now();
  const result = work();
  expect(performance.now() - start).toBeLessThan(limitMs);
  return result;
}

describe('RE2 and shared NFA empty-repeat and nesting guards (#1692)', () => {
  test('re2SizeRefusal and re2FullMatch refuse nested empty non-capturing repeats fast', () => {
    const nestedEmpty = '((?:){1000}){1000}';
    withinMs(100, () => {
      const ast = parseRe2Ast(nestedEmpty);
      expect(re2SizeRefusal(nestedEmpty, ast)).toContain(MAX_REGEX_STATES.toLocaleString('en-US'));
      expect(() => re2FullMatch(nestedEmpty, '')).toThrow(/matcher states/);
      expect(() => compileRe2Search('split', nestedEmpty)).toThrow(/matcher states/);
    });

    const nestedZeroRepeat = '((a{0}){1000}){1000}';
    withinMs(100, () => {
      expect(() => re2FullMatch(nestedZeroRepeat, '')).toThrow(/matcher states/);
    });
  });

  test('parseRe2Ast refuses groups nested past MAX_REGEX_NESTING without stack overflow', () => {
    const deep = `${'(?:'.repeat(MAX_REGEX_NESTING + 1)}a${')'.repeat(MAX_REGEX_NESTING + 1)}`;
    withinMs(100, () => {
      expect(() => parseRe2Ast(deep)).toThrow(/nest more than 1000 levels deep/);
    });

    const deep3000 = `${'(?:'.repeat(3000)}a${')'.repeat(3000)}`;
    withinMs(100, () => {
      expect(() => parseRe2Ast(deep3000)).toThrow(/nest more than 1000 levels deep/);
    });

    const fits = `${'(?:'.repeat(100)}a${')'.repeat(100)}`;
    expect(re2FullMatch(fits, 'a')).toBe(true);
    expect(re2FullMatch(fits, 'b')).toBe(false);
  });

  test('buildNfa short-circuits direct zero-state repeat ASTs as defense in depth', () => {
    const hugeExactEmpty: RegexNode = {
      kind: 'rep',
      body: { kind: 'empty' },
      min: 2_000_000_000,
      max: 2_000_000_000,
    };
    const hugeOptionalEmpty: RegexNode = {
      kind: 'rep',
      body: { kind: 'empty' },
      min: 0,
      max: 2_000_000_000,
    };
    withinMs(50, () => {
      expect(matchesRegexNode(hugeExactEmpty, [])).toBe(true);
      expect(matchesRegexNode(hugeExactEmpty, ['a'])).toBe(false);
      expect(compileRegexNode(hugeOptionalEmpty)([])).toBe(true);
    });
  });

  test('long RE2 alternations build a balanced tree without stack overflow (#1692)', () => {
    const emptyAlts = '|'.repeat(40000);
    const charAlts = `${'a|'.repeat(40000)}a`;
    const hugeAlts = `${'a|'.repeat(110000)}a`;
    withinMs(5000, () => {
      expect(re2FullMatch(emptyAlts, '')).toBe(true);
      expect(re2FullMatch(emptyAlts, 'a')).toBe(false);
      expect(re2FullMatch(charAlts, 'a')).toBe(true);
      expect(re2FullMatch(charAlts, 'b')).toBe(false);
      expect(() => re2FullMatch(hugeAlts, 'a')).toThrow(/matcher states/);
    });
  });

  test('valid capturing empty groups and normal repeats keep exact behavior', () => {
    const { search } = compileRe2Search('replace', '()a');
    const span = search(['a'], 0);
    expect(span).not.toBeNull();
    expect(span?.start).toBe(0);
    expect(span?.end).toBe(1);
    expect(span?.slots[2]).toBe(0);
    expect(span?.slots[3]).toBe(0);
    expect(re2FullMatch('(?:a{100}){10}', 'a'.repeat(1000))).toBe(true);
    expect(re2FullMatch('(?:a{100}){10}', 'a'.repeat(999))).toBe(false);
  });
});
