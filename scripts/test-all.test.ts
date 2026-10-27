import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listTests, shardedPackages } from './ci/test-shard.ts';
import { chooseConcurrency } from './lib/test-all/concurrency.ts';
import { readCounts } from './lib/test-all/counts.ts';
import { planJobs, splitChain, type TestJob } from './lib/test-all/plan.ts';
import { runJobs } from './lib/test-all/run-jobs.ts';

const root = resolve(import.meta.dir, '..');
const serialChain = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['test:serial'] ?? '';

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
      expect(shards.every((job) => job.command === 'bun' && job.args[0] === 'test')).toBe(true);
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

  test('a job is named for the package or script it runs', () => {
    const jobs = planJobs('bun test --cwd packages/pyric-admin && bun run test:chat-template && bun run --cwd packages/ui test && bun test scripts/a.test.ts', { root, shards: 1 });
    expect(jobs.map((job) => job.name)).toEqual(['pyric-admin', 'test:chat-template', 'ui', 'scripts']);
  });

  test('a chain the runner cannot run without a shell is refused', () => {
    for (const chain of ['bun test | tee log', 'bun test; bun test', 'FOO=1 bun test', 'bun test "a b"', '', 'bun test &&  && bun test']) {
      expect(() => splitChain(chain)).toThrow();
    }
  });
});

describe('how many jobs test-all runs at once', () => {
  test('an idle machine runs about half its free threads at once', () => {
    expect(chooseConcurrency({ threads: 32, load: 8 })).toBe(12);
    expect(chooseConcurrency({ threads: 8, load: 0.5 })).toBe(3);
  });

  test('a busy machine, 0.7 or more load per thread, runs one job at a time', () => {
    expect(chooseConcurrency({ threads: 32, load: 22.4 })).toBe(1);
    expect(chooseConcurrency({ threads: 4, load: 9 })).toBe(1);
  });

  test('a machine with one or two free threads still runs one job', () => {
    expect(chooseConcurrency({ threads: 2, load: 0.5 })).toBe(1);
    expect(chooseConcurrency({ threads: 1, load: 0 })).toBe(1);
  });
});

describe('the counts test-all reads from a job log', () => {
  test('bun test summaries are summed across every run in one log', () => {
    const log = [
      '(pass) a > b [1.00ms]',
      '',
      ' 735 pass',
      ' 6 skip',
      ' 0 fail',
      ' 4802 expect() calls',
      'Ran 741 tests across 92 files. [58.98s]',
      '$ bun test test/dom',
      ' 10 pass',
      ' 1 todo',
      ' 2 fail',
      'Ran 13 tests across 1 file. [1.00s]',
    ].join('\n');
    expect(readCounts(log)).toEqual({ tests: 754, files: 93, pass: 745, fail: 2, skip: 6, todo: 1 });
  });

  test('node --test summaries count too, in spec and in TAP form', () => {
    const spec = ['ℹ tests 8', 'ℹ suites 0', 'ℹ pass 7', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n');
    const tap = ['# tests 3', '# pass 2', '# fail 1', '# skipped 0', '# todo 0'].join('\n');
    expect(readCounts(`${spec}\n${tap}`)).toEqual({ tests: 11, files: 0, pass: 9, fail: 1, skip: 1, todo: 0 });
  });

  test('a log with no summary counts nothing', () => {
    expect(readCounts('$ tsc --noEmit\n')).toEqual({ tests: 0, files: 0, pass: 0, fail: 0, skip: 0, todo: 0 });
  });
});

describe('running the jobs', () => {
  const job = (name: string): TestJob => ({ name, command: 'bun', args: ['test'], cwd: root });

  test('no more than the concurrency limit run at once, and every job runs', async () => {
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const results = await runJobs([job('a'), job('b'), job('c'), job('d'), job('e')], 2, async (next) => {
      started.push(next.name);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { exitCode: 0, log: '' };
    });
    expect(peak).toBe(2);
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results.map((result) => result.job.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a failing job does not stop the others', async () => {
    const results = await runJobs([job('a'), job('b'), job('c')], 1, async (next) => ({ exitCode: next.name === 'a' ? 1 : 0, log: '' }));
    expect(results.map((result) => [result.job.name, result.exitCode])).toEqual([['a', 1], ['b', 0], ['c', 0]]);
  });
});
