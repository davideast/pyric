// Starts one test job as a child process, without a shell. Its output goes to
// a log file, and also to this process's output when `echo` is set (the serial
// run, where one job runs at a time and its output can stream as it comes).
// When it ends, only what the run reports is kept: its counts, its failing
// tests and the end of its output.
//
// Jobs stay in test-all's process group, so a signal to the whole group (a
// terminal's Ctrl-C, or a tool that kills a command it timed out) reaches
// every job and everything they started, even when test-all itself is killed
// and can do nothing.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { addCounts, readCounts } from './counts.ts';
import { failuresWithFiles } from './failures.ts';
import type { TestJob } from './plan.ts';
import type { JobOutcome } from './run-jobs.ts';

/** How many of a job's last output lines a failure report shows. */
const TAIL_LINES = 40;

/** Children still running, so an interrupted run can stop them and what they started. */
const runningChildren = new Set<ChildProcess>();

function summarize(exitCode: number, stdout: string, stderr: string, note: string): JobOutcome {
  // Each stream is read on its own: a summary line never straddles the two.
  const counts = addCounts(readCounts(stdout), readCounts(stderr));
  const failedTests = [...failuresWithFiles(stderr), ...failuresWithFiles(stdout)];
  const tail = `${stdout}\n${stderr}${note}`.trimEnd().split('\n').slice(-TAIL_LINES);
  return { exitCode, counts, failedTests, tail };
}

export function spawnJob(job: TestJob, options: { logPath: string; echo: boolean }): Promise<JobOutcome> {
  return new Promise((resolve) => {
    const file = createWriteStream(options.logPath);
    let logError = '';
    file.on('error', (error) => { logError = `\n[test-all] could not write ${options.logPath}: ${error.message}\n`; });
    const child = spawn(job.command, job.args, { cwd: job.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    runningChildren.add(child);
    const text = { stdout: '', stderr: '' };
    const record = (name: 'stdout' | 'stderr', stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      text[name] += chunk.toString();
      if (!file.destroyed) file.write(chunk);
      if (options.echo) stream.write(chunk);
    };
    child.stdout?.on('data', record('stdout', process.stdout));
    child.stderr?.on('data', record('stderr', process.stderr));
    let settled = false;
    const finish = (exitCode: number, note: string) => {
      if (settled) return;
      settled = true;
      runningChildren.delete(child);
      const done = () => resolve(summarize(exitCode, text.stdout, text.stderr, `${note}${logError}`));
      if (file.destroyed) done();
      else file.end(note, done);
    };
    child.on('error', (error) => finish(1, `\n[test-all] could not start ${job.command}: ${error.message}\n`));
    child.on('close', (code, signal) => {
      const isSignalled = code === null;
      finish(isSignalled ? 1 : code, isSignalled ? `\n[test-all] ${job.name} stopped by ${String(signal)}\n` : '');
    });
  });
}

/** Every process below `roots`, from one `ps` listing of parent ids. */
function descendantsOf(roots: readonly number[]): number[] {
  const listing = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const childrenOf = new Map<number, number[]>();
  for (const line of listing.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined) continue;
    childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Stop every running job and everything it started, when test-all alone gets a signal. */
export function stopRunningJobs(signal: NodeJS.Signals): void {
  const jobs = [...runningChildren].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  let tree = jobs;
  try {
    tree = [...jobs, ...descendantsOf(jobs)];
  } catch {
    // No `ps`: stop the jobs themselves.
  }
  for (const pid of tree) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}
