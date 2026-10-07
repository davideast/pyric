#!/usr/bin/env bun
// Runs one shard of the CLI test suite. `bun test` has no shard option, so the
// files are partitioned here: the sorted list of `*.test.ts` files under
// packages/cli (the set `bun test` discovers there) is split by index modulo the
// shard count, and each shard passes its own files to `bun test` explicitly.
//
//   bun scripts/ci/test-shard.ts --shard=1/2 [--list] [-- <extra bun test args>]

import { Glob } from 'bun';
import { resolve } from 'node:path';

const cliRoot = resolve(import.meta.dir, '../../packages/cli');

/** Sorted package-relative paths of every CLI test file, as `./path`. */
export function listTests(cwd: string = cliRoot): string[] {
  const files: string[] = [];
  for (const file of new Glob('**/*.test.ts').scanSync({ cwd })) {
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
  const own = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const spec = own.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length) ?? '';
  const { index, total } = parseShard(spec);
  const shard = partition(listTests(), index, total);
  if (own.includes('--list')) {
    console.log(shard.join('\n'));
  } else {
    console.log(`CLI test shard ${index}/${total}: ${shard.length} files`);
    const run = Bun.spawnSync(['bun', 'test', ...passthrough, ...shard], {
      cwd: cliRoot,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    process.exit(run.exitCode ?? 1);
  }
}
