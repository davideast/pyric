// Makes a run's quarantine result visible: console lines, a warning
// annotation per quarantined failure (shown on the checks page), a table in
// the job summary, and a JSON report that CI uploads for the release check.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, isFileLevelUnnamed, isUnnamedEntry, unnamedScope, type Entry } from './entries.ts';
import type { Verdict } from './verdict.ts';

/** What a quarantined hook failure may have kept from running, or '' for a
 *  test. bun names a broken beforeAll and a broken afterAll alike, and does
 *  not list the tests a broken hook kept from running, so this says may. */
export function notRunNote(entry: Pick<Entry, 'test'>): string {
  if (!isUnnamedEntry(entry)) return '';
  const scope = unnamedScope(entry).slice(0, -' > '.length);
  if (isFileLevelUnnamed(entry)) return `a file-level hook failed; some or all tests in ${scope} may not have run`;
  return `a hook in \`${scope}\` failed; some or all of its tests may not have run`;
}

function withNote(text: string, entry: Pick<Entry, 'test'>): string {
  const note = notRunNote(entry);
  if (note === '') return text;
  return `${text}; ${note}`;
}

export const REPORTS_DIR = join(REPO_ROOT, 'test-results/quarantine');

/** What the release check reads back from each suite of each main run. */
export interface QuarantineReport {
  suite: string;
  forgiven: boolean;
  reason: string;
  entries: Array<{ file: string; test: string; issue: number; expires: string; outcome: string; note?: string }>;
  expired: Array<{ file: string; test: string; issue: number; expires: string }>;
}

export function toReport(suite: string, verdict: Verdict): QuarantineReport {
  return {
    suite,
    forgiven: verdict.forgiven,
    reason: verdict.reason,
    entries: verdict.outcomes.map(({ entry, outcome }) => {
      const row = { file: entry.file, test: entry.test, issue: entry.issue, expires: entry.expires, outcome };
      const note = outcome === 'failed' ? notRunNote(entry) : '';
      if (note === '') return row;
      return { ...row, note };
    }),
    expired: verdict.expired.map(({ entry }) => ({ file: entry.file, test: entry.test, issue: entry.issue, expires: entry.expires })),
  };
}

/** One line per quarantined or expired failure, then the verdict. Empty when
 *  no entry is active and nothing matched one. */
export function consoleLines(verdict: Verdict): string[] {
  const lines = [
    ...verdict.quarantined.map(({ result, entry }) => withNote(`quarantine: ${result.id} failed; quarantined (#${entry.issue}, expires ${entry.expires})`, entry)),
    ...verdict.ambiguous.map(({ result, entry }) => `quarantine: ${result.id} failed; its entry (#${entry.issue}) names more than one testcase in this run, so it blocks`),
    ...verdict.expired.map(({ result, entry }) => `quarantine: ${result.id} failed; its quarantine expired ${entry.expires} (#${entry.issue}), so it blocks`),
  ];
  const nothingToSay = lines.length === 0 && verdict.outcomes.length === 0;
  if (nothingToSay) return [];
  return [...lines, `quarantine: ${verdict.reason}; exit code ${verdict.exitCode}`];
}

function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function annotations(verdict: Verdict): string[] {
  return verdict.quarantined.map(({ result, entry }) =>
    `::warning title=Quarantined test failed::${escapeAnnotation(withNote(`${result.id} (#${entry.issue}, quarantine expires ${entry.expires})`, entry))}`);
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function resultText(entry: QuarantineReport['entries'][number]): string {
  if (entry.note === undefined) return entry.outcome;
  return `${entry.outcome}: ${entry.note}`;
}

export function summaryMarkdown(report: QuarantineReport): string {
  const rows = [
    ...report.entries.map((entry) => `| \`${cell(entry.test)}\` | #${entry.issue} | ${entry.expires} | ${cell(resultText(entry))} |`),
    ...report.expired.map((entry) => `| \`${cell(entry.test)}\` | #${entry.issue} | ${entry.expires} | failed, expired, blocks |`),
  ];
  if (rows.length === 0) return '';
  return [`### Quarantined tests (${report.suite})`, '', '| test | issue | expires | result |', '|---|---|---|---|', ...rows, '', `${report.reason}.`, '', ''].join('\n');
}

/** Prints the result, and in a workflow annotates it, adds it to the job
 *  summary, and writes the report file. With no active entry and no expired
 *  one matched, there is nothing to report and no file is written. */
export function publish(suite: string, verdict: Verdict, env: NodeJS.ProcessEnv = process.env): void {
  for (const line of consoleLines(verdict)) console.error(line);
  const inWorkflow = env.GITHUB_ACTIONS === 'true';
  if (!inWorkflow) return;
  for (const line of annotations(verdict)) console.log(line);
  const report = toReport(suite, verdict);
  const nothingQuarantined = report.entries.length === 0 && report.expired.length === 0;
  if (nothingQuarantined) return;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${suite}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
