// The words this lane files: issue title prefixes, titles, bodies, and the
// printed plan. Nothing here reads GitHub or decides anything.

import { TEST_FILE, type Failure } from './parse-log.ts';
import type { Action, AttemptReport, IssueAction, Plan } from './decide.ts';

export const FLAKE_PREFIX = 'Flaky on main: ';
export const RED_PREFIX = 'Main is red: ';
export const UNCONFIRMED_PREFIX = 'Unconfirmed failures on main: ';
const MAX_TITLE = 240;

/** The title and body of one filing. */
export interface IssueText {
  prefix: string;
  title: string;
  body: string;
}

function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** What a flaky failure is called: its test, or its job when no test. */
export function failureSubject(failure: Failure): string {
  return failure.test ?? failure.job;
}

/** The prefix a flake issue keeps. The closing backtick stops one test's
 *  prefix from matching a longer test name that starts with it. */
export function flakePrefix(failure: Failure): string {
  return `${FLAKE_PREFIX}\`${truncate(failureSubject(failure), MAX_TITLE - FLAKE_PREFIX.length - 2)}\``;
}

/** The repository path of the failing test's file, or undefined when the
 *  failure names no test file. A bare file name is not enough to match an
 *  issue on: the repository holds many `index.test.ts` and `auth.test.ts`. */
export function testFilePath(failure: Failure): string | undefined {
  const file = failure.test?.split(' > ')[0];
  if (file === undefined || !TEST_FILE.test(file)) return undefined;
  return file;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` names `path` as a whole path: not as the tail of a longer
 *  path, and not as the head of a longer file name. */
export function namesPath(text: string, path: string): boolean {
  return new RegExp(`(?<![\\w./-])${escapeRegExp(path)}(?![\\w.-])`).test(text);
}

function subjectText(failure: Failure): string {
  if (failure.test === undefined) return `job \`${failure.job}\``;
  return `\`${failure.test}\` in \`${failure.job}\``;
}

function assertionSuffix(failure: Failure): string {
  if (failure.assertion === undefined) return '';
  return `: \`${failure.assertion}\``;
}

function assertionText(failure: Failure): string {
  if (failure.assertion === undefined) return 'not found in the job log';
  return `\`${failure.assertion}\``;
}

function failureLines(failures: Failure[]): string[] {
  return failures.map((failure) => `- ${subjectText(failure)}${assertionSuffix(failure)}`);
}

function failedJobs(failures: Failure[]): string[] {
  return [...new Set(failures.map((failure) => failure.job))];
}

function jobList(failures: Failure[]): string {
  const jobs = failedJobs(failures);
  if (jobs.length === 0) return 'Build & Test';
  return jobs.join(', ');
}

function attemptLine(report: AttemptReport | undefined, fallbackAttempt: number): string {
  if (report === undefined) return `- Attempt ${fallbackAttempt}: not found`;
  return `- Attempt ${report.attempt}: ${report.url}`;
}

/** How to quarantine the flake, for a failure that names a test. */
function quarantineLines(failure: Failure): string[] {
  const target = failure.test;
  if (target === undefined) return [];
  return [
    'To stop it blocking while it is fixed, quarantine it for 14 days in a draft PR (it still runs and is reported):',
    '',
    `    bun scripts/ci/quarantine.ts add --test '${target.replace(/'/g, `'\\''`)}' --issue <this issue> --owner <who> --reason '<why>'`,
    '',
  ];
}

export function flakeText(failure: Failure, failed: AttemptReport, passed: AttemptReport): IssueText {
  const prefix = flakePrefix(failure);
  const body = [
    `\`${failureSubject(failure)}\` failed on main and passed when its job was rerun.`,
    '',
    `- Commit: ${failed.headSha}`,
    `- Job: \`${failure.job}\``,
    `- Failing assertion: ${assertionText(failure)}`,
    `- Failed: ${failed.url}`,
    `- Passed on rerun: ${passed.url}`,
    '',
    ...quarantineLines(failure),
  ].join('\n');
  return { prefix, title: prefix, body };
}

export function redText(current: AttemptReport, previous: AttemptReport | undefined): IssueText {
  const title = truncate(`${RED_PREFIX}${shortSha(current.headSha)} fails ${jobList(current.failures)}`, MAX_TITLE);
  const body = [
    `Build & Test failed on main at ${current.headSha}, and failed again when its failed jobs were rerun.`,
    '',
    attemptLine(previous, current.attempt - 1),
    attemptLine(current, current.attempt),
    '',
    '### Failing jobs and tests',
    '',
    ...failureLines(current.failures),
    '',
  ].join('\n');
  return { prefix: RED_PREFIX, title, body };
}

/** Failures that were never rerun to a result, so nobody knows whether they
 *  were flakes. `why` says what stopped the rerun. */
export function unconfirmedText(failed: AttemptReport, why: string): IssueText {
  const title = truncate(`${UNCONFIRMED_PREFIX}${shortSha(failed.headSha)} failed ${jobList(failed.failures)}`, MAX_TITLE);
  const body = [
    `Unconfirmed: Build & Test failed on main at ${failed.headSha}, and ${why}, so these failures may be flakes or real.`,
    '',
    attemptLine(failed, failed.attempt),
    '',
    '### Failing jobs and tests',
    '',
    ...failureLines(failed.failures),
    '',
  ].join('\n');
  return { prefix: UNCONFIRMED_PREFIX, title, body };
}

export function closeBody(current: AttemptReport): string {
  return `Build & Test passed on main at ${current.headSha}: ${current.url}\n`;
}

function issueTarget(action: IssueAction): string {
  if (action.existing === undefined) return 'open a new issue';
  return `comment on #${action.existing}`;
}

function describeIssue(action: IssueAction, verb: string): string {
  return `${verb}: ${issueTarget(action)} titled "${action.title}"\n${indent(action.body)}`;
}

function indent(text: string): string {
  return text.trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'rerun': return `Rerun the failed jobs of run ${action.runId}`;
    case 'file-flake': return describeIssue(action, 'File a flake');
    case 'file-red': return describeIssue(action, 'File main is red');
    case 'file-unconfirmed': return describeIssue(action, 'File unconfirmed failures');
    case 'close': return `Close #${action.number} with the comment:\n${indent(action.body)}`;
  }
}

export function describePlan(report: AttemptReport, plan: Plan): string {
  const head = `Run ${report.runId} attempt ${report.attempt} (${report.conclusion}, ${shortSha(report.headSha)}): ${report.url}`;
  const actions = plan.actions.length === 0 ? ['Nothing to do.'] : plan.actions.map(describeAction);
  return [head, plan.reason, ...actions.map((text) => `- ${text}`)].join('\n');
}
