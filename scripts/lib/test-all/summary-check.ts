// A `bun test` process that ends without its summary, or whose summary counts
// fewer files than it was given, did not run all its tests: a test file that
// calls process.exit() ends the process there with whatever exit code it
// chose, and the files after it never run. The exit code alone cannot show it.

import type { TestCounts } from './counts.ts';
import type { TestJob } from './plan.ts';

/** Why a job's summary shows it did not run every test file, or undefined when it did. */
export function summaryProblem(job: TestJob, counts: TestCounts): string | undefined {
  if (!job.runsBunTest) return undefined;
  const hasSummary = counts.files > 0;
  if (!hasSummary) return `${job.name} printed no "Ran N tests across M files" summary, so some test files may not have run`;
  const isShort = job.expectedFiles !== undefined && counts.files < job.expectedFiles;
  if (isShort) return `${job.name} ran ${counts.files} of its ${job.expectedFiles} test files`;
  return undefined;
}
