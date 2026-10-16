import { describe, test, expect } from 'bun:test';
import { all, any, not, expr, deny, always, lit, fieldName } from '../../../../src/rules/rtdb/constraints/compose.js';
import { authenticated } from '../../../../src/rules/rtdb/constraints/atoms.js';
import { eq, newDataVal } from '../../../../src/rules/rtdb/constraints/data.js';
import { buildRuleExpression, compileRtdbRules, simulateRtdbRules } from '../../../../src/rules/rtdb/compiled-rules.js';

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

    test('groups an || operand when an earlier regex contains / inside a [...] character class (FUZ-9a)', () => {
      const rule = all(
        any(expr('newData.val().matches(/^[^/]+$/)'), eq(newDataVal(), '')),
        authenticated(),
      );
      expect(rule).toBe("(newData.val().matches(/^[^/]+$/) || newData.val() == '') && auth != null");

      const compiled = compileRtdbRules({ rules: { x: { '.write': rule } } });
      const unauthed = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/x',
        auth: null,
        mockData: {},
        newData: 'hello',
      });
      expect(unauthed.success && unauthed.data.allowed).toBe(false);
    });

    test('a single operand is returned as is', () => {
      expect(all(expr('a || b'))).toBe('a || b');
    });

    test('no operands, or only empty ones, is an error', () => {
      expect(() => all()).toThrow(/all: pass at least one condition/);
      expect(() => all(expr(''))).toThrow(/all: pass at least one condition/);
    });
  });

  describe('any()', () => {
    test('joins with || and groups an operand with a top-level &&', () => {
      expect(any(expr('a'), expr('b && c'))).toBe('a || (b && c)');
    });

    test('a single operand is returned as is', () => {
      expect(any(expr('a'))).toBe('a');
    });

    test('no operands, or only empty ones, is an error', () => {
      expect(() => any()).toThrow(/any: pass at least one condition/);
      expect(() => any(expr(''))).toThrow(/any: pass at least one condition/);
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

    test('rejects an empty expression (BLD-4)', () => {
      expect(() => not(expr(''))).toThrow(/not:/);
      expect(() => not(expr('   '))).toThrow(/not:/);
    });
  });

  describe('lit()', () => {
    test('single-quotes strings and escapes quotes and backslashes', () => {
      expect(lit('a')).toBe("'a'");
      expect(lit("it's")).toBe("'it\\'s'");
      expect(lit('a\\b')).toBe("'a\\\\b'");
      expect(lit(1)).toBe('1');
      expect(lit(true)).toBe('true');
      expect(lit(false)).toBe('false');
      expect(lit(null)).toBe('null');
    });

    test('rejects undefined, objects, arrays, NaN, and Infinity (CON-5 / BLD-4)', () => {
      expect(() => lit(undefined as any)).toThrow(/no literal for undefined/);
      expect(() => lit({} as any)).toThrow(/no literal for object/);
      expect(() => lit([] as any)).toThrow(/no literal for array/);
      expect(() => lit(Number.NaN)).toThrow(/no literal for NaN/);
      expect(() => lit(Number.POSITIVE_INFINITY)).toThrow(/no literal for Infinity/);
      expect(() => lit(Number.NEGATIVE_INFINITY)).toThrow(/no literal for -Infinity/);
      expect(() => eq(newDataVal(), undefined as any)).toThrow(/no literal for undefined/);
    });

    test("quote and backslash escapes read back as the original string in Pyric's simulator", () => {
      for (const value of ["it's", 'a\\b', "\\'", "'\\"]) {
        const compiled = compileRtdbRules({ rules: { v: { '.write': `newData.val() == ${lit(value)}` } } });
        const result = simulateRtdbRules(compiled, { operation: 'write', path: '/v', auth: null, mockData: {}, newData: value });
        if (!result.success) throw new Error(result.error.message);
        expect(result.data.allowed).toBe(true);
      }
    });

    test('refuses strings with newlines or other control characters', () => {
      expect(() => lit('a\nb')).toThrow(/lit: .* control character/);
      expect(() => lit('a\rb')).toThrow(/lit: .* control character/);
      expect(() => lit('a\tb')).toThrow(/lit: .* control character/);
      expect(() => lit('a\u0000b')).toThrow(/lit: .* control character/);
      expect(() => lit('a\u007fb')).toThrow(/lit: .* control character/);
    });
  });

  describe('fieldName()', () => {
    test('accepts valid RTDB child keys and rejects empty or forbidden key characters including / (BLD-1)', () => {
      expect(fieldName('test', 'score')).toBe('score');
      expect(() => fieldName('test', '')).toThrow(/test: '' is not a field name/);
      expect(() => fieldName('test', '/')).toThrow(/test: '\/' is not a field name/);
      expect(() => fieldName('test', 'a/b')).toThrow(/test: 'a\/b' is not a field name/);
      expect(() => fieldName('test', '/a')).toThrow(/test: '\/a' is not a field name/);
      expect(() => fieldName('test', 'a.b')).toThrow(/test: 'a\.b' is not a field name/);
      expect(() => fieldName('test', 'a#b')).toThrow(/test: 'a#b' is not a field name/);
      expect(() => fieldName('test', '$id')).toThrow(/test: '\$id' is not a field name/);
      expect(() => fieldName('test', 'a[0]')).toThrow(/test: 'a\[0\]' is not a field name/);
    });
  });

  test('deny() and always()', () => {
    expect(deny()).toBe('false');
    expect(always()).toBe('true');
  });

  test('a composition parses and keeps its meaning', () => {
    const result = all(expr('auth !== null'), any(not(expr('data.exists()')), expr('x == 1 && y == 2')));
    expect(result).toBe('auth !== null && (!data.exists() || (x == 1 && y == 2))');
    // Undeclared identifiers `x` and `y` are rejected by deploy validation
    // (`rules-rtdb-r29-deploy-rejections` `d01`, `UNKNOWN_IDENTIFIER`, TXT-1);
    // declared `$x` and `$y` path variables validate cleanly.
    expect(buildRuleExpression(result, 'write', []).parsed.valid).toBe(false);
    const validResult = all(expr('auth !== null'), any(not(expr('data.exists()')), expr("$x == '1' && $y == '2'")));
    expect(buildRuleExpression(validResult, 'write', ['$x', '$y']).parsed.valid).toBe(true);
  });
});
