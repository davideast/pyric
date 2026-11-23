// Turns the serial test chain (the root package.json `test:serial` script) into
// the jobs `scripts/test-all.ts` runs. The chain stays the one list of what
// `bun run test` covers: the serial plan is the chain itself, one command at a
// time, and the parallel plan replaces each sharded package's `bun test --cwd`
// command with that package's shards from scripts/ci/test-shard.ts.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { listTests, partition, shardedPackages } from '../../ci/test-shard.ts';

/** One process `test-all` runs: a command, its arguments, and where it runs. */
export interface TestJob {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  /** Whether the job is `bun test`, whose summary must report every file it ran. */
  runsBunTest: boolean;
  /** How many test files the job runs, when the plan knows. */
  expectedFiles?: number;
}

export interface PlanOptions {
  /** The repository root, where the chain's commands run. */
  root: string;
  /** How many shards each sharded package splits into. 1 keeps the chain unsharded. */
  shards: number;
}

/** Characters that mean a command needs a shell, which the runner does not use. */
const SHELL_SYNTAX = /[|;&<>"'`$()*?\\]/;

/** A leading `NAME=value` word, an environment assignment only a shell understands. */
const ENV_ASSIGNMENT = /^\w+=/;

/** Documented `bun test` file suffixes, outside `node_modules` and not through symlinks. */
const BUN_TEST_FILE = /(\.test|_test|\.spec|_spec)\.(c|m)?(j|t)sx?$/;

const VALUE_OPTIONS = new Set([
  '--cwd',
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--preload',
  '-r',
  '--bail',
  '--rerun-each',
  '--max-concurrency',
  '--seed',
  '--reporter',
  '--reporter-outfile',
  '--coverage-reporter',
  '--coverage-dir',
]);

/** Split the chain into argument vectors, refusing anything that needs a shell to run. */
export function splitChain(chain: string): string[][] {
  const commands = chain.split(' && ').map((command) => command.trim());
  return commands.map((command) => {
    const isPlainCommand = command.length > 0 && !SHELL_SYNTAX.test(command) && !ENV_ASSIGNMENT.test(command);
    if (!isPlainCommand) {
      throw new Error(`test-all runs each command of the chain without a shell, so it cannot run "${command}"`);
    }
    return command.split(/\s+/);
  });
}

function optionValue(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) return undefined;
  return argv[index + 1];
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

function countDiscoveredTests(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      count += countDiscoveredTests(join(directory, entry.name));
    } else if (entry.isFile() && BUN_TEST_FILE.test(entry.name)) {
      count += 1;
    }
  }
  return count;
}

function expectedBunTestFiles(argsAfterTest: readonly string[], root: string): number | undefined {
  let targetCwd = root;
  const targets: string[] = [];
  for (let i = 0; i < argsAfterTest.length; i += 1) {
    const arg = argsAfterTest[i] ?? '';
    if (arg === '-t' || arg === '--test-name-pattern' || arg.startsWith('--test-name-pattern=')) {
      return undefined;
    }
    if (arg === '--cwd') {
      const next = argsAfterTest[i + 1];
      if (next !== undefined) {
        targetCwd = resolve(root, next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      targetCwd = resolve(root, arg.slice('--cwd='.length));
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    targets.push(arg);
  }

  if (targets.length === 0) {
    if (!existsSync(targetCwd)) return undefined;
    return countDiscoveredTests(targetCwd);
  }

  let total = 0;
  for (const target of targets) {
    if (BUN_TEST_FILE.test(target)) {
      total += 1;
      continue;
    }
    const resolved = resolve(targetCwd, target);
    if (!existsSync(resolved)) {
      return undefined;
    }
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      total += countDiscoveredTests(resolved);
    } else if (stats.isFile()) {
      total += 1;
    }
  }
  return total;
}

/** The sharded package a chain command runs the whole suite of, if it is exactly `bun test --cwd packages/<name>`. */
function shardedPackageOf(argv: readonly string[]): keyof typeof shardedPackages | undefined {
  const [command, subcommand, option, cwd, ...rest] = argv;
  const isWholeSuite = command === 'bun' && subcommand === 'test' && option === '--cwd' && rest.length === 0;
  if (!isWholeSuite || cwd === undefined) return undefined;
  const name = cwd.replace(/^packages\//, '');
  if (Object.hasOwn(shardedPackages, name)) {
    return name as keyof typeof shardedPackages;
  }
  return undefined;
}

function shardJobs(name: keyof typeof shardedPackages, total: number): TestJob[] {
  const packageRoot = shardedPackages[name];
  const files = listTests(packageRoot);
  return Array.from({ length: total }, (_, offset) => {
    const shard = partition(files, offset + 1, total);
    return {
      name: `${name} ${offset + 1}/${total}`,
      command: 'bun',
      args: ['test', ...shard],
      cwd: packageRoot,
      runsBunTest: true,
      expectedFiles: shard.length,
    };
  });
}

function chainJob(argv: readonly string[], root: string): TestJob {
  const [command = 'bun', ...args] = argv;
  const runsBunTest = command === 'bun' && args[0] === 'test';
  const job: TestJob = { name: jobName(argv), command, args, cwd: root, runsBunTest };
  if (runsBunTest) {
    const sharded = shardedPackageOf(argv);
    if (sharded !== undefined) {
      job.expectedFiles = listTests(shardedPackages[sharded]).length;
    } else {
      const expected = expectedBunTestFiles(args.slice(1), root);
      if (expected !== undefined) {
        job.expectedFiles = expected;
      }
    }
  }
  return job;
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
    let sharded: keyof typeof shardedPackages | undefined;
    if (options.shards > 1) {
      sharded = shardedPackageOf(argv);
    }
    if (sharded !== undefined) {
      shards.push(...shardJobs(sharded, options.shards));
      continue;
    }
    rest.push(chainJob(argv, options.root));
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
