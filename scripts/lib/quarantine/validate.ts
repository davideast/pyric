// Checks one quarantine entry: its shape, its file name, that it names one
// test in a suite the quarantine runners cover, that it is not dated in the
// future, and that it lasts QUARANTINE_DAYS from when it was added or last
// renewed, no longer.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUARANTINE_DAYS, REPO_ROOT, SEPARATOR, addDays, entryFileName, todayUtc, type Entry, type LoadedEntry } from './entries.ts';

/** The suites whose runs go through the quarantine runners: the CLI and pyric
 *  shards (`**\/*.{test,spec}.ts`, scripts/ci/test-shard.ts) and the
 *  conformance suite. An entry outside them would do nothing, so it is refused. */
export const COVERED_ROOTS: readonly string[] = ['packages/cli/', 'packages/pyric/', 'packages/conformance/'];
const APP = /^test\/apps\/[a-z0-9][a-z0-9-]*$/;
/** The files the shards list. Playwright `.pw.ts` files and gates run by
 *  other jobs do not match, so an entry for one is refused. */
const TEST_FILE = /\.(?:test|spec)\.ts$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Exists = (repoPath: string) => boolean;

export const repoExists: Exists = (repoPath) => existsSync(join(REPO_ROOT, repoPath));

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function shapeProblems(entry: Partial<Entry>): string[] {
  const problems: string[] = [];
  if (!isText(entry.test)) problems.push('test must be a non-empty string');
  if (!Number.isInteger(entry.issue) || (entry.issue ?? 0) < 1) problems.push('issue must be a positive integer');
  if (!isText(entry.owner)) problems.push('owner must be a non-empty string');
  if (!isText(entry.reason)) problems.push('reason must be a non-empty string');
  if (!isDate(entry.added)) problems.push('added must be a YYYY-MM-DD date');
  if (!isDate(entry.expires)) problems.push('expires must be a YYYY-MM-DD date');
  if (!Array.isArray(entry.renewals)) problems.push('renewals must be a list');
  return problems;
}

function testFileProblems(file: string, exists: Exists): string[] {
  if (!TEST_FILE.test(file)) return [`${file} is not a *.test.ts or *.spec.ts file`];
  if (!COVERED_ROOTS.some((root) => file.startsWith(root))) {
    return [`${file} is not in a suite the quarantine covers (${COVERED_ROOTS.join(', ')}, test/apps/<app>)`];
  }
  if (file.split('/').includes('node_modules')) return [`${file} is under node_modules`];
  if (!exists(file)) return [`${file} does not exist`];
  return [];
}

function appProblems(test: string, exists: Exists): string[] {
  if (!APP.test(test)) return [`${test} is not an app scenario directory`];
  if (!exists(`${test}/scenario.ts`)) return [`${test}/scenario.ts does not exist`];
  return [];
}

/** One named test, `(unnamed)` for a hook failure, or an app. A bare file
 *  would cover tests nobody named, so it is refused. */
function testProblems(test: string, exists: Exists): string[] {
  if (test.startsWith('test/apps/')) return appProblems(test, exists);
  const [file = '', ...names] = test.split(SEPARATOR);
  const problems = testFileProblems(file, exists);
  const namesATest = names.length > 0 && names.every((name) => name.length > 0);
  if (!namesATest) problems.push(`name one test: '${file} > <describe> > <test>', or '${file} > (unnamed)' for a hook failure`);
  return problems;
}

function renewalProblems(entry: Entry, today: string): string[] {
  const problems: string[] = [];
  let base = entry.added;
  entry.renewals.forEach((renewal, index) => {
    const where = `renewals[${index}]`;
    if (!isDate(renewal.date) || !isDate(renewal.expires)) problems.push(`${where} needs YYYY-MM-DD date and expires`);
    if (!isText(renewal.reason)) problems.push(`${where} needs a reason`);
    if (renewal.date < base) problems.push(`${where} is dated before the one it renews`);
    if (renewal.date > today) problems.push(`${where} is dated ${renewal.date}, after today (${today})`);
    if (renewal.expires > addDays(renewal.date, QUARANTINE_DAYS)) problems.push(`${where} lasts more than ${QUARANTINE_DAYS} days`);
    base = renewal.date;
  });
  return problems;
}

function expiryProblems(entry: Entry, today: string): string[] {
  const problems: string[] = [];
  if (entry.added > today) problems.push(`added is ${entry.added}, after today (${today})`);
  const last = entry.renewals.at(-1);
  if (last === undefined && entry.expires > addDays(entry.added, QUARANTINE_DAYS)) problems.push(`expires more than ${QUARANTINE_DAYS} days after added`);
  if (last !== undefined && entry.expires !== last.expires) problems.push('expires must equal the last renewal\'s expires');
  return problems;
}

/** What is wrong with the entry stored in `fileName`; empty when nothing is. */
export function validateEntry(entry: Partial<Entry>, fileName: string, exists: Exists = repoExists, today: string = todayUtc()): string[] {
  const shape = shapeProblems(entry);
  if (shape.length > 0) return shape;
  const full = entry as Entry;
  const problems = [...testProblems(full.test, exists), ...renewalProblems(full, today), ...expiryProblems(full, today)];
  if (fileName !== entryFileName(full.test)) problems.push(`the file must be named ${entryFileName(full.test)}`);
  return problems;
}

/** The entries a runner honours: an invalid one is reported and ignored, so it
 *  can never forgive a failure. */
export function honouredEntries(entries: LoadedEntry[], exists: Exists = repoExists, today: string = todayUtc()): LoadedEntry[] {
  return entries.filter((entry) => {
    const problems = validateEntry(entry, entry.file, exists, today);
    if (problems.length > 0) console.error(`quarantine: ignoring ${entry.file}: ${problems.join('; ')}`);
    return problems.length === 0;
  });
}
