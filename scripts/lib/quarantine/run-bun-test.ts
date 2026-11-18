// Runs `bun test`. With quarantine on (`--quarantine`, source.ts), it adds a JUnit report
// beside the usual console output and lets the quarantine verdict decide the
// exit code; otherwise it is plain `bun test`. Each run gets its own private
// TMPDIR under ~/.cache/pyric-tmp/<suite> removed on finish.

import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../private-job-tmpdir.ts';
import { REPO_ROOT, todayUtc, type LoadedEntry } from './entries.ts';
import { consoleTotals, parseJunit } from './junit.ts';
import { publish } from './report.ts';
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

function runForwarding(
  cwd: string,
  args: string[],
  jobTmpDir: string,
  forward: (chunk: string) => void,
): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', args, {
      cwd,
      env: childEnvWithPrivateTmp(jobTmpDir),
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      forward(chunk);
      tail = (tail + chunk).slice(-TAIL_BYTES);
    });
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

/** Plain bun test writes straight to the job log, unless a test captures it. */
function plainStdio(forward: BunTestRun['forward']): StdioOptions {
  if (forward === undefined) return 'inherit';
  return ['inherit', 'pipe', 'pipe'];
}

async function runPlain(run: BunTestRun): Promise<number> {
  const jobTmpDir = createPrivateJobTmpDir(run.suite);
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      const forward = run.forward;
      const child = spawn('bun', ['test', ...run.args], {
        cwd: run.cwd,
        env: childEnvWithPrivateTmp(jobTmpDir),
        stdio: plainStdio(forward),
      });
      if (forward) {
        child.stdout?.setEncoding('utf8').on('data', forward);
        child.stderr?.setEncoding('utf8').on('data', forward);
      }
      child.on('error', reject);
      child.on('close', (code) => resolvePromise(code ?? 1));
    });
  } finally {
    removePrivateJobTmpDir(jobTmpDir);
  }
}

/** Runs the suite and returns the exit code it should end with. Unless
 *  quarantine is on (`--quarantine`, source.ts), it is plain `bun test`. */
export async function runBunTest(run: BunTestRun): Promise<number> {
  if (!run.quarantine) return runPlain(run);
  return (await runBunTestVerdict(run)).exitCode;
}

/** Runs the suite with a JUnit report and returns its quarantine verdict. */
export async function runBunTestVerdict(run: BunTestRun): Promise<Verdict> {
  const jobTmpDir = createPrivateJobTmpDir(run.suite);
  const junitBase = process.env.RUNNER_TEMP ?? jobTmpDir;
  const junitDir = mkdtempSync(join(junitBase, 'quarantine-'));
  try {
    const junitFile = join(junitDir, 'junit.xml');
    const args = ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...run.args];
    let forward = (chunk: string) => {
      process.stderr.write(chunk);
    };
    if (run.forward !== undefined) {
      forward = run.forward;
    }
    const finished = await runForwarding(run.cwd, args, jobTmpDir, forward);
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
    const verdict = decide(evidence, entries, today);
    publish(run.suite, verdict, effectiveEnv);
    return verdict;
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
    removePrivateJobTmpDir(jobTmpDir);
  }
}
