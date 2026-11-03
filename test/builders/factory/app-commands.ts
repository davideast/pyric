/**
 * The app commands of the factory:
 *
 *   factory-setup --run-dir <dir> --app-source <repo> [--commit <sha>] [--brief-dir <dir>] [--packages <dir> | --build]
 *       Clones and installs the app for a run (`app-setup.ts`). Run it once,
 *       before `factory --hours` starts the run.
 *   factory-hour --run-dir <dir> --hour <n>
 *       Runs the hourly check once by hand, as the supervisor would.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWorkspace, tarballsIn } from '../../apps/install.ts';
import { flagValue, positionals, rejectUnknownFlags, UsageError } from '../cli-args.ts';
import { setupApp } from './app-setup.ts';
import { hourlyCheck } from './hourly-check.ts';
import { openSandbox } from './sandbox.ts';
import { serveHostProblem } from './serve-host.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const FACTORY_SETUP_USAGE = 'factory-setup --run-dir <dir> --app-source <repo> [--commit <sha>] [--brief-dir <dir>] [--packages <dir> | --build]';
export const FACTORY_HOUR_USAGE = 'factory-hour --run-dir <dir> --hour <n>';

function required(args: readonly string[], flag: string): string {
  const value = flagValue(args, flag);
  if (value === undefined) throw new UsageError(`${flag} is required`);
  return value;
}

function rejectPositionals(args: readonly string[], valueFlags: readonly string[]): void {
  const extra = positionals(args, new Set(valueFlags));
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
}

export async function factorySetupCommand(args: readonly string[]): Promise<number> {
  const valueFlags = ['--run-dir', '--app-source', '--commit', '--brief-dir', '--packages'];
  rejectUnknownFlags(args, [...valueFlags, '--build']);
  rejectPositionals(args, valueFlags);
  const packages = flagValue(args, '--packages');
  const build = args.includes('--build');
  if (packages !== undefined && build) throw new UsageError('pass --packages or --build, not both');
  const tarballs = packages === undefined ? await packWorkspace(REPO_ROOT, build) : tarballsIn(REPO_ROOT, resolve(packages));
  const commit = flagValue(args, '--commit');
  const briefDir = flagValue(args, '--brief-dir');
  const record = await setupApp({
    runDir: resolve(required(args, '--run-dir')),
    source: resolve(required(args, '--app-source')),
    ...(commit === undefined ? {} : { commit }),
    ...(briefDir === undefined ? {} : { briefDir: resolve(briefDir) }),
    tarballs,
    openSandbox,
    say: (line) => console.log(`▸ ${line}`),
  });
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

export async function factoryHourCommand(args: readonly string[]): Promise<number> {
  const valueFlags = ['--run-dir', '--hour'];
  rejectUnknownFlags(args, valueFlags);
  rejectPositionals(args, valueFlags);
  const hour = Number(required(args, '--hour'));
  if (!Number.isInteger(hour) || hour < 1) throw new UsageError('--hour takes a whole number of at least 1');
  const runDir = resolve(required(args, '--run-dir'));
  const hostProblem = serveHostProblem();
  if (hostProblem !== undefined) {
    console.error(hostProblem);
    return 2;
  }
  const result = await hourlyCheck({ runDir, appDir: resolve(runDir, 'app'), hour, signal: new AbortController().signal });
  console.log(JSON.stringify(result, null, 2));
  return result.passed ? 0 : 1;
}
