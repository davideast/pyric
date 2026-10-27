import { describe, expect, test } from 'bun:test';
import { emptyCounts } from './counts.ts';
import type { TestJob } from './plan.ts';
import { summaryProblem } from './summary-check.ts';

const shard: TestJob = { name: 'cli 1/6', command: 'bun', args: ['test', './a.test.ts', './b.test.ts'], cwd: '/repo/packages/cli', runsBunTest: true, expectedFiles: 2 };

describe('a bun test job that did not run every file', () => {
  test('a job that ran all its files passes the check', () => {
    expect(summaryProblem(shard, { ...emptyCounts(), tests: 9, files: 2, pass: 9 })).toBeUndefined();
  });

  test('a job with no summary, as when a test file calls process.exit(0), fails it', () => {
    expect(summaryProblem(shard, emptyCounts())).toContain('printed no "Ran N tests across M files" summary');
  });

  test('a job whose summary counts fewer files than it was given fails it', () => {
    expect(summaryProblem(shard, { ...emptyCounts(), tests: 4, files: 1, pass: 4 })).toBe('cli 1/6 ran 1 of its 2 test files');
  });

  test('a job that is not bun test is not checked', () => {
    expect(summaryProblem({ ...shard, name: 'ui', command: 'bun', args: ['run', 'test'], runsBunTest: false }, emptyCounts())).toBeUndefined();
  });
});
