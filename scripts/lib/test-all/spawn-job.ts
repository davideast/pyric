// Starts one test job as a child process, without a shell. Its output goes to
// a log file, and also to this process's output when `echo` is set (the serial
// run, where one job runs at a time and its output can stream as it comes).

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TestJob } from './plan.ts';
import type { JobOutcome } from './run-jobs.ts';

/** Children still running, so an interrupted run can stop them. */
export const runningChildren = new Set<ChildProcess>();

export function spawnJob(job: TestJob, options: { logPath: string; echo: boolean }): Promise<JobOutcome> {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const file = createWriteStream(options.logPath);
  const chunks: string[] = [];
  return new Promise((resolve) => {
    const child = spawn(job.command, job.args, { cwd: job.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    runningChildren.add(child);
    const record = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      chunks.push(chunk.toString());
      file.write(chunk);
      if (options.echo) stream.write(chunk);
    };
    child.stdout?.on('data', record(process.stdout));
    child.stderr?.on('data', record(process.stderr));
    let settled = false;
    const finish = (exitCode: number, note: string) => {
      if (settled) return;
      settled = true;
      runningChildren.delete(child);
      if (note.length > 0) chunks.push(note);
      file.end(note, () => resolve({ exitCode, log: chunks.join('') }));
    };
    child.on('error', (error) => finish(1, `\n[test-all] could not start ${job.command}: ${error.message}\n`));
    child.on('close', (code, signal) => {
      const isSignalled = code === null;
      finish(isSignalled ? 1 : code, isSignalled ? `\n[test-all] ${job.name} stopped by ${String(signal)}\n` : '');
    });
  });
}
