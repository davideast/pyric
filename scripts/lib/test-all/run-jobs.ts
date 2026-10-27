// Runs test jobs with a limit on how many run at once. Jobs start in plan
// order, every job runs even when an earlier one fails, and the results come
// back in plan order.

import type { TestJob } from './plan.ts';

export interface JobOutcome {
  exitCode: number;
  log: string;
}

export interface JobResult extends JobOutcome {
  job: TestJob;
  seconds: number;
}

export type StartJob = (job: TestJob) => Promise<JobOutcome>;

export async function runJobs(
  jobs: readonly TestJob[],
  concurrency: number,
  start: StartJob,
  onDone: (result: JobResult) => void = () => {},
): Promise<JobResult[]> {
  const results: JobResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index] as TestJob;
      const startedAt = performance.now();
      const outcome = await start(job);
      const result = { ...outcome, job, seconds: (performance.now() - startedAt) / 1000 };
      results[index] = result;
      onDone(result);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
