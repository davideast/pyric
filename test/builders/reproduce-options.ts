/**
 * The `reproduce` command's options.
 *
 *   reproduce <round> <run> --list
 *   reproduce <round> <run> <problem> --script <file> [--expect <text>] [--register]
 *             [--packages <dir>] [--minutes <n>]
 */
import { extname, resolve } from 'node:path';
import { flagValue, positionals, rejectUnknownFlags, UsageError } from './cli-args.ts';

export const REPRODUCE_USAGE =
  'reproduce <round> <run> (--list | <problem> --script <file.mjs> [--expect <text>] [--register] [--packages <dir>] [--minutes <n>])';

export interface ReproduceOptions {
  round: string;
  run: string;
  problem: string;
  /** The repro script, copied into each fresh app and run with node. */
  script: string;
  /** Text the script's output must hold for an exit 1 to count. */
  expect?: string;
  /** Run the script with `node --import @pyric/cli/register`. */
  register: boolean;
  /** Where the run's tarballs are; `dist/packages` in the repo when not given. */
  packages?: string;
  /** Each try's wall-clock cap. */
  minutes: number;
}

export type ReproduceCommand = { list: true; round: string; run: string } | ({ list: false } & ReproduceOptions);

const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const SCRIPT_EXTENSIONS = ['.mjs', '.js', '.cjs'];
export const DEFAULT_MINUTES = 10;
export const MAX_MINUTES = 60;

const FLAGS = ['--list', '--script', '--expect', '--register', '--packages', '--minutes'];
const VALUE_FLAGS = new Set(['--script', '--expect', '--packages', '--minutes']);

function name(what: string, raw: string | undefined): string {
  if (raw === undefined || !NAME.test(raw)) throw new UsageError(`reproduce takes a ${what} name: lowercase letters, digits and dashes`);
  return raw;
}

function parseMinutes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MINUTES;
  const minutes = Number(raw);
  const isAllowed = Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MINUTES;
  if (!isAllowed) throw new UsageError(`--minutes takes a whole number from 1 to ${MAX_MINUTES}, received "${raw}"`);
  return minutes;
}

function parseScript(raw: string | undefined): string {
  if (raw === undefined) throw new UsageError('--script is required: the repro script to run');
  const hasKnownExtension = SCRIPT_EXTENSIONS.includes(extname(raw));
  if (!hasKnownExtension) throw new UsageError(`--script takes a ${SCRIPT_EXTENSIONS.join(', ')} file, received "${raw}"`);
  return resolve(raw);
}

export function parseReproduceOptions(args: readonly string[]): ReproduceCommand {
  rejectUnknownFlags(args, FLAGS);
  const [rawRound, rawRun, problem, ...extra] = positionals(args, VALUE_FLAGS);
  const round = name('round', rawRound);
  const run = name('run', rawRun);
  if (args.includes('--list')) {
    if (problem !== undefined) throw new UsageError('--list takes no problem');
    return { list: true, round, run };
  }
  if (problem === undefined || problem.trim() === '') throw new UsageError('reproduce takes a problem: run it with --list to see the run\'s problems');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  const expect = flagValue(args, '--expect');
  const packages = flagValue(args, '--packages');
  return {
    list: false,
    round,
    run,
    problem,
    script: parseScript(flagValue(args, '--script')),
    ...(expect === undefined ? {} : { expect }),
    register: args.includes('--register'),
    ...(packages === undefined ? {} : { packages: resolve(packages) }),
    minutes: parseMinutes(flagValue(args, '--minutes')),
  };
}
