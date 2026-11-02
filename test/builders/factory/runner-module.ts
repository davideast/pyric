/**
 * Loads the module that runs sessions: `session-runner.ts` beside this file,
 * or the module `--runner` names. It exports `runSession`, and may export
 * `hourlyCheck`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UsageError } from '../cli-args.ts';
import type { HourlyCheck, RunSession } from './session.ts';

export const DEFAULT_RUNNER = fileURLToPath(new URL('./session-runner.ts', import.meta.url));

export interface RunnerModule {
  runSession: RunSession;
  hourlyCheck?: HourlyCheck;
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

export async function loadRunner(path: string = DEFAULT_RUNNER): Promise<RunnerModule> {
  if (!existsSync(path)) throw new UsageError(`no session runner at ${path}; pass --runner <module>`);
  const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const { runSession, hourlyCheck } = loaded;
  if (!isFunction(runSession)) throw new UsageError(`${path} does not export runSession`);
  if (hourlyCheck !== undefined && !isFunction(hourlyCheck)) throw new UsageError(`${path} exports an hourlyCheck that is not a function`);
  return {
    runSession: runSession as RunSession,
    ...(hourlyCheck === undefined ? {} : { hourlyCheck: hourlyCheck as HourlyCheck }),
  };
}
