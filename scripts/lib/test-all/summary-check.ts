// A `bun test` process that ends without its summary, whose summary counts
// fewer files than it was given, reports unhandled errors outside tests, or
// loads a `*.test.*` file that registers 0 tests did not cleanly run its suite:
// a test file that calls process.exit() or crashes before registering tests
// leaves tests unrun even when `bun test` prints `0 fail` (#1207).

import type { TestCounts } from './counts.ts';
import type { TestJob } from './plan.ts';

/** Why a job's summary shows a missing, truncated, errored, or zero-test run, or undefined when clean. */
export function summaryProblem(job: TestJob, counts: TestCounts): string | undefined {
  if (!job.runsBunTest) return undefined;
  const hasSummary = counts.files > 0;
  if (!hasSummary) {
    return `${job.name} printed no "Ran N tests across M files" summary, so some test files may not have run`;
  }
  const isShort = job.expectedFiles !== undefined && counts.files < job.expectedFiles;
  if (isShort) {
    return `${job.name} ran ${counts.files} of its ${job.expectedFiles} test files`;
  }
  if (counts.errors > 0) {
    return `${job.name} reported ${counts.errors} unhandled error(s) outside tests`;
  }
  if (counts.emptyTestFiles.length > 0) {
    return `${job.name} had test file(s) register 0 tests: ${counts.emptyTestFiles.join(', ')}`;
  }
  return undefined;
}
