/**
 * Running the app's commands, on the host or inside a sandbox, with an
 * environment built from nothing: no credential of the harness's, no
 * Google variable, no login. Every gate and setup step goes through a
 * `Runner`, so tests pass one that runs on the host.
 */
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

export function hostRunner(home: string): Runner {
  return (run) => runTimedCommand(run.command, [...run.args], {
    cwd: run.cwd,
    env: { ...baseEnvironment(home), ...run.env },
    timeoutMs: run.timeoutMs,
  });
}

/** Runs each command inside the sandbox, in `cwd` there. */
export function sandboxRunner(namespace: EgressNamespace, home: string): Runner {
  return (run) => {
    const entered = namespace.enter(run.command, run.args, run.cwd);
    return runTimedCommand(entered.command, entered.args, {
      cwd: '/',
      env: { ...baseEnvironment(home), ...run.env },
      timeoutMs: run.timeoutMs,
    });
  };
}

export class StepFailed extends Error {}

/** Runs and throws `StepFailed` with the output on a non-zero exit or a timeout. */
export async function mustRun(runner: Runner, run: Run, what: string): Promise<string> {
  const result = await runner(run);
  const failed = result.code !== 0 || result.timedOut;
  if (failed) throw new StepFailed(`${what} failed (exit ${result.code}${result.timedOut ? ', timed out' : ''}):\n${result.output}`);
  return result.output;
}
