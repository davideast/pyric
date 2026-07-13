import { describe, test, expect } from 'bun:test';
import type { Expr } from '../../../../src/rules/rtdb/constraints/types.js';
import { expr } from '../../../../src/rules/rtdb/constraints/compose.js';

describe('Expr branded type', () => {
  test('expr() returns a string', () => {
    const e = expr('auth !== null');
    expect(typeof e).toBe('string');
    expect(e).toBe('auth !== null');
  });

  test('expr() output is usable as a string', () => {
    const e = expr('auth !== null');
    expect(e.includes('auth')).toBe(true);
    expect(e.length).toBeGreaterThan(0);
  });
});
