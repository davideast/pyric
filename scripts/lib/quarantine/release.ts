// What the release check posts on quarantine tracking issues after a main
// run: a quarantined test failed in it; a quarantined test passed in each of
// the last RELEASE_STREAK main runs, so its entry can go; an entry expired, so
// its test blocks again. A test's result is its final attempt's, so a pass on
// retry is a pass. Each comment carries a marker, and a comment whose
// marker is already on the issue is not posted again. A pure function of the
// entries, the runs' reports, and the markers already posted.

import { isActive, type LoadedEntry } from './entries.ts';
import type { QuarantineReport } from './report.ts';

/** Consecutive passing main runs after which release is proposed. */
export const RELEASE_STREAK = 20;
/** The newest main runs whose quarantined failures are commented. The job
 *  runs in one concurrency group, where a pending run can be replaced by a
 *  newer one, so each run also looks back at the runs before it. */
export const FAILURE_LOOKBACK = 5;

export interface RunReports {
  runId: number;
  url: string;
  /** One per suite, from the run's latest attempt of that suite's job. */
  reports: QuarantineReport[];
}

export interface IssueComment {
  issue: number;
  marker: string;
  body: string;
}

export interface ReleaseInput {
  entries: LoadedEntry[];
  today: string;
  /** Main push runs, newest first; index 0 is the run that just completed.
   *  Undefined past the last run there is. */
  history: (index: number) => RunReports | undefined;
  /** Markers already in a comment on each entry's issue. */
  posted: ReadonlySet<string>;
}

type RunOutcome = 'passed' | 'failed' | 'not-run';

function outcomesIn(run: RunReports, file: string): string[] {
  return run.reports.flatMap((report) => report.entries.filter((entry) => entry.file === file).map((entry) => entry.outcome));
}

/** Failed anywhere wins; passed needs a pass somewhere and no failure. */
export function runOutcome(run: RunReports, file: string): RunOutcome {
  const outcomes = outcomesIn(run, file);
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('passed')) return 'passed';
  return 'not-run';
}

/** Consecutive passing runs from the newest, up to `limit`. A run that did
 *  not report the entry ends the streak, so a proposal comes late, not early. */
export function streak(history: ReleaseInput['history'], file: string, limit: number = RELEASE_STREAK): number {
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    const run = history(index);
    if (run === undefined || runOutcome(run, file) !== 'passed') return count;
    count += 1;
  }
  return count;
}

function marker(kind: string, file: string, key: string | number): string {
  return `<!-- quarantine:${kind}:${file}:${key} -->`;
}

function failedReports(run: RunReports, file: string): QuarantineReport[] {
  return run.reports.filter((report) => report.entries.some((entry) => entry.file === file && entry.outcome === 'failed'));
}

/** Whether the quarantine kept each suite where the test failed green. */
function blockingText(reports: QuarantineReport[]): string {
  const forgiven = reports.filter((report) => report.forgiven).map((report) => report.suite);
  const blocked = reports.filter((report) => !report.forgiven).map((report) => report.suite);
  const lines: string[] = [];
  if (forgiven.length > 0) lines.push(`It did not fail ${forgiven.join(', ')}: every failure there was quarantined.`);
  if (blocked.length > 0) lines.push(`${blocked.join(', ')} failed anyway, for another reason or a failure no entry covers.`);
  return lines.join('\n');
}

function quarantineStart(entry: LoadedEntry): string {
  return entry.renewals.at(-1)?.date ?? entry.added;
}

function failedComment(entry: LoadedEntry, run: RunReports): IssueComment {
  const mark = marker('failed', entry.file, run.runId);
  const reports = failedReports(run, entry.file);
  const suites = reports.map((report) => report.suite).join(', ');
  const body = `${mark}\n\`${entry.test}\` failed on main while quarantined (expires ${entry.expires}), in ${suites}: ${run.url}\nIts final attempt failed. ${blockingText(reports)}\n`;
  return { issue: entry.issue, marker: mark, body };
}

function releaseComment(entry: LoadedEntry, current: RunReports): IssueComment {
  const mark = marker('release', entry.file, quarantineStart(entry));
  const body = [
    mark,
    `\`${entry.test}\` passed in each of the last ${RELEASE_STREAK} main runs while quarantined, the latest ${current.url}.`,
    '',
    `Proposed: release it by deleting \`.github/quarantine/${entry.file}\`, in the PR that fixes it if it is not fixed yet.`,
    '',
  ].join('\n');
  return { issue: entry.issue, marker: mark, body };
}

function expiredComment(entry: LoadedEntry): IssueComment {
  const mark = marker('expired', entry.file, entry.expires);
  const body = [
    mark,
    `The quarantine of \`${entry.test}\` expired on ${entry.expires}, so its failures block again.`,
    '',
    `To keep it quarantined, renew it with a reason: \`bun scripts/ci/quarantine.ts renew --test '${entry.test}' --reason '<why>'\``,
    '',
  ].join('\n');
  return { issue: entry.issue, marker: mark, body };
}

function recentRuns(history: ReleaseInput['history']): RunReports[] {
  const runs: RunReports[] = [];
  for (let index = 0; index < FAILURE_LOOKBACK; index += 1) {
    const run = history(index);
    if (run === undefined) break;
    runs.push(run);
  }
  return runs;
}

function failureComments(entry: LoadedEntry, input: ReleaseInput): IssueComment[] {
  return recentRuns(input.history)
    .filter((run) => runOutcome(run, entry.file) === 'failed')
    .map((run) => failedComment(entry, run))
    .filter((comment) => !input.posted.has(comment.marker));
}

function entryComments(entry: LoadedEntry, input: ReleaseInput, current: RunReports): IssueComment[] {
  if (!isActive(entry, input.today)) return [expiredComment(entry)];
  const failures = failureComments(entry, input);
  if (failures.length > 0) return failures;
  if (runOutcome(current, entry.file) === 'failed') return [];
  const proposal = releaseComment(entry, current);
  // Reading older runs costs a download each, so a posted proposal stops here.
  if (input.posted.has(proposal.marker)) return [];
  const releasable = streak(input.history, entry.file) >= RELEASE_STREAK;
  if (releasable) return [proposal];
  return [];
}

export function decideComments(input: ReleaseInput): IssueComment[] {
  const current = input.history(0);
  if (current === undefined) return [];
  return input.entries.flatMap((entry) => entryComments(entry, input, current))
    .filter((comment) => !input.posted.has(comment.marker));
}
