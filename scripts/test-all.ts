#!/usr/bin/env bun
// `bun run test`: every suite in the serial chain (package.json `test:serial`),
// run as parallel processes. The CLI and pyric suites, the two long ones, split
// into shards with scripts/ci/test-shard.ts. How many jobs run at once comes
// from the machine's load when the run starts; a busy machine, or `--serial`,
// runs the chain as written, one command at a time, with its output streaming.
//
//   bun scripts/test-all.ts [--serial] [--jobs=<n>] [--shards=<n>]
//
// Each job's output is saved to test-results/test-all/<job>.log. The run ends
// with the total test counts, so a parallel run can be checked against a
// serial one.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chooseConcurrency, measureMachineLoad } from './lib/test-all/concurrency.ts';
import { addCounts, emptyCounts, formatCounts, readCounts } from './lib/test-all/counts.ts';
import { planJobs, readSerialChain, type TestJob } from './lib/test-all/plan.ts';
import { runJobs, type JobResult } from './lib/test-all/run-jobs.ts';
import { runningChildren, spawnJob } from './lib/test-all/spawn-job.ts';

const ROOT = resolve(import.meta.dir, '..');
const LOG_DIR = join(ROOT, 'test-results', 'test-all');
const DEFAULT_SHARDS = 6;
const FAILURE_TAIL_LINES = 40;

interface Options {
  serial: boolean;
  jobs: number | undefined;
  shards: number;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  const isPositiveInteger = Number.isInteger(parsed) && parsed >= 1;
  if (!isPositiveInteger) throw new Error(`${flag} takes a whole number of at least 1, received "${value}"`);
  return parsed;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { serial: false, jobs: undefined, shards: DEFAULT_SHARDS };
  for (const arg of args) {
    if (arg === '--serial') options.serial = true;
    else if (arg.startsWith('--jobs=')) options.jobs = positiveInteger(arg.slice('--jobs='.length), '--jobs');
    else if (arg.startsWith('--shards=')) options.shards = positiveInteger(arg.slice('--shards='.length), '--shards');
    else throw new Error(`unknown option "${arg}"; test-all takes --serial, --jobs=<n> and --shards=<n>`);
  }
  return options;
}

function logPathFor(job: TestJob): string {
  return join(LOG_DIR, `${job.name.replace(/[^\w.-]+/g, '-')}.log`);
}

function describeResult(result: JobResult): string {
  const mark = result.exitCode === 0 ? '✓' : '✗';
  const counts = readCounts(result.log);
  return `${mark} ${result.job.name} (${result.seconds.toFixed(1)}s): ${counts.pass} pass, ${counts.fail} fail`;
}

function reportFailure(result: JobResult): void {
  const lines = result.log.trimEnd().split('\n');
  const failedTests = lines.filter((line) => line.startsWith('(fail)') || line.startsWith('✖'));
  console.log(`\n━━━ ✗ ${result.job.name}: exit ${result.exitCode}, full log ${logPathFor(result.job)} ━━━`);
  console.log([...failedTests, '…', ...lines.slice(-FAILURE_TAIL_LINES)].join('\n'));
}

function stopChildrenOn(signal: NodeJS.Signals): void {
  process.on(signal, () => {
    for (const child of runningChildren) child.kill('SIGTERM');
    process.exit(130);
  });
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const machine = measureMachineLoad();
  const concurrency = options.serial ? 1 : options.jobs ?? chooseConcurrency(machine);
  const isSerial = concurrency === 1;
  const jobs = planJobs(readSerialChain(ROOT, (path) => readFileSync(path, 'utf8')), { root: ROOT, shards: isSerial ? 1 : options.shards });
  const loadPerThread = (machine.load / machine.threads).toFixed(2);
  console.log(`test-all: ${jobs.length} jobs, ${concurrency} at a time (load ${loadPerThread} per thread, ${machine.threads} threads); logs in ${LOG_DIR}`);

  stopChildrenOn('SIGINT');
  stopChildrenOn('SIGTERM');
  const startedAt = performance.now();
  const results = await runJobs(jobs, concurrency, (job) => spawnJob(job, { logPath: logPathFor(job), echo: isSerial }), (result) => {
    console.log(describeResult(result));
  });
  const seconds = (performance.now() - startedAt) / 1000;

  const failed = results.filter((result) => result.exitCode !== 0);
  if (!isSerial) failed.forEach(reportFailure);
  const total = results.map((result) => readCounts(result.log)).reduce(addCounts, emptyCounts());
  console.log(`\ntest-all: ${formatCounts(total)}; ${results.length - failed.length}/${results.length} jobs passed in ${seconds.toFixed(1)}s`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
