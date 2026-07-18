import { describe, test, expect } from 'bun:test';
import { topK } from '../../../src/firestore/sandbox/topk.js';

const numCmp = (a: number, b: number) => a - b;

describe('topK', () => {
  test('returns the k smallest in ascending order', () => {
    expect(topK([5, 3, 8, 1, 9, 2], 3, numCmp)).toEqual([1, 2, 3]);
  });

  test('k >= length returns the full sorted array', () => {
    expect(topK([3, 1, 2], 5, numCmp)).toEqual([1, 2, 3]);
    expect(topK([3, 1, 2], 3, numCmp)).toEqual([1, 2, 3]);
  });

  test('k <= 0 and empty input return empty', () => {
    expect(topK([3, 1, 2], 0, numCmp)).toEqual([]);
    expect(topK([3, 1, 2], -1, numCmp)).toEqual([]);
    expect(topK([], 3, numCmp)).toEqual([]);
  });

  test('descending comparator (the reversed/limitToLast-style use)', () => {
    expect(topK([5, 3, 8, 1], 2, (a, b) => b - a)).toEqual([8, 5]);
  });

  test('matches sort().slice(0, k) across many deterministic permutations', () => {
    // Fixed LCG (no Math.random) so the property check is reproducible. The
    // query comparator is a TOTAL order, so inputs are de-duped to match.
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const uniq = [...new Set(Array.from({ length: n }, () => Math.floor(rand() * 100)))];
      const k = Math.floor(rand() * (uniq.length + 2));
      const expected = [...uniq].sort(numCmp).slice(0, Math.max(0, k));
      expect(topK(uniq, k, numCmp)).toEqual(expected);
    }
  });
});
