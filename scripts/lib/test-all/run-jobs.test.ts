import { describe, expect, test } from 'bun:test';
import { emptyCounts } from './counts.ts';
import type { TestJob } from './plan.ts';
import { runJobs } from './run-jobs.ts';

const job = (name: string): TestJob => ({ name, command: 'bun', args: ['test'], cwd: '/repo', runsBunTest: true });
const outcome = (exitCode: number) => ({ exitCode, counts: emptyCounts(), failedTests: [], tail: [] });

describe('running the jobs', () => {
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
      return outcome(0);
    });
    expect(peak).toBe(2);
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results.map((result) => result.job.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a failing job does not stop the others', async () => {
    const results = await runJobs([job('a'), job('b'), job('c')], 1, async (next) => outcome(next.name === 'a' ? 1 : 0));
    expect(results.map((result) => [result.job.name, result.exitCode])).toEqual([['a', 1], ['b', 0], ['c', 0]]);
  });
});
