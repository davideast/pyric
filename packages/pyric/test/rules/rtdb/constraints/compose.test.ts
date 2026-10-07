import { describe, test, expect } from 'bun:test';
import { all, any, not, expr, deny, always, lit } from '../../../../src/rules/rtdb/constraints/compose.js';
import { buildRuleExpression } from '../../../../src/rules/rtdb/compiled-rules.js';

describe('compose', () => {
  describe('expr()', () => {
    test('wraps a raw string', () => {
      expect(expr('auth !== null')).toBe('auth !== null');
    });
  });

  describe('all()', () => {
    test('joins with && and adds no parentheses an operand does not need', () => {
      expect(all(expr('a'), expr('b == 1'))).toBe('a && b == 1');
    });

    test('groups an operand with a top-level || or ternary', () => {
      expect(all(expr('a || b'), expr('c'))).toBe('(a || b) && c');
      expect(all(expr('a ? b : c'), expr('d'))).toBe('(a ? b : c) && d');
    });

    test('does not group an || inside parentheses, quotes or a regex', () => {
      expect(all(expr('(a || b)'), expr("x == '||'"), expr('s.matches(/a||b/)'))).toBe("(a || b) && x == '||' && s.matches(/a||b/)");
    });

    test('a single operand is returned as is, and no operands is true', () => {
      expect(all(expr('a || b'))).toBe('a || b');
      expect(all()).toBe('true');
    });
  });

  describe('any()', () => {
    test('joins with || and groups an operand with a top-level &&', () => {
      expect(any(expr('a'), expr('b && c'))).toBe('a || (b && c)');
    });

    test('a single operand is returned as is, and no operands is false', () => {
      expect(any(expr('a'))).toBe('a');
      expect(any()).toBe('false');
    });
  });

  describe('not()', () => {
    test('negates a member chain without parentheses', () => {
      expect(not(expr('data.exists()'))).toBe('!data.exists()');
      expect(not(expr("data.child('a').exists()"))).toBe("!data.child('a').exists()");
    });

    test('groups anything else', () => {
      expect(not(expr('a == b'))).toBe('!(a == b)');
    });
  });

  describe('lit()', () => {
    test('single-quotes strings and escapes quotes and backslashes', () => {
      expect(lit('a')).toBe("'a'");
      expect(lit("it's")).toBe("'it\\'s'");
      expect(lit('a\\b')).toBe("'a\\\\b'");
      expect(lit(1)).toBe('1');
      expect(lit(true)).toBe('true');
      expect(lit(null)).toBe('null');
      expect(() => lit(Number.NaN)).toThrow();
    });
  });

  test('deny() and always()', () => {
    expect(deny()).toBe('false');
    expect(always()).toBe('true');
  });

  test('a composition parses and keeps its meaning', () => {
    const result = all(expr('auth !== null'), any(not(expr('data.exists()')), expr('x == 1 && y == 2')));
    expect(result).toBe('auth !== null && (!data.exists() || (x == 1 && y == 2))');
    expect(buildRuleExpression(result, 'write', []).parsed.valid).toBe(true);
  });
});
