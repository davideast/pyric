// Runs `bun test` with a JUnit report beside its usual console output, then
// lets the quarantine verdict decide the exit code. The console output passes
// through unchanged, so the main failure lane reads the same log.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT, readEntries, todayUtc, type LoadedEntry } from './entries.ts';
import { consoleTotals, parseJunit } from './junit.ts';
import { publish } from './report.ts';
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
  /** For tests: the environment `publish` reads in place of process.env. */
  env?: NodeJS.ProcessEnv;
}

interface Finished {
  exitCode: number | null;
  stderrTail: string;
}

function runForwarding(cwd: string, args: string[], forward: (chunk: string) => void): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', args, { cwd, stdio: ['inherit', 'inherit', 'pipe'] });
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
    console.error(`quarantine: could not read ${junitFile}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Runs the suite and returns the exit code it should end with. */
export async function runBunTest(run: BunTestRun): Promise<number> {
  return (await runBunTestVerdict(run)).exitCode;
}

/** Runs the suite and returns its quarantine verdict. */
export async function runBunTestVerdict(run: BunTestRun): Promise<Verdict> {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'quarantine-'));
  const junitFile = join(dir, 'junit.xml');
  const args = ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...run.args];
  const finished = await runForwarding(run.cwd, args, run.forward ?? ((chunk) => process.stderr.write(chunk)));
  const evidence: RunEvidence = {
    exitCode: finished.exitCode,
    results: readResults(junitFile, run.cwd),
    totals: consoleTotals(finished.stderrTail),
  };
  const entries = run.entries ?? honouredEntries(readEntries());
  const verdict = decide(evidence, entries, run.today ?? todayUtc());
  publish(run.suite, verdict, run.env ?? process.env);
  return verdict;
}
