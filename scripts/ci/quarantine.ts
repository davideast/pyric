#!/usr/bin/env bun
// Adds or renews a quarantine entry in .github/quarantine/, with its dates
// computed, and checks it before writing. Commit the file in a draft PR that
// names the flake issue.
//
//   bun scripts/ci/quarantine.ts add --test '<id>' --issue <n> --owner <who> --reason '<why>'
//   bun scripts/ci/quarantine.ts renew --test '<id>' --reason '<why>'
//
// <id> is the test as the "Flaky on main" issue names it:
// `<repo path> > <describe> > <test>`. A hook that broke or timed out is
// `<repo path> > [<describe> >] (unnamed)`, which covers only that hook; bun
// names a broken beforeAll and afterAll alike, and the report says some or all
// of the tests it guards may not have run. A test with `retry` that fails
// every attempt is never forgiven: bun lists each attempt as its own
// testcase, so the entry names more than one. An app scenario is
// `test/apps/<app>`, which covers only a failure inside its scenario.
// A quarantine lasts 14 days; renewing it needs a reason. The entry takes
// effect once it is on main: pull requests honour only their base branch's.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUARANTINE_DAYS, QUARANTINE_DIR, addDays, entryFileName, todayUtc, type Entry } from '../lib/quarantine/entries.ts';
import { validateEntry } from '../lib/quarantine/validate.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

export function newEntry(args: string[], today: string): Entry {
  return {
    test: required(args, '--test'),
    issue: Number(required(args, '--issue')),
    owner: required(args, '--owner'),
    reason: required(args, '--reason'),
    added: today,
    expires: addDays(today, QUARANTINE_DAYS),
    renewals: [],
  };
}

export function renewed(entry: Entry, reason: string, today: string): Entry {
  const expires = addDays(today, QUARANTINE_DAYS);
  return { ...entry, expires, renewals: [...entry.renewals, { date: today, expires, reason }] };
}

function write(path: string, entry: Entry, fileName: string): void {
  const problems = validateEntry(entry, fileName);
  if (problems.length > 0) throw new Error(`refusing to write ${fileName}:\n- ${problems.join('\n- ')}`);
  mkdirSync(QUARANTINE_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`wrote ${path}, expires ${entry.expires}`);
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  const test = required(rest, '--test');
  const fileName = entryFileName(test);
  const path = join(QUARANTINE_DIR, fileName);
  const today = todayUtc();
  if (command === 'add') {
    if (existsSync(path)) throw new Error(`${path} exists; renew it instead`);
    write(path, newEntry(rest, today), fileName);
  } else if (command === 'renew') {
    if (!existsSync(path)) throw new Error(`${path} does not exist; add it first`);
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Entry;
    write(path, renewed(entry, required(rest, '--reason'), today), fileName);
  } else {
    throw new Error('usage: bun scripts/ci/quarantine.ts add|renew --test <id> ...');
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
