import { describe, expect, test } from 'bun:test';
import { DEFAULT_FILE_SECONDS, listTests, parseShard, partition, shardedPackages, slowFiles } from './test-shard.ts';

describe('CLI test shards', () => {
  const files = listTests();

  test('the list covers the CLI test suite and is sorted', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(files.every((file) => file.endsWith('.test.ts'))).toBe(true);
    expect([...files].sort()).toEqual(files);
  });

  test('the pyric list covers its suite, the .spec.ts files bun test also discovers included', () => {
    const pyric = listTests(shardedPackages.pyric);
    expect(pyric.length).toBeGreaterThan(600);
    expect(pyric.some((file) => file.endsWith('.spec.ts'))).toBe(true);
    expect(pyric.every((file) => file.endsWith('.test.ts') || file.endsWith('.spec.ts'))).toBe(true);
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

  test('the rules list covers the engine suite that moved out of packages/pyric', () => {
    const rules = listTests(shardedPackages.rules);
    expect(rules.length).toBeGreaterThan(100);
    expect(rules.every((file) => file.endsWith('.test.ts') || file.endsWith('.spec.ts'))).toBe(true);
  });

  for (const name of ['cli', 'pyric', 'rules'] as const) {
    const suite = listTests(shardedPackages[name]);
    const seconds = slowFiles[name];

    test(`every recorded ${name} time names a file in the suite`, () => {
      expect(Object.keys(seconds).filter((file) => !suite.includes(file))).toEqual([]);
    });

    for (const total of [1, 2, 3, 4]) {
      test(`the ${total} timed ${name} shards are disjoint, in list order, and together the full list`, () => {
        const shards = Array.from({ length: total }, (_, i) => partition(suite, i + 1, total, seconds));
        for (const shard of shards) expect([...shard].sort()).toEqual(shard);
        const union = shards.flat();
        expect(union.length).toBe(suite.length);
        expect([...union].sort()).toEqual(suite);
      });
    }

    test(`the timed ${name} shards are within one slow file of an even split`, () => {
      const time = (file: string): number => seconds[file] ?? DEFAULT_FILE_SECONDS;
      const total = 3;
      const loads = Array.from({ length: total }, (_, i) =>
        partition(suite, i + 1, total, seconds).reduce((sum, file) => sum + time(file), 0));
      const whole = suite.reduce((sum, file) => sum + time(file), 0);
      const slowest = Math.max(...suite.map(time));
      expect(Math.max(...loads)).toBeLessThanOrEqual(whole / total + slowest);
    });
  }

  test('a recorded time moves a slow file away from the other slow files', () => {
    const sample = ['a', 'b', 'c', 'd', 'e', 'f'];
    const shards = [1, 2].map((i) => partition(sample, i, 2, { a: 10, c: 10 }));
    expect(shards[0]).toContain('a');
    expect(shards[1]).toContain('c');
  });

  test('parseShard accepts index/total and rejects anything else', () => {
    expect(parseShard('2/3')).toEqual({ index: 2, total: 3 });
    for (const bad of ['0/2', '3/2', '1/0', 'x/2', '1', '1/2/3', '']) {
      expect(() => parseShard(bad)).toThrow();
    }
  });
});
