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
  /** `<repo path> > <describe> > <test>`, a bare test file path for its
   *  unnamed failures, or `test/apps/<app>` for an app scenario. */
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

/** An entry is active through the day it expires. Dates are UTC `YYYY-MM-DD`. */
export function isActive(entry: Entry, today: string): boolean {
  return today <= entry.expires;
}

export function isFileEntry(entry: Entry): boolean {
  return !entry.test.includes(SEPARATOR) && !entry.test.startsWith('test/apps/');
}

function lastName(id: string): string {
  return id.split(SEPARATOR).at(-1) ?? id;
}

/** Whether the entry covers this result. A file entry covers only the file's
 *  unnamed failures, so it cannot hide a named test in the same file. */
export function matches(entry: Entry, result: TestResult): boolean {
  if (!isFileEntry(entry)) return entry.test === result.id;
  return result.file === entry.test && lastName(result.id) === UNNAMED;
}

/** Whether the run included a test the entry is about. */
export function ran(entry: Entry, result: TestResult): boolean {
  if (isFileEntry(entry)) return result.file === entry.test;
  return entry.test === result.id;
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(time).toISOString().slice(0, 10);
}
