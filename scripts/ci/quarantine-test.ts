#!/usr/bin/env bun
// Runs `bun test` in a directory. With --quarantine, which only CI passes,
// the suite runs in full and a failure of quarantined tests alone is reported
// (console, annotation, job summary, test-results/quarantine/<suite>.json)
// without failing the step. Every other failure keeps bun's exit code.
//
//   bun scripts/ci/quarantine-test.ts --cwd packages/conformance --suite conformance [--quarantine] [-- <bun test args>]

import { resolve } from 'node:path';
import { REPO_ROOT, type LoadedEntry } from '../lib/quarantine/entries.ts';
import { runBunTest } from '../lib/quarantine/run-bun-test.ts';
import { takeQuarantineFlag } from '../lib/quarantine/source.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** Runs the command line and returns the exit code. `entries` is for tests:
 *  it replaces the entries a run would honour, never the --quarantine flag. */
export async function main(args: string[], entries?: LoadedEntry[]): Promise<number> {
  const separator = args.indexOf('--');
  const { quarantine, rest: own } = takeQuarantineFlag(separator === -1 ? args : args.slice(0, separator));
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const cwd = option(own, '--cwd');
  const suite = option(own, '--suite');
  if (cwd === undefined || suite === undefined) {
    console.error('usage: bun scripts/ci/quarantine-test.ts --cwd <dir> --suite <name> [--quarantine] [-- <bun test args>]');
    return 2;
  }
  return runBunTest({ cwd: resolve(REPO_ROOT, cwd), args: passthrough, suite, quarantine, entries });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
