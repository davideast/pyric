import { describe, test, expect } from 'bun:test';
import { all, any, not, expr, deny, always } from '../../../src/database/constraints/compose.js';

describe('compose', () => {
  describe('expr()', () => {
    test('wraps a raw string', () => {
      expect(expr('auth !== null')).toBe('auth !== null');
    });
  });

  describe('all()', () => {
    test('joins with &&', () => {
      expect(all(expr('a'), expr('b'))).toBe('(a) && (b)');
    });

    test('wraps each sub-expression in parens', () => {
      expect(all(expr('a || b'), expr('c'))).toBe('(a || b) && (c)');
    });

    test('single arg returns the expression without joining', () => {
      expect(all(expr('a'))).toBe('(a)');
    });

    test('nested all/any composes correctly', () => {
      const result = all(expr('a'), any(expr('b'), expr('c')));
      expect(result).toBe('(a) && ((b) || (c))');
    });
  });

  describe('any()', () => {
    test('joins with ||', () => {
      expect(any(expr('a'), expr('b'))).toBe('(a) || (b)');
    });

    test('single arg returns the expression', () => {
      expect(any(expr('a'))).toBe('(a)');
    });
  });

  describe('not()', () => {
    test('negates an expression', () => {
      expect(not(expr('a'))).toBe('!(a)');
    });
  });

  describe('deny()', () => {
    test('returns false', () => {
      expect(deny()).toBe('false');
    });
  });

  describe('always()', () => {
    test('returns true', () => {
      expect(always()).toBe('true');
    });
  });

  describe('complex compositions', () => {
    test('all + any + not', () => {
      const result = all(expr('auth !== null'), any(not(expr('data.exists()')), expr('x')));
      expect(result).toBe('(auth !== null) && ((!(data.exists())) || (x))');
    });
  });
});
