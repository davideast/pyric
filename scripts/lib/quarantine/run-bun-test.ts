// Runs `bun test`. With quarantine on (`--quarantine`, source.ts), it adds a JUnit report
// beside the usual console output and lets the quarantine verdict decide the
// exit code; otherwise it runs `bun test` without forgiving quarantined tests,
// while still enforcing JUnit and summary integrity so a test file that crashes
// or exits before registering tests can never pass (#1207). Each run gets its
// own private TMPDIR under ~/.cache/pyric-tmp/<suite> removed on finish.

import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../private-job-tmpdir.ts';
import { REPO_ROOT, todayUtc, type LoadedEntry } from './entries.ts';
import { consoleTotals, parseJunit } from './junit.ts';
import { publish } from './report.ts';
import {
  BUN_TEST_FILE_PATTERN,
  VALUE_FLAGS,
  expectedSuiteFiles,
  suiteIntegrityProblem,
} from './run-bun-test-integrity.ts';
import { runEntries } from './source.ts';
import { honouredEntries } from './validate.ts';
import { decide, finalResults, type RunEvidence, type Verdict } from './verdict.ts';

/** bun prints its totals last; this much of the end of stderr holds them. */
const TAIL_BYTES = 64 * 1024;

/**
 * Maximum explicit test files passed to a single `bun test` process. Each
 * loaded file stays rooted in JavaScriptCore's module graph (along with
 * preloaded `FSWatcher`s and `JSDebugHTTPServer` wrappers); past ~2 GB RSS on
 * 360+ CLI files, Bun 1.3.11 can segfault inside JSC parallel GC butterfly
 * marking (#3392). Splitting large explicit file lists into bounded child
 * processes reclaims the entire JSC heap and native handles between batches.
 */
export const DEFAULT_MAX_FILES_PER_BATCH = 50;

export interface BunTestRun {
  /** Absolute directory bun runs in. */
  cwd: string;
  /** Arguments after `bun test`. */
  args: string[];
  /** The report's name: test-results/quarantine/<suite>.json. */
  suite: string;
  /** For tests: these entries in place of the committed, checked ones. */
  entries?: LoadedEntry[];
  /** For tests: the UTC date in place of today. */
  today?: string;
  /** Where bun's stderr goes; process.stderr by default. */
  forward?: (chunk: string) => void;
  /** Whether quarantine is on: the runner was given `--quarantine`. */
  quarantine: boolean;
  /** The environment entries and `publish` read; process.env by default. */
  env?: NodeJS.ProcessEnv;
  /** Maximum explicit test files per `bun test` child process (80 by default). */
  maxFilesPerBatch?: number;
}

interface Finished {
  exitCode: number | null;
  stderrTail: string;
}

function childEnvWithPrivateTmp(jobTmpDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMPDIR: jobTmpDir,
    TMP: jobTmpDir,
    TEMP: jobTmpDir,
  };
}

function forwardingStdio(captureStdout: boolean): StdioOptions {
  if (captureStdout) {
    return ['inherit', 'pipe', 'pipe'];
  }
  return ['inherit', 'inherit', 'pipe'];
}

function runForwarding(
  cwd: string,
  args: string[],
  jobTmpDir: string,
  forward: (chunk: string) => void,
  captureStdout: boolean,
): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', args, {
      cwd,
      env: childEnvWithPrivateTmp(jobTmpDir),
      stdio: forwardingStdio(captureStdout),
    });
    let tail = '';
    if (captureStdout && child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        forward(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        forward(chunk);
        tail = (tail + chunk).slice(-TAIL_BYTES);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ exitCode: code, stderrTail: tail }));
  });
}

function readResults(junitFile: string, cwd: string): RunEvidence['results'] {
  if (!existsSync(junitFile)) return undefined;
  try {
    return parseJunit(readFileSync(junitFile, 'utf8'), relative(REPO_ROOT, cwd));
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    console.error(`quarantine: could not read ${junitFile}: ${reason}`);
    return undefined;
  }
}

function stderrWriter(forwardOption: BunTestRun['forward']): (chunk: string) => void {
  if (forwardOption !== undefined) {
    return forwardOption;
  }
  return (chunk: string) => {
    process.stderr.write(chunk);
  };
}

let junitSeq = 0;

function unlinkIfPresent(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

interface BatchOutcome {
  exitCode: number | null;
  results: RunEvidence['results'];
  totals: RunEvidence['totals'];
  problem: string | undefined;
}

/**
 * Splits explicit test-file targets exceeding `maxFilesPerBatch` into balanced
 * batches while preserving shared `bun test` flags on every batch. Leaves
 * directory/default discovery and `--bail` invocations untouched as one batch.
 */
export function splitBatchArgs(
  args: readonly string[],
  maxFilesPerBatch: number = DEFAULT_MAX_FILES_PER_BATCH,
): string[][] {
  if (maxFilesPerBatch < 1) {
    throw new Error(`maxFilesPerBatch must be at least 1, received ${maxFilesPerBatch}`);
  }
  const sharedFlags: string[] = [];
  const targets: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--bail' || arg.startsWith('--bail=')) {
      return [[...args]];
    }
    if (VALUE_FLAGS.has(arg)) {
      sharedFlags.push(arg);
      const next = args[i + 1];
      if (next !== undefined) {
        sharedFlags.push(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      sharedFlags.push(arg);
      continue;
    }
    targets.push(arg);
  }
  const canBatch =
    targets.length > maxFilesPerBatch
    && targets.every((target) => BUN_TEST_FILE_PATTERN.test(target));
  if (!canBatch) {
    return [[...args]];
  }
  const batchCount = Math.ceil(targets.length / maxFilesPerBatch);
  const chunkSize = Math.ceil(targets.length / batchCount);
  const batches: string[][] = [];
  for (let offset = 0; offset < targets.length; offset += chunkSize) {
    batches.push([...sharedFlags, ...targets.slice(offset, offset + chunkSize)]);
  }
  return batches;
}

async function executeBatch(run: BunTestRun, batchArgs: string[]): Promise<BatchOutcome> {
  const expected = expectedSuiteFiles(run.cwd, batchArgs);
  const jobTmpDir = createPrivateJobTmpDir(run.suite);
  const junitBase = process.env.RUNNER_TEMP ?? jobTmpDir;
  junitSeq += 1;
  const junitFile = join(junitBase, `pyric-junit-${process.pid}-${junitSeq}.xml`);
  try {
    const args = ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...batchArgs];
    const forward = stderrWriter(run.forward);
    const finished = await runForwarding(run.cwd, args, jobTmpDir, forward, run.forward !== undefined);
    const results = readResults(junitFile, run.cwd);
    const totals = consoleTotals(finished.stderrTail);
    const problem = suiteIntegrityProblem({
      cwd: run.cwd,
      exitCode: finished.exitCode,
      stderrTail: finished.stderrTail,
      results,
      totals,
      expected,
    });
    return { exitCode: finished.exitCode, results, totals, problem };
  } finally {
    unlinkIfPresent(junitFile);
    removePrivateJobTmpDir(jobTmpDir);
  }
}

function isSignalExit(exitCode: number | null): boolean {
  return exitCode === null || exitCode > 128;
}

function combineBatchOutcomes(outcomes: readonly BatchOutcome[]): {
  evidence: RunEvidence;
  problem: string | undefined;
  nonZeroExitCode: number | undefined;
} {
  if (outcomes.length === 1) {
    const only = outcomes[0]!;
    const nonZeroExitCode =
      only.exitCode !== null && only.exitCode !== 0 ? only.exitCode : undefined;
    return {
      evidence: { exitCode: only.exitCode, results: only.results, totals: only.totals },
      problem: only.problem,
      nonZeroExitCode,
    };
  }

  let combinedExitCode: number | null = 0;
  let nonZeroExitCode: number | undefined;
  let missingResults = false;
  let unattributedFailure = false;
  let totalFail = 0;
  let totalErrors = 0;
  const combinedResults: NonNullable<RunEvidence['results']> = [];

  for (const outcome of outcomes) {
    totalErrors += outcome.totals.errors;
    if (outcome.results === undefined) {
      missingResults = true;
    } else {
      combinedResults.push(...outcome.results);
    }

    if (outcome.exitCode !== 0) {
      if (nonZeroExitCode === undefined && outcome.exitCode !== null) {
        nonZeroExitCode = outcome.exitCode;
      }
      if (outcome.exitCode === null) {
        combinedExitCode = null;
      } else if (combinedExitCode !== null && outcome.exitCode !== 1) {
        combinedExitCode = outcome.exitCode;
      } else if (combinedExitCode === 0) {
        combinedExitCode = 1;
      }

      const batchFailures = finalResults(outcome.results ?? []).filter(
        (item) => item.outcome === 'failed',
      ).length;
      if (
        outcome.exitCode !== 1
        || outcome.results === undefined
        || batchFailures === 0
        || outcome.totals.fail !== batchFailures
      ) {
        unattributedFailure = true;
      }
    }

    if (outcome.totals.fail === undefined) {
      if (outcome.exitCode !== 0) {
        unattributedFailure = true;
      }
    } else {
      totalFail += outcome.totals.fail;
    }
  }

  const problem = outcomes.find((outcome) => outcome.problem !== undefined)?.problem;
  return {
    evidence: {
      exitCode: combinedExitCode,
      results: missingResults ? undefined : combinedResults,
      totals: {
        ...(unattributedFailure ? {} : { fail: totalFail }),
        errors: totalErrors,
      },
    },
    problem,
    nonZeroExitCode,
  };
}

async function runPlain(run: BunTestRun): Promise<number> {
  const batches = splitBatchArgs(run.args, run.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH);
  const forward = stderrWriter(run.forward);
  let failureCode: number | undefined;
  for (const batchArgs of batches) {
    const outcome = await executeBatch(run, batchArgs);
    if (outcome.exitCode !== 0) {
      failureCode ??= outcome.exitCode ?? 1;
      if (batches.length === 1 || isSignalExit(outcome.exitCode)) {
        break;
      }
      continue;
    }
    if (outcome.problem !== undefined) {
      forward(`\n[bun-test] ${outcome.problem}\n`);
      failureCode ??= 1;
    }
  }
  return failureCode ?? 0;
}

/** Runs the suite and returns the exit code it should end with. Unless
 *  quarantine is on (`--quarantine`, source.ts), no failure is forgiven. */
export async function runBunTest(run: BunTestRun): Promise<number> {
  if (!run.quarantine) return runPlain(run);
  return (await runBunTestVerdict(run)).exitCode;
}

/** Runs the suite with a JUnit report and returns its quarantine verdict. */
export async function runBunTestVerdict(run: BunTestRun): Promise<Verdict> {
  const batches = splitBatchArgs(run.args, run.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH);
  const forward = stderrWriter(run.forward);
  const outcomes: BatchOutcome[] = [];
  for (const batchArgs of batches) {
    const outcome = await executeBatch(run, batchArgs);
    outcomes.push(outcome);
    if (isSignalExit(outcome.exitCode)) {
      break;
    }
  }
  // If a batch exited on a signal before later batches ran, ensure an integrity
  // problem is also recorded alongside the signal exitCode.
  let unrunProblem: string | undefined;
  if (outcomes.length < batches.length) {
    unrunProblem = `bun test stopped after ${outcomes.length} of ${batches.length} batch(es)`;
  }
  const combined = combineBatchOutcomes(outcomes);
  const problem = combined.problem ?? unrunProblem;

  let effectiveEnv = process.env;
  if (run.env !== undefined) {
    effectiveEnv = run.env;
  }
  let entries = run.entries;
  if (entries === undefined) {
    entries = honouredEntries(runEntries(effectiveEnv));
  }
  let today = run.today;
  if (today === undefined) {
    today = todayUtc();
  }
  let verdict = decide(combined.evidence, entries, today);
  if (problem !== undefined && verdict.exitCode === 0) {
    const failureCode = combined.nonZeroExitCode ?? 1;
    verdict = {
      ...verdict,
      exitCode: failureCode,
      forgiven: false,
      reason: problem,
    };
    forward(`\n[quarantine] ${problem}\n`);
  }
  publish(run.suite, verdict, effectiveEnv);
  return verdict;
}
