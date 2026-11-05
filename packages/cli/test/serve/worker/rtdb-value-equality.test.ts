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

  it('agrees with the sandbox JSON equality on -0 and 0', () => {
    expect(sameRtdbValue(0, -0)).toBe(true);
    expect(sameRtdbValue({ n: -0 }, { n: 0 })).toBe(true);
    expect(sameRtdbValue(null, null)).toBe(true);
    expect(sameRtdbValue(1, '1')).toBe(false);
  });

  it('treats a sparse-array hole and null as the same value', () => {
    expect(sameRtdbValue([1, , 3], [1, null, 3])).toBe(true);
    expect(sameRtdbValue({ list: [, 'b'] }, { list: [null, 'b'] })).toBe(true);
    expect(sameRtdbValue([1, null], [1, 2])).toBe(false);
  });

  it('compares an own __proto__ key as data', () => {
    const left: unknown = JSON.parse('{"__proto__":{"a":1}}');
    const same: unknown = JSON.parse('{"__proto__":{"a":1}}');
    const changed: unknown = JSON.parse('{"__proto__":{"a":2}}');
    expect(sameRtdbValue(left, same)).toBe(true);
    expect(sameRtdbValue(left, changed)).toBe(false);
    expect(sameRtdbValue(left, {})).toBe(false);
  });
});
