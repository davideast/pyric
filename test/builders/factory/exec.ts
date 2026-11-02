/**
 * Running the app's commands, on the host or inside a sandbox, with an
 * environment built from nothing: no credential of the harness's, no
 * Google variable, no login. Every gate and setup step goes through a
 * `Runner`, so tests pass one that runs on the host.
 *
 * Each command runs in its own process group. A runner made with a signal
 * kills that group when the signal aborts, and every group still running
 * when this process exits is killed with it, so no command outlives the
 * check that started it.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { runTimedCommand, type TimedResult } from '../../apps/install.ts';
import type { EgressNamespace } from '../namespace.ts';

export interface Run {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  /** Added to the base environment. */
  env?: Record<string, string>;
}

export type Runner = (run: Run) => Promise<TimedResult>;

/** PATH, the locale and a HOME of the caller's choosing, and nothing else of this process's environment. */
export function baseEnvironment(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const base: Record<string, string> = { HOME: home, NEXT_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const key of ['PATH', 'LANG', 'TMPDIR']) {
    const value = env[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}

const liveGroups = new Set<number>();

export function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

process.once('exit', () => {
  for (const pid of liveGroups) killGroup(pid);
});

/** Records each child's group while it runs, so an abort or this process's exit can end it. */
export function trackGroup(child: ChildProcess, signal?: AbortSignal): void {
  const pid = child.pid;
  if (pid === undefined) return;
  liveGroups.add(pid);
  const onAbort = () => killGroup(pid);
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('exit', () => {
    liveGroups.delete(pid);
    signal?.removeEventListener('abort', onAbort);
  });
}

export class Aborted extends Error {}

function runTracked(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }, signal?: AbortSignal): Promise<TimedResult> {
  if (signal?.aborted === true) return Promise.reject(new Aborted('the check was stopped'));
  const spawnChild = (cmd: string, argv: string[], spawnOptions: SpawnOptions) => {
    const child = spawn(cmd, argv, spawnOptions);
    trackGroup(child, signal);
    return child;
  };
  return runTimedCommand(command, [...args], { ...options, spawnChild });
}

export function hostRunner(home: string, signal?: AbortSignal): Runner {
  return (run) => runTracked(run.command, run.args, { cwd: run.cwd, env: { ...baseEnvironment(home), ...run.env }, timeoutMs: run.timeoutMs }, signal);
}

/** Runs each command inside the sandbox, in `cwd` there. */
export function sandboxRunner(namespace: EgressNamespace, home: string, signal?: AbortSignal): Runner {
  return (run) => {
    const entered = namespace.enter(run.command, run.args, run.cwd);
    return runTracked(entered.command, entered.args, { cwd: '/', env: { ...baseEnvironment(home), ...run.env }, timeoutMs: run.timeoutMs }, signal);
  };
}

export class StepFailed extends Error {}

function exitNote(result: TimedResult): string {
  if (result.timedOut) return `exit ${result.code}, timed out`;
  return `exit ${result.code}`;
}

/** Runs and throws `StepFailed` with the output on a non-zero exit or a timeout. */
export async function mustRun(runner: Runner, run: Run, what: string): Promise<string> {
  const result = await runner(run);
  const failed = result.code !== 0 || result.timedOut;
  if (failed) throw new StepFailed(`${what} failed (${exitNote(result)}):\n${result.output}`);
  return result.output;
}
