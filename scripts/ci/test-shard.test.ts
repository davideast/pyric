import { describe, expect, test } from 'bun:test';
import { listTests, parseShard, partition } from './test-shard.ts';

describe('CLI test shards', () => {
  const files = listTests();

  test('the list covers the CLI test suite and is sorted', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(files.every((file) => file.endsWith('.test.ts'))).toBe(true);
    expect([...files].sort()).toEqual(files);
  });

  for (const total of [1, 2, 3, 5]) {
    test(`the union of ${total} shards is the full list and the shards are disjoint`, () => {
      const shards = Array.from({ length: total }, (_, i) => partition(files, i + 1, total));
      const union = shards.flat();
      expect(union.length).toBe(files.length);
      expect(new Set(union).size).toBe(files.length);
      expect([...union].sort()).toEqual(files);
    });
  }

  test('a file goes to the shard named by its index modulo the shard count', () => {
    const sample = ['a', 'b', 'c', 'd', 'e'];
    expect(partition(sample, 1, 2)).toEqual(['a', 'c', 'e']);
    expect(partition(sample, 2, 2)).toEqual(['b', 'd']);
  });

  test('shard sizes differ by at most one', () => {
    const sizes = [1, 2, 3].map((i) => partition(files, i, 3).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test('parseShard accepts index/total and rejects anything else', () => {
    expect(parseShard('2/3')).toEqual({ index: 2, total: 3 });
    for (const bad of ['0/2', '3/2', '1/0', 'x/2', '1', '1/2/3', '']) {
      expect(() => parseShard(bad)).toThrow();
    }
  });
});
