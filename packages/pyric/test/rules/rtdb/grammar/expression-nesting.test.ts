/**
 * A deeply nested or very long RTDB rule expression is a parse error, never
 * a stack overflow. Production documents no nesting limit for RTDB rules;
 * the bracket bound is the parser's own.
 */
import { describe, expect, test } from 'bun:test';
import { parseExpression } from '../../../../src/rules/rtdb/grammar/RtdbExprParser.js';
import { lintExpression } from '../../../../src/rules/rtdb/grammar/linter.js';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';
import { evaluateRtdbExpression } from '../../../../src/rules/rtdb/grammar/simulator.js';
import { buildRuleExpression } from '../../../../src/rules/rtdb/compiled-rules.js';
import { MAX_BRACKET_DEPTH } from '../../../../src/rules/grammar/bracket-scan.js';

const groups = (n: number, inner = 'auth != null') => `${'('.repeat(n)}${inner}${')'.repeat(n)}`;

describe('RTDB expressions: nesting', () => {
  test('1000 nested parentheses are a parse error, not a stack overflow', () => {
    const parsed = parseExpression(groups(1000));
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0]!.code).toBe('PARSE_ERROR');
    expect(parsed.errors[0]!.message).toContain(`more than ${MAX_BRACKET_DEPTH} levels deep`);
    expect(lintExpression(groups(1000))).toEqual([]);
    expect(validateExpression(groups(1000), 'read')).toEqual([]);
    expect(() => evaluateRtdbExpression(groups(1000), {} as never)).toThrow(`more than ${MAX_BRACKET_DEPTH} levels deep`);
  });

  test(`${MAX_BRACKET_DEPTH} nested parentheses parse; one more does not`, () => {
    expect(parseExpression(groups(MAX_BRACKET_DEPTH)).valid).toBe(true);
    expect(parseExpression(groups(MAX_BRACKET_DEPTH + 1)).valid).toBe(false);
  });

  test('nested array literals and index access are bounded the same way', () => {
    expect(parseExpression(`${'['.repeat(1000)}1${']'.repeat(1000)} == 1`).valid).toBe(false);
    expect(parseExpression(`data${"[data.val()".repeat(1000)}${']'.repeat(1000)}.exists()`).valid).toBe(false);
  });

  test('parentheses in a string or a regular expression literal are not counted', () => {
    const open = '('.repeat(1000);
    expect(parseExpression(`auth.uid == '${open}'`).valid).toBe(true);
    expect(parseExpression(`auth.uid == "${open}"`).valid).toBe(true);
    expect(parseExpression(`auth.uid.matches(/^\\${open}$/)`).valid).toBe(true);
    expect(parseExpression(`newData.val().matches(/[(]/) && ${groups(100)}`).valid).toBe(true);
  });

  test('a division is not read as a regular expression literal', () => {
    expect(parseExpression(`newData.val() / 2 > 1 && ${groups(100)} && newData.val() / 2 < 3`).valid).toBe(true);
  });
});

describe('RTDB expressions: long chains', () => {
  test('a long run of prefix operators is a parse error, not a stack overflow', () => {
    expect(parseExpression(`${'!'.repeat(20_000)}true`).valid).toBe(false);
  });

  test('a chain of thousands of terms compiles to a parse error, not a stack overflow', () => {
    const chain = Array.from({ length: 20_000 }, () => 'auth != null').join(' && ');
    const rule = buildRuleExpression(chain, 'read');
    expect(rule.parsed.valid).toBe(false);
    expect(rule.parsed.errors[0]!.code).toBe('PARSE_ERROR');
  });
});
