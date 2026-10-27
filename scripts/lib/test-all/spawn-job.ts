// Starts one test job as a child process, without a shell. Its output goes to
// a log file, and also to this process's output when `echo` is set (the serial
// run, where one job runs at a time and its output can stream as it comes).
// When it ends, only what the run reports is kept: its counts, its failing
// tests and the end of its output.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { addCounts, readCounts } from './counts.ts';
import type { TestJob } from './plan.ts';
import type { JobOutcome } from './run-jobs.ts';

/** How many of a job's last output lines a failure report shows. */
const TAIL_LINES = 40;

/** Children still running, so an interrupted run can stop them and what they started. */
export const runningChildren = new Set<ChildProcess>();

/** Lines bun test (`(fail) …`) and node --test (`✖ …`) print for a failing test. */
function isFailedTestLine(line: string): boolean {
  return line.startsWith('(fail)') || line.startsWith('✖');
}

function summarize(exitCode: number, stdout: string, stderr: string, note: string): JobOutcome {
  // Each stream is read on its own: a summary line never straddles the two.
  const counts = addCounts(readCounts(stdout), readCounts(stderr));
  const lines = `${stdout}\n${stderr}${note}`.trimEnd().split('\n');
  return { exitCode, counts, failedTests: lines.filter(isFailedTestLine), tail: lines.slice(-TAIL_LINES) };
}

export function spawnJob(job: TestJob, options: { logPath: string; echo: boolean }): Promise<JobOutcome> {
  return new Promise((resolve) => {
    const file = createWriteStream(options.logPath);
    let logError = '';
    file.on('error', (error) => { logError = `\n[test-all] could not write ${options.logPath}: ${error.message}\n`; });
    // Its own process group, so stopping the job stops what it started too.
    const child = spawn(job.command, job.args, { cwd: job.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

/** Stop every running job's process group. */
export function stopRunningJobs(signal: NodeJS.Signals): void {
  for (const child of runningChildren) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group already exited.
    }
  }
}
