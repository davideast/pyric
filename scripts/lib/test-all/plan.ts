// Turns the serial test chain (the root package.json `test:serial` script) into
// the jobs `scripts/test-all.ts` runs. The chain stays the one list of what
// `bun run test` covers: the serial plan is the chain itself, one command at a
// time, and the parallel plan replaces each sharded package's `bun test --cwd`
// command with that package's shards from scripts/ci/test-shard.ts.

import { basename, join } from 'node:path';
import { listTests, partition, shardedPackages } from '../../ci/test-shard.ts';

/** One process `test-all` runs: a command, its arguments, and where it runs. */
export interface TestJob {
  name: string;
  command: string;
  args: string[];
  cwd: string;
}

export interface PlanOptions {
  /** The repository root, where the chain's commands run. */
  root: string;
  /** How many shards each sharded package splits into. 1 keeps the chain unsharded. */
  shards: number;
}

/** Characters that mean a command needs a shell, which the runner does not use. */
const SHELL_SYNTAX = /[|;&<>"'`$()*?=\\]/;

/** Split the chain into argument vectors, refusing anything that needs a shell to run. */
export function splitChain(chain: string): string[][] {
  const commands = chain.split(' && ').map((command) => command.trim());
  return commands.map((command) => {
    const isPlainCommand = command.length > 0 && !SHELL_SYNTAX.test(command);
    if (!isPlainCommand) throw new Error(`test-all runs each command of the chain without a shell, so it cannot run "${command}"`);
    return command.split(/\s+/);
  });
}

function optionValue(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

/** Name a chain command for the package or script it runs. */
function jobName(argv: readonly string[]): string {
  const cwd = optionValue(argv, '--cwd');
  if (cwd !== undefined) return basename(cwd);
  const isScriptRun = argv[1] === 'run';
  if (isScriptRun) return argv[2] ?? 'run';
  const firstPath = argv.slice(2).find((arg) => arg.includes('/'));
  return firstPath?.split('/')[0] ?? argv.join(' ');
}

/** The sharded package a chain command runs the whole suite of, if it is exactly `bun test --cwd packages/<name>`. */
function shardedPackageOf(argv: readonly string[]): keyof typeof shardedPackages | undefined {
  const [command, subcommand, option, cwd, ...rest] = argv;
  const isWholeSuite = command === 'bun' && subcommand === 'test' && option === '--cwd' && rest.length === 0;
  if (!isWholeSuite || cwd === undefined) return undefined;
  const name = cwd.replace(/^packages\//, '');
  return Object.hasOwn(shardedPackages, name) ? (name as keyof typeof shardedPackages) : undefined;
}

function shardJobs(name: keyof typeof shardedPackages, total: number): TestJob[] {
  const packageRoot = shardedPackages[name];
  const files = listTests(packageRoot);
  return Array.from({ length: total }, (_, offset) => ({
    name: `${name} ${offset + 1}/${total}`,
    command: 'bun',
    args: ['test', ...partition(files, offset + 1, total)],
    cwd: packageRoot,
  }));
}

/**
 * The jobs for one run. With one shard this is the chain as written. With
 * more, the sharded packages' shards come first, because they are the longest
 * jobs, and every other command follows in chain order.
 */
export function planJobs(chain: string, options: PlanOptions): TestJob[] {
  const shards: TestJob[] = [];
  const rest: TestJob[] = [];
  for (const argv of splitChain(chain)) {
    const sharded = options.shards > 1 ? shardedPackageOf(argv) : undefined;
    if (sharded !== undefined) {
      shards.push(...shardJobs(sharded, options.shards));
      continue;
    }
    const [command = 'bun', ...args] = argv;
    rest.push({ name: jobName(argv), command, args, cwd: options.root });
  }
  return [...shards, ...rest];
}

/** Read the serial chain from the root package.json. */
export function readSerialChain(root: string, readText: (path: string) => string): string {
  const manifest = JSON.parse(readText(join(root, 'package.json'))) as { scripts?: Record<string, string> };
  const chain = manifest.scripts?.['test:serial'];
  if (chain === undefined) throw new Error('package.json has no test:serial script');
  return chain;
}
