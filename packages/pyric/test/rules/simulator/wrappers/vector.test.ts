/**
 * Vector wrapper unit tests — Item 5.
 *
 * Vectors are not first-class in the rules language (no `is vector`
 * type test, no instance methods). The wrapper exists so write-side
 * round-trip preserves dimension and element values, and so the
 * write-boundary resolver has a class instance to skip past rather
 * than the plain object that would silently lose its prototype.
 */
import { describe, test, expect } from 'bun:test';
import { Vector } from '../../../../src/rules/simulator/wrappers/vector.js';

describe('Vector wrapper', () => {
  test('typeName is "vector"', () => {
    expect(new Vector([1, 2, 3]).typeName).toBe('vector');
  });

  test('.value is a defensive copy of the input', () => {
    const input = [0.1, 0.2, 0.3];
    const v = new Vector(input);
    input[0] = 9;
    expect(v.value[0]).toBe(0.1);
  });

  test('.value is frozen — wrapper is immutable', () => {
    const v = new Vector([1, 2, 3]);
    expect(Object.isFrozen(v.value)).toBe(true);
  });

  test('.dimension reports the element count', () => {
    expect(new Vector([]).dimension).toBe(0);
    expect(new Vector([1]).dimension).toBe(1);
    expect(new Vector([1, 2, 3]).dimension).toBe(3);
  });

  test('throws when value is not an array', () => {
    expect(() => new Vector(null as unknown as number[])).toThrow(/value must be a number\[\]/);
  });

  test('throws when any element is not a number', () => {
    expect(() => new Vector([1, 'two' as unknown as number, 3])).toThrow(/element at index 1/);
  });

  test('toString() emits a readable bracketed form', () => {
    expect(String(new Vector([1, 2.5, 3]))).toBe('[1, 2.5, 3]');
  });

  test('valueOf() is NaN — no meaningful numeric coercion', () => {
    expect(new Vector([1, 2]).valueOf()).toBeNaN();
  });

  test('toJSON() emits the wire sentinel shape', () => {
    expect(new Vector([0.1, 0.2]).toJSON()).toEqual({
      __type__: '__vector__',
      value: [0.1, 0.2],
    });
  });

  test('equals() compares element-wise', () => {
    expect(new Vector([1, 2, 3]).equals(new Vector([1, 2, 3]))).toBe(true);
    expect(new Vector([1, 2, 3]).equals(new Vector([1, 2]))).toBe(false);
    expect(new Vector([1, 2, 3]).equals(new Vector([1, 2, 4]))).toBe(false);
    expect(new Vector([1, 2, 3]).equals([1, 2, 3])).toBe(false); // array is not a Vector
    expect(new Vector([1, 2, 3]).equals(null)).toBe(false);
  });

  test('two distinct empty vectors are equal', () => {
    expect(new Vector([]).equals(new Vector([]))).toBe(true);
  });
});
