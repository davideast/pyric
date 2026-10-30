#!/usr/bin/env bun
// Prints the quarantine entries on a pull request's base commit as one JSON
// line, `entries=<json>`, to GITHUB_OUTPUT (or stdout). The plan job in
// build.yml runs it, and the PR's test steps honour only these entries, so an
// entry a PR adds takes effect once it is on main, never in the PR itself.
//
//   bun scripts/ci/quarantine-base.ts <base sha>
//
// The base commit must be in the checkout; the plan job fetches it.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { REPO_ROOT, type Entry, type LoadedEntry } from '../lib/quarantine/entries.ts';

const DIR = '.github/quarantine';

function git(args: string[]): string {
  const out = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout;
}

export function baseEntries(sha: string, run: (args: string[]) => string = git): LoadedEntry[] {
  const names = run(['ls-tree', '--name-only', `${sha}:${DIR}`]).split('\n').filter((name) => name.endsWith('.json'));
  return names.sort().map((file) => ({ ...(JSON.parse(run(['show', `${sha}:${DIR}/${file}`])) as Entry), file }));
}

/** A base commit with no quarantine directory holds no entries. */
function entriesOrNone(sha: string): LoadedEntry[] {
  const hasDir = spawnSync('git', ['cat-file', '-e', `${sha}:${DIR}`], { cwd: REPO_ROOT }).status === 0;
  if (!hasDir) return [];
  return baseEntries(sha);
}

if (import.meta.main) {
  const sha = process.argv[2];
  if (sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) {
    console.error('usage: bun scripts/ci/quarantine-base.ts <base sha>');
    process.exit(2);
  }
  const line = `entries=${JSON.stringify(entriesOrNone(sha))}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, line);
  else process.stdout.write(line);
}
