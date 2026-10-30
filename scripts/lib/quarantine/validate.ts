// Checks one quarantine entry: its shape, its file name, that it names a test
// in a suite the quarantine runners cover, and that it lasts at most
// QUARANTINE_DAYS from when it was added or last renewed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUARANTINE_DAYS, REPO_ROOT, SEPARATOR, UNNAMED, addDays, entryFileName, type Entry, type LoadedEntry } from './entries.ts';

/** The suites whose runs go through the quarantine runners. An entry outside
 *  them would do nothing, so it is refused. */
export const COVERED_ROOTS: readonly string[] = ['packages/cli/', 'packages/pyric/', 'packages/conformance/'];
const APP = /^test\/apps\/[a-z0-9][a-z0-9-]*$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
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
  if (!TEST_FILE.test(file)) return [`${file} is not a test file`];
  if (!COVERED_ROOTS.some((root) => file.startsWith(root))) {
    return [`${file} is not in a suite the quarantine covers (${COVERED_ROOTS.join(', ')}, test/apps/<app>)`];
  }
  if (!exists(file)) return [`${file} does not exist`];
  return [];
}

function appProblems(test: string, exists: Exists): string[] {
  if (!APP.test(test)) return [`${test} is not an app scenario directory`];
  if (!exists(`${test}/scenario.ts`)) return [`${test}/scenario.ts does not exist`];
  return [];
}

/** A named test, a bare file (for its unnamed failures only), or an app. */
function testProblems(test: string, exists: Exists): string[] {
  if (test.startsWith('test/apps/')) return appProblems(test, exists);
  const [file = '', ...names] = test.split(SEPARATOR);
  const problems = testFileProblems(file, exists);
  if (names.at(-1) === UNNAMED) problems.push(`name the file alone (${file}) to quarantine its unnamed failures`);
  return problems;
}

function renewalProblems(entry: Entry): string[] {
  const problems: string[] = [];
  let base = entry.added;
  entry.renewals.forEach((renewal, index) => {
    const where = `renewals[${index}]`;
    if (!isDate(renewal.date) || !isDate(renewal.expires)) problems.push(`${where} needs YYYY-MM-DD date and expires`);
    if (!isText(renewal.reason)) problems.push(`${where} needs a reason`);
    if (renewal.date < base) problems.push(`${where} is dated before the one it renews`);
    if (renewal.expires > addDays(renewal.date, QUARANTINE_DAYS)) problems.push(`${where} lasts more than ${QUARANTINE_DAYS} days`);
    base = renewal.date;
  });
  return problems;
}

function expiryProblems(entry: Entry): string[] {
  const last = entry.renewals.at(-1);
  if (last === undefined) {
    if (entry.expires > addDays(entry.added, QUARANTINE_DAYS)) return [`expires more than ${QUARANTINE_DAYS} days after added`];
    return [];
  }
  if (entry.expires !== last.expires) return ['expires must equal the last renewal\'s expires'];
  return [];
}

/** What is wrong with the entry stored in `fileName`; empty when nothing is. */
export function validateEntry(entry: Partial<Entry>, fileName: string, exists: Exists = repoExists): string[] {
  const shape = shapeProblems(entry);
  if (shape.length > 0) return shape;
  const full = entry as Entry;
  const problems = [...testProblems(full.test, exists), ...renewalProblems(full), ...expiryProblems(full)];
  if (fileName !== entryFileName(full.test)) problems.push(`the file must be named ${entryFileName(full.test)}`);
  return problems;
}

/** The entries a runner honours: an invalid one is reported and ignored, so it
 *  can never forgive a failure. */
export function honouredEntries(entries: LoadedEntry[], exists: Exists = repoExists): LoadedEntry[] {
  return entries.filter((entry) => {
    const problems = validateEntry(entry, entry.file, exists);
    if (problems.length > 0) console.error(`quarantine: ignoring ${entry.file}: ${problems.join('; ')}`);
    return problems.length === 0;
  });
}
