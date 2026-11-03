/**
 * The factory commands' options.
 *
 *   factory --run-dir <dir> [--hours <n> --agent <name> --brief-dir <dir>] [--resume] [--runner <module>]
 *   factory-summary --run-dir <dir>
 *   factory-check --run-dir <dir> --unit <name> [--stale-minutes <n>]
 *
 * `--hours` starts a run, with `--agent` (an adapter's name) and
 * `--brief-dir` (the directory holding BRIEF.md, specs/ and DESIGN.md,
 * outside the run directory); the run records all three in its `run.json`.
 * `--resume` goes on with the run in `--run-dir`, with what it recorded.
 * Given both, the command resumes the run there or starts one when there is
 * none, so the same command line serves a first start and every restart.
 */
import { resolve } from 'node:path';
import { flagValue, positionals, rejectUnknownFlags, UsageError } from '../cli-args.ts';
import { AGENT_NAMES } from './agents/registry.ts';

export const MAX_HOURS = 24;
const DEFAULT_STALE_MINUTES = 5;

export interface FactoryOptions {
  runDir: string;
  hours?: number;
  resume: boolean;
  /** The agent adapter's name. */
  agent?: string;
  briefDir?: string;
  /** A module exporting `runSession`, and `hourlyCheck` if it has one; the session runner when not given. */
  runner?: string;
  /** The provider key file: turns the run's provider channel on. */
  providerKeys?: string;
}

export interface CheckOptions {
  runDir: string;
  unit: string;
  staleMinutes: number;
}

function requiredRunDir(args: readonly string[]): string {
  const runDir = flagValue(args, '--run-dir');
  if (runDir === undefined) throw new UsageError('--run-dir is required');
  return resolve(runDir);
}

function rejectPositionals(args: readonly string[], valueFlags: readonly string[]): void {
  const extra = positionals(args, new Set(valueFlags));
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
}

export function parseHours(raw: string): number {
  const hours = Number(raw);
  const isAllowed = /^\d+(\.\d+)?$/.test(raw) && hours > 0 && hours <= MAX_HOURS;
  if (!isAllowed) throw new UsageError(`--hours takes a number of hours above 0 and at most ${MAX_HOURS}, received "${raw}"`);
  return hours;
}

export function parseFactoryOptions(args: readonly string[]): FactoryOptions {
  const valueFlags = ['--run-dir', '--hours', '--runner', '--agent', '--brief-dir', '--provider-keys'];
  rejectUnknownFlags(args, [...valueFlags, '--resume']);
  rejectPositionals(args, valueFlags);
  const hours = flagValue(args, '--hours');
  const resume = args.includes('--resume');
  if (hours === undefined && !resume) throw new UsageError('factory takes --hours to start a run, or --resume to go on with one');
  const runner = flagValue(args, '--runner');
  const agent = flagValue(args, '--agent');
  const isKnownAgent = agent === undefined || AGENT_NAMES.includes(agent);
  if (!isKnownAgent) throw new UsageError(`--agent takes one of ${AGENT_NAMES.join(', ')}, received "${agent}"`);
  const briefDir = flagValue(args, '--brief-dir');
  const providerKeys = flagValue(args, '--provider-keys');
  return {
    runDir: requiredRunDir(args),
    ...(hours === undefined ? {} : { hours: parseHours(hours) }),
    resume,
    ...(agent === undefined ? {} : { agent }),
    ...(briefDir === undefined ? {} : { briefDir: resolve(briefDir) }),
    ...(runner === undefined ? {} : { runner: resolve(runner) }),
    ...(providerKeys === undefined ? {} : { providerKeys: resolve(providerKeys) }),
  };
}

export function parseSummaryOptions(args: readonly string[]): { runDir: string } {
  rejectUnknownFlags(args, ['--run-dir']);
  rejectPositionals(args, ['--run-dir']);
  return { runDir: requiredRunDir(args) };
}

export function parseCheckOptions(args: readonly string[]): CheckOptions {
  const valueFlags = ['--run-dir', '--unit', '--stale-minutes'];
  rejectUnknownFlags(args, valueFlags);
  rejectPositionals(args, valueFlags);
  const unit = flagValue(args, '--unit');
  if (unit === undefined || !/^[A-Za-z0-9@_.-]+$/.test(unit)) throw new UsageError('--unit takes the supervisor\'s systemd unit name');
  const rawStale = flagValue(args, '--stale-minutes');
  const staleMinutes = rawStale === undefined ? DEFAULT_STALE_MINUTES : Number(rawStale);
  const isWholeMinutes = Number.isInteger(staleMinutes) && staleMinutes >= 2;
  if (!isWholeMinutes) throw new UsageError(`--stale-minutes takes a whole number of at least 2, received "${rawStale}"`);
  return { runDir: requiredRunDir(args), unit, staleMinutes };
}
