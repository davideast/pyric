import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTests, shardedPackages } from '../../ci/test-shard.ts';
import { planJobs, readSerialChain, splitChain } from './plan.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const serialChain = readSerialChain(root, (path) => readFileSync(path, 'utf8'));

/** The files `bun test` discovers in a directory: its documented name patterns, outside node_modules, not through symlinks. */
function bunDiscoveredTests(directory: string, prefix = '.'): string[] {
  const pattern = /(\.test|_test|\.spec|_spec)\.(c|m)?(j|t)sx?$/;
  const found: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    const isSearchedDirectory = entry.isDirectory() && entry.name !== 'node_modules';
    if (isSearchedDirectory) found.push(...bunDiscoveredTests(directory, path));
    else if (entry.isFile() && pattern.test(entry.name)) found.push(path);
  }
  return found.sort();
}

describe('the test-all plan', () => {
  test('the serial plan runs every command of the serial chain, in order, from the repository root', () => {
    const jobs = planJobs(serialChain, { root, shards: 1 });
    expect(jobs.map((job) => [job.command, ...job.args].join(' '))).toEqual(serialChain.split(' && '));
    expect(jobs.every((job) => job.cwd === root)).toBe(true);
  });

  test('the parallel plan runs each sharded suite as shards whose files are exactly the suite', () => {
    const jobs = planJobs(serialChain, { root, shards: 6 });
    for (const [name, packageRoot] of Object.entries(shardedPackages)) {
      const shards = jobs.filter((job) => job.cwd === packageRoot);
      expect(shards.map((job) => job.name)).toEqual([1, 2, 3, 4, 5, 6].map((index) => `${name} ${index}/6`));
      const files = shards.flatMap((job) => job.args.slice(1));
      expect(files.sort()).toEqual(listTests(packageRoot));
      expect(shards.every((job) => job.command === 'bun' && job.args[0] === 'test' && job.runsBunTest)).toBe(true);
      expect(shards.map((job) => job.expectedFiles)).toEqual(shards.map((job) => job.args.length - 1));
    }
  });

  test('the shards hold every file bun test itself would discover in each sharded package', () => {
    for (const packageRoot of Object.values(shardedPackages)) {
      expect(listTests(packageRoot)).toEqual(bunDiscoveredTests(packageRoot));
    }
  });

  test('the parallel plan keeps every other command of the serial chain unchanged, after the shards', () => {
    const jobs = planJobs(serialChain, { root, shards: 6 });
    const unsharded = jobs.filter((job) => job.cwd === root);
    const shardedCommands = Object.keys(shardedPackages).map((name) => `bun test --cwd packages/${name}`);
    const expected = serialChain.split(' && ').filter((command) => !shardedCommands.includes(command));
    expect(unsharded.map((job) => [job.command, ...job.args].join(' '))).toEqual(expected);
    expect(jobs.slice(0, 12).every((job) => job.cwd !== root)).toBe(true);
  });

  test('a job is named for the package or script it runs, and only bun test jobs are checked for a summary', () => {
    const jobs = planJobs('bun test --cwd packages/pyric-admin && bun run test:chat-template && bun run --cwd packages/ui test && bun test scripts/a.test.ts', { root, shards: 1 });
    expect(jobs.map((job) => job.name)).toEqual(['pyric-admin', 'test:chat-template', 'ui', 'scripts']);
    expect(jobs.map((job) => job.runsBunTest)).toEqual([true, false, false, true]);
  });

  test('the serial plan knows how many files a sharded package\'s whole suite runs', () => {
    const jobs = planJobs(serialChain, { root, shards: 1 });
    const cli = jobs.find((job) => job.args.join(' ') === 'test --cwd packages/cli');
    expect(cli?.expectedFiles).toBe(listTests(shardedPackages.cli).length);
  });

  test('a chain the runner cannot run without a shell is refused, and an option with a value is not', () => {
    for (const chain of ['bun test | tee log', 'bun test; bun test', 'FOO=1 bun test', 'bun test "a b"', '', 'bun test &&  && bun test']) {
      expect(() => splitChain(chain)).toThrow();
    }
    expect(splitChain('bun test --timeout=20000 scripts')).toEqual([['bun', 'test', '--timeout=20000', 'scripts']]);
  });
});
