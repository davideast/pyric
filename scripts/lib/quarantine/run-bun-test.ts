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
import { expectedSuiteFiles, suiteIntegrityProblem } from './run-bun-test-integrity.ts';
import { runEntries } from './source.ts';
import { honouredEntries } from './validate.ts';
import { decide, type RunEvidence, type Verdict } from './verdict.ts';

/** bun prints its totals last; this much of the end of stderr holds them. */
const TAIL_BYTES = 64 * 1024;

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

async function runPlain(run: BunTestRun): Promise<number> {
  const expected = expectedSuiteFiles(run.cwd, run.args);
  const jobTmpDir = createPrivateJobTmpDir(run.suite);
  const junitBase = process.env.RUNNER_TEMP ?? jobTmpDir;
  junitSeq += 1;
  const junitFile = join(junitBase, `pyric-junit-${process.pid}-${junitSeq}.xml`);
  try {
    const args = ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...run.args];
    const forward = stderrWriter(run.forward);
    const finished = await runForwarding(run.cwd, args, jobTmpDir, forward, run.forward !== undefined);
    if (finished.exitCode !== 0) {
      return finished.exitCode ?? 1;
    }
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
    if (problem !== undefined) {
      forward(`\n[bun-test] ${problem}\n`);
      return 1;
    }
    return 0;
  } finally {
    unlinkIfPresent(junitFile);
    removePrivateJobTmpDir(jobTmpDir);
  }
}

/** Runs the suite and returns the exit code it should end with. Unless
 *  quarantine is on (`--quarantine`, source.ts), no failure is forgiven. */
export async function runBunTest(run: BunTestRun): Promise<number> {
  if (!run.quarantine) return runPlain(run);
  return (await runBunTestVerdict(run)).exitCode;
}

/** Runs the suite with a JUnit report and returns its quarantine verdict. */
export async function runBunTestVerdict(run: BunTestRun): Promise<Verdict> {
  const expected = expectedSuiteFiles(run.cwd, run.args);
  const jobTmpDir = createPrivateJobTmpDir(run.suite);
  const junitBase = process.env.RUNNER_TEMP ?? jobTmpDir;
  junitSeq += 1;
  const junitFile = join(junitBase, `pyric-junit-${process.pid}-${junitSeq}.xml`);
  try {
    const args = ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...run.args];
    const forward = stderrWriter(run.forward);
    const finished = await runForwarding(run.cwd, args, jobTmpDir, forward, run.forward !== undefined);
    const evidence: RunEvidence = {
      exitCode: finished.exitCode,
      results: readResults(junitFile, run.cwd),
      totals: consoleTotals(finished.stderrTail),
    };
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
    let verdict = decide(evidence, entries, today);
    const problem = suiteIntegrityProblem({
      cwd: run.cwd,
      exitCode: finished.exitCode,
      stderrTail: finished.stderrTail,
      results: evidence.results,
      totals: evidence.totals,
      expected,
    });
    if (problem !== undefined && verdict.exitCode === 0) {
      let failureCode = 1;
      if (finished.exitCode !== null && finished.exitCode !== 0) {
        failureCode = finished.exitCode;
      }
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
  } finally {
    unlinkIfPresent(junitFile);
    removePrivateJobTmpDir(jobTmpDir);
  }
}
