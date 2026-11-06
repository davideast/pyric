#!/usr/bin/env bun
// Runs one shard of a package's test suite. `bun test` has no shard option, so
// the files are partitioned here: the sorted list of `*.test.ts` and `*.spec.ts`
// files under the package (the set `bun test` discovers there) is split by index
// modulo the shard count, and each shard passes its own files to `bun test`
// explicitly. The package is packages/cli unless `--package` names another.
// With --quarantine, which only CI passes, a failure of quarantined tests
// alone is reported and does not fail the shard (scripts/lib/quarantine).
//
//   bun scripts/ci/test-shard.ts [--package=pyric] --shard=1/2 [--list] [--quarantine] [-- <extra bun test args>]

import { Glob } from 'bun';
import { resolve } from 'node:path';
import { runBunTest } from '../lib/quarantine/run-bun-test.ts';
import { takeQuarantineFlag } from '../lib/quarantine/source.ts';

/** The packages whose suites are sharded, by `--package` name. */
export const shardedPackages = {
  cli: resolve(import.meta.dir, '../../packages/cli'),
  pyric: resolve(import.meta.dir, '../../packages/pyric'),
} as const;

/** Sorted package-relative paths of every test file, as `./path`. */
export function listTests(cwd: string = shardedPackages.cli): string[] {
  const files: string[] = [];
  for (const file of new Glob('**/*.{test,spec}.ts').scanSync({ cwd })) {
    if (file.split('/').includes('node_modules')) continue;
    files.push(`./${file}`);
  }
  return files.sort();
}

/** The files whose index modulo `total` is `index - 1`. `index` is 1-based. */
export function partition<T>(files: readonly T[], index: number, total: number): T[] {
  return files.filter((_, i) => i % total === index - 1);
}

export function parseShard(spec: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (!match) throw new Error(`shard must be index/total, received "${spec}"`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`shard index must be between 1 and ${total}, received "${spec}"`);
  }
  return { index, total };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const { quarantine, rest: own } = takeQuarantineFlag(separator === -1 ? args : args.slice(0, separator));
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const spec = own.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length) ?? '';
  const { index, total } = parseShard(spec);
  const name = own.find((arg) => arg.startsWith('--package='))?.slice('--package='.length) ?? 'cli';
  const isKnownPackage = Object.hasOwn(shardedPackages, name);
  if (!isKnownPackage) throw new Error(`--package must be one of ${Object.keys(shardedPackages).join(', ')}, received "${name}"`);
  const root = shardedPackages[name as keyof typeof shardedPackages];
  const shard = partition(listTests(root), index, total);
  if (own.includes('--list')) {
    console.log(shard.join('\n'));
  } else {
    console.log(`${name} test shard ${index}/${total}: ${shard.length} files`);
    process.exit(await runBunTest({ cwd: root, args: [...passthrough, ...shard], suite: `${name}-${index}`, quarantine }));
  }
}
