#!/usr/bin/env bun
// `bun run test`: every suite in the serial chain (package.json `test:serial`),
// run as parallel processes. The CLI and pyric suites, the two long ones, split
// into shards with scripts/ci/test-shard.ts. How many jobs run at once comes
// from how busy the machine is when the run starts; a machine with no room for
// a second job, or `--serial`, runs the chain's commands one at a time with
// their output streaming. Unlike `bun run test:serial`, a failed command does
// not stop the run: every command runs and the failures are reported at the end.
// `--jobs=<n>` sets the count and keeps the shards, even at one.
//
//   bun scripts/test-all.ts [--serial] [--jobs=<n>] [--shards=<n>] [--root=<dir>]
//
// Each job's output is saved to test-results/test-all/<job>.log. The run ends
// with the total test counts, so a parallel run can be checked against a
// serial one. A `bun test` job whose summary is missing, or counts fewer files
// than the plan gave it (a test file that exits the process ends its job
// early), fails.
//
// A full run is heavy: it takes a machine-wide slot (lib/heavy-run-slots.ts)
// before it samples the machine, and waits while two other heavy runs hold
// both slots, so the concurrency it picks reflects the run holding the other.

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeHeavyRunSlot } from './lib/heavy-run-slots.ts';
import { chooseConcurrency, sampleMachineLoad, type MachineLoad } from './lib/test-all/concurrency.ts';
import { addCounts, emptyCounts, formatCounts } from './lib/test-all/counts.ts';
import { planJobs, readSerialChain, type TestJob } from './lib/test-all/plan.ts';
import { runJobs, type JobResult } from './lib/test-all/run-jobs.ts';
import { spawnJob, stopRunningJobs } from './lib/test-all/spawn-job.ts';
import { summaryProblem } from './lib/test-all/summary-check.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_SHARDS = 6;
/** Exit codes for a run stopped by a signal: 128 plus the signal number. */
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
type StopSignal = keyof typeof SIGNAL_EXIT;

interface Options {
  serial: boolean;
  jobs: number | undefined;
  shards: number;
  root: string;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  const isPositiveInteger = Number.isInteger(parsed) && parsed >= 1;
  if (!isPositiveInteger) throw new Error(`${flag} takes a whole number of at least 1, received "${value}"`);
  return parsed;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { serial: false, jobs: undefined, shards: DEFAULT_SHARDS, root: REPO_ROOT };
  for (const arg of args) {
    if (arg === '--serial') options.serial = true;
    else if (arg.startsWith('--jobs=')) options.jobs = positiveInteger(arg.slice('--jobs='.length), '--jobs');
    else if (arg.startsWith('--shards=')) options.shards = positiveInteger(arg.slice('--shards='.length), '--shards');
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length));
    else throw new Error(`unknown option "${arg}"; test-all takes --serial, --jobs=<n>, --shards=<n> and --root=<dir>`);
  }
  return options;
}

/** How many jobs run at once: one under --serial, the --jobs count, or what the machine has room for. */
function concurrencyFor(options: Options, machine: MachineLoad): number {
  if (options.serial) return 1;
  return options.jobs ?? chooseConcurrency(machine);
}

function logPathFor(logDir: string, job: TestJob): string {
  return join(logDir, `${job.name.replace(/[^\w.-]+/g, '-')}.log`);
}

function describeResult(result: JobResult): string {
  const mark = result.exitCode === 0 ? '✓' : '✗';
  return `${mark} ${result.job.name} (${result.seconds.toFixed(1)}s): ${result.counts.pass} pass, ${result.counts.fail} fail`;
}

function reportFailure(result: JobResult, logPath: string): void {
  console.log(`\n━━━ ✗ ${result.job.name}: exit ${result.exitCode}, full log ${logPath} ━━━`);
  console.log([...result.failedTests, '…', ...result.tail].join('\n'));
}

/** A job counts as failed when it exits non-zero or its `bun test` summary is missing or short. */
function withSummaryCheck(result: JobResult): JobResult {
  const problem = summaryProblem(result.job, result.counts);
  if (problem === undefined) return result;
  return { ...result, exitCode: result.exitCode || 1, failedTests: [...result.failedTests, `[test-all] ${problem}`] };
}

function stopJobsOn(signal: StopSignal): void {
  process.on(signal, () => {
    stopRunningJobs('SIGTERM');
    process.exit(SIGNAL_EXIT[signal]);
  });
}

/**
 * The Vite plugin tests in several CLI shards build one shared SharedWorker
 * bundle cache with no lock (#1214), so the bundle is built once before they
 * start.
 */
function warmUpJob(root: string): TestJob {
  return { name: 'warm SharedWorker bundle', command: 'bun', args: ['../../scripts/lib/test-all/warm-worker-bundle.ts'], cwd: join(root, 'packages/cli'), runsBunTest: false };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const logDir = join(options.root, 'test-results', 'test-all');
  await takeHeavyRunSlot();
  const machine = await sampleMachineLoad();
  const concurrency = concurrencyFor(options, machine);
  const isChosenSerial = options.jobs === undefined && concurrency === 1;
  const isSerial = options.serial || isChosenSerial;
  const chain = readSerialChain(options.root, (path) => readFileSync(path, 'utf8'));
  const jobs = planJobs(chain, { root: options.root, shards: isSerial ? 1 : options.shards });
  const isCliShard = (job: TestJob) => job.name.startsWith('cli ') && job.cwd !== options.root;
  const needsWarmBundle = !isSerial && jobs.some(isCliShard);
  const loadPerThread = (machine.load / machine.threads).toFixed(2);
  console.log(`test-all: ${jobs.length} jobs, ${concurrency} at a time (${loadPerThread} busy per thread of ${machine.threads}); logs in ${logDir}`);

  mkdirSync(logDir, { recursive: true });
  for (const signal of Object.keys(SIGNAL_EXIT) as StopSignal[]) stopJobsOn(signal);
  const startedAt = performance.now();
  const run = (job: TestJob) => spawnJob(job, { logPath: logPathFor(logDir, job), echo: isSerial });
  const warmUp = needsWarmBundle ? await runJobs([warmUpJob(options.root)], 1, run) : [];
  const results = [...warmUp, ...await runJobs(jobs, concurrency, run, (result) => {
    console.log(describeResult(withSummaryCheck(result)));
  })].map(withSummaryCheck);
  const seconds = (performance.now() - startedAt) / 1000;

  const failed = results.filter((result) => result.exitCode !== 0);
  if (!isSerial) for (const result of failed) reportFailure(result, logPathFor(logDir, result.job));
  const total = results.map((result) => result.counts).reduce(addCounts, emptyCounts());
  console.log(`\ntest-all: ${formatCounts(total)}; ${results.length - failed.length}/${results.length} jobs passed in ${seconds.toFixed(1)}s`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
