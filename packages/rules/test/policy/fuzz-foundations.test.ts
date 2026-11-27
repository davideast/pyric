// Unit tests for seeded PRNG, adversarial value generators, and deterministic shrinker.
import { describe, expect, test } from 'bun:test';
import { createRng } from './fuzz-prng.js';
import {
  EDGE_NUMBERS,
  generateValue,
  hostilePayloads,
  shrinkCounterexample,
  shrinkValue,
} from './fuzz-values.js';

describe('differential fuzzer foundations', () => {
  test('createRng produces identical sequences for identical seeds and distinct forks', () => {
    const a = createRng(0x5eed1234);
    const b = createRng(0x5eed1234);
    const seqA = Array.from({ length: 50 }, () => a.nextUint32());
    const seqB = Array.from({ length: 50 }, () => b.nextUint32());
    expect(seqA).toEqual(seqB);

    const f1 = a.fork(1);
    const f2 = a.fork(2);
    expect(f1.nextUint32()).not.toBe(f2.nextUint32());
  });

  test('edge corpus includes NaN, -0.0, MAX_SAFE_INTEGER + 1, and hostile payloads stay lazy', () => {
    expect(EDGE_NUMBERS.some((n) => Number.isNaN(n))).toBe(true);
    expect(EDGE_NUMBERS.some((n) => Object.is(n, -0))).toBe(true);
    expect(EDGE_NUMBERS.includes(Number.MAX_SAFE_INTEGER + 1)).toBe(true);

    const rng = createRng(42);
    const sample = Array.from({ length: 200 }, () => generateValue(rng, { maxDepth: 2 }));
    expect(sample.some((v) => Array.isArray(v))).toBe(true);
    expect(sample.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v))).toBe(true);

    const hostiles = hostilePayloads();
    expect(hostiles.map((h) => h.label)).toEqual(
      expect.arrayContaining([
        'top-level-getter',
        'non-enumerable-getter',
        'symbol-key-getter',
        'array-subclass',
        'sparse-array',
        'own-proto-key',
        'own-constructor-key',
      ]),
    );
    for (const hostile of hostiles) {
      const built = hostile.build();
      expect(built.wasGetterInvoked()).toBe(false);
    }
  });

  test('shrinkCounterexample deterministically minimizes nested failing inputs', () => {
    const initial = { a: [10, 20, 30, 40], b: 'longstring', c: { nested: 99 } };
    const shrunk = shrinkCounterexample(
      initial,
      (v) => shrinkValue(v) as Iterable<typeof initial>,
      (v) => {
        if (!v || typeof v !== 'object') return false;
        const rec = v as Record<string, unknown>;
        return Array.isArray(rec.a) && rec.a.some((x) => typeof x === 'number' && x >= 15);
      },
    );
    expect(shrunk.value).toEqual({ a: [15] });
    expect(shrunk.steps).toBeGreaterThan(0);
    expect(shrunk.steps).toBeLessThan(100);
  });
});
