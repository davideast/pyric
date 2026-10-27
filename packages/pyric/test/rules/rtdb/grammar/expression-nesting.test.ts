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
import { MAX_EXPRESSION_LENGTH, expressionTooLongMessage } from '../../../../src/rules/rtdb/expression-engine.js';
import { MAX_BRACKET_DEPTH } from '../../../../src/rules/grammar/bracket-scan.js';

// Reading 6,000 terms takes a few seconds on a slow runner.
const LONG_CHAIN_TIMEOUT_MS = 20_000;

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
    expect(parseExpression(`data.val().matches(/[/${'('.repeat(MAX_BRACKET_DEPTH + 10)}1]/)`).valid).toBe(true);
    expect(parseExpression('data.val().matches(/^[^/]+$/) && (true)').valid).toBe(true);
  });

  test('an incomplete expression with = inside a regex literal does not report an assignment error', () => {
    const parsed = parseExpression('data.val().matches(/a=b/) &&');
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0]!.message).not.toBe('Rule expressions may not contain assignments.');
  });

  test('a division is not read as a regular expression literal', () => {
    expect(parseExpression(`newData.val() / 2 > 1 && ${groups(100)} && newData.val() / 2 < 3`).valid).toBe(true);
  });
});

describe('RTDB expressions: long chains', () => {
  test('a long run of prefix operators is a parse error, not a stack overflow', () => {
    expect(parseExpression(`${'!'.repeat(20_000)}true`).valid).toBe(false);
  });

  // These cases asserted that a chain of thousands of terms is a parse error.
  // Production deploys a 2,000-term `||` chain
  // (rules-rtdb-r51-deploy-anchor-index-and-length-probes, "LD-7: a 2000-term
  // || chain": ACCEPTED), so `||` and `&&` chains now read at any length up to
  // MAX_EXPRESSION_LENGTH, and only text past that bound is refused (LD-7,
  // LD-11, #1247).
  test('an expression longer than the parser reads compiles to a parse error, not an out-of-memory abort', () => {
    const chain = Array.from({ length: 20_000 }, () => 'auth != null').join(' && ');
    expect(chain.length).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    const message = expressionTooLongMessage(chain.length);
    const rule = buildRuleExpression(chain, 'read');
    expect(rule.parsed.valid).toBe(false);
    expect(rule.parsed.errors[0]).toEqual({ code: 'PARSE_ERROR', message });
    // As for brackets nested too deep, parseExpression reports the failure and the other passes add nothing.
    expect(validateExpression(chain, 'read')).toEqual([]);
    expect(lintExpression(chain, 'read')).toEqual([]);
    expect(() => evaluateRtdbExpression(chain, {} as never)).toThrow(message);
  }, LONG_CHAIN_TIMEOUT_MS);

  test('an expression of exactly the bound is matched; one character more is not', () => {
    const atBound = `auth.uid == '${'a'.repeat(MAX_EXPRESSION_LENGTH - 14)}'`;
    expect(atBound.length).toBe(MAX_EXPRESSION_LENGTH);
    expect(parseExpression(atBound).valid).toBe(true);
    expect(parseExpression(`${atBound} `).valid).toBe(true);
    expect(parseExpression(`(${atBound})`).valid).toBe(false);
  }, LONG_CHAIN_TIMEOUT_MS);

  test('parseExpression and validateExpression read 4000 and 6000 chained terms', () => {
    for (const terms of [4000, 6000]) {
      for (const operator of ['&&', '||']) {
        const chain = Array.from({ length: terms }, () => 'true').join(` ${operator} `);
        const parsed = parseExpression(chain);
        expect(parsed.valid).toBe(true);
        expect(parsed.errors).toEqual([]);
        expect(validateExpression(chain, 'read')).toEqual([]);
      }
    }
  }, LONG_CHAIN_TIMEOUT_MS);
});
