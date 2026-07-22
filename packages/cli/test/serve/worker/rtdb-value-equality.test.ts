/** Structural equality used when deriving child events from RTDB value snapshots. */
import { describe, expect, it } from 'bun:test';
import { sameRtdbValue } from '../../../src/serve/worker/rtdb-value-equality.js';

describe('sameRtdbValue', () => {
  it('compares nested objects without depending on field order', () => {
    expect(sameRtdbValue(
      { nested: { a: 1, b: [true, null] }, tail: 'same' },
      { tail: 'same', nested: { b: [true, null], a: 1 } },
    )).toBe(true);
  });

  it('keeps arrays ordered and distinct from keyed objects', () => {
    expect(sameRtdbValue([1, 2], [2, 1])).toBe(false);
    expect(sameRtdbValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('detects missing keys and nested value changes', () => {
    expect(sameRtdbValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameRtdbValue({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it('uses Object.is semantics for scalar edge cases', () => {
    expect(sameRtdbValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameRtdbValue(-0, 0)).toBe(false);
    expect(sameRtdbValue(null, null)).toBe(true);
  });
});
