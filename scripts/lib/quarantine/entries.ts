// The quarantine list: one JSON file per test in .github/quarantine/, so two
// pull requests that quarantine different tests add different files and never
// conflict. A quarantined test still runs and is still reported; a failure of
// it alone does not fail the run until the entry expires. Reads and matches
// entries; validate.ts checks them.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const QUARANTINE_DIR = join(REPO_ROOT, '.github/quarantine');
/** How long a quarantine lasts from when it was added or last renewed. */
export const QUARANTINE_DAYS = 14;
/** bun's name for a failure outside any test: a hook that broke or timed out. */
export const UNNAMED = '(unnamed)';
export const SEPARATOR = ' > ';

export interface Renewal {
  date: string;
  expires: string;
  reason: string;
}

export interface Entry {
  /** `<repo path> > <describe> > <test>`; `<repo path> > [<describe> >]
   *  (unnamed)` for a failure outside any test; or `test/apps/<app>`. */
  test: string;
  issue: number;
  owner: string;
  reason: string;
  added: string;
  expires: string;
  renewals: Renewal[];
}

export interface LoadedEntry extends Entry {
  /** The entry's file name in the quarantine directory. */
  file: string;
}

/** One test's result in a run, by the id an entry names. */
export interface TestResult {
  /** `<repo path> > <describe> > <test>`, or `test/apps/<app>`. */
  id: string;
  /** The repository path of the test file, or of the app directory. */
  file: string;
  outcome: 'passed' | 'failed' | 'skipped';
  /** The test's line in its file, when JUnit gives one. bun lists each retry
   *  attempt as its own testcase on the same line. */
  line?: number;
}

function slugText(test: string): string {
  return test.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
}

/** The file name an entry for `test` must have. */
export function entryFileName(test: string): string {
  const hash = createHash('sha1').update(test).digest('hex').slice(0, 8);
  return `${slugText(test)}-${hash}.json`;
}

/** Every entry in the directory. A directory that does not exist holds none. */
export function readEntries(dir: string = QUARANTINE_DIR): LoadedEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ ...(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Entry), file }));
}

/** An entry is active from the day it was added up to, not including, the
 *  day it expires: QUARANTINE_DAYS days. Dates are UTC `YYYY-MM-DD`. */
export function isActive(entry: Pick<Entry, 'expires'>, today: string): boolean {
  return today < entry.expires;
}

/** Whether the entry is for a failure outside any test: a hook that broke or
 *  timed out, named `<file> > (unnamed)` or `<file> > <describe> > (unnamed)`. */
export function isUnnamedEntry(entry: Pick<Entry, 'test'>): boolean {
  return entry.test.endsWith(`${SEPARATOR}${UNNAMED}`);
}

/** The id prefix of the tests an unnamed entry's hook guards: the whole file,
 *  or one describe. Those tests do not run when the hook breaks. */
export function unnamedScope(entry: Pick<Entry, 'test'>): string {
  return entry.test.slice(0, -UNNAMED.length);
}

/** Whether the entry is for a hook that runs before every test in its file. */
export function isFileLevelUnnamed(entry: Pick<Entry, 'test'>): boolean {
  return isUnnamedEntry(entry) && unnamedScope(entry).split(SEPARATOR).length === 2;
}

/** Whether the entry names this result. Matching is exact, unnamed entries
 *  included, so an entry for one describe's hook never covers another's. */
export function matches(entry: Pick<Entry, 'test'>, result: TestResult): boolean {
  return entry.test === result.id;
}

/** Whether the result is one the entry is about: its own test, or for an
 *  unnamed entry, any test its hook guards. */
export function ran(entry: Pick<Entry, 'test'>, result: TestResult): boolean {
  if (isUnnamedEntry(entry)) return result.id.startsWith(unnamedScope(entry));
  return entry.test === result.id;
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(time).toISOString().slice(0, 10);
}
