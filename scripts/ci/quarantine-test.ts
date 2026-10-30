#!/usr/bin/env bun
// Runs `bun test` in a directory through the quarantine runner: the suite runs
// in full, and a failure of quarantined tests alone is reported (console,
// annotation, job summary, test-results/quarantine/<suite>.json) without
// failing the step. Every other failure keeps bun's exit code.
//
//   bun scripts/ci/quarantine-test.ts --cwd packages/conformance --suite conformance [-- <bun test args>]

import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/quarantine/entries.ts';
import { runBunTest } from '../lib/quarantine/run-bun-test.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const own = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const cwd = option(own, '--cwd');
  const suite = option(own, '--suite');
  if (cwd === undefined || suite === undefined) {
    console.error('usage: bun scripts/ci/quarantine-test.ts --cwd <dir> --suite <name> [-- <bun test args>]');
    process.exit(2);
  }
  process.exit(await runBunTest({ cwd: resolve(REPO_ROOT, cwd), args: passthrough, suite }));
}
