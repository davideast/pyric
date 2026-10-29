#!/usr/bin/env bun
// Reruns a failed Build & Test run on main once, then files what happened.
// `.github/workflows/main-failure.yml` runs it when a push run on main
// completes, and on a manual dispatch:
//
//   bun scripts/ci/main-failure.ts
//
// Attempt 1 failed: rerun only its failed jobs, wait for attempt 2, and file
// its result. Attempt 2 passed: each test (or job, when its log names no test)
// that failed in attempt 1 is a flake, filed as one `lane:velocity` issue
// titled `Flaky on main: <test>`. Attempt 2 failed: open or update the one
// `Main is red: ` issue. Any green run closes that issue. Attempt 3 or later
// does nothing, so a run is never rerun twice. Issues go through
// `github-issues.ts`, which dedupes them by title prefix.
//
// Environment: RUN_ID (required), RUN_ATTEMPT (the attempt that completed;
// a dispatch leaves it empty and every attempt of the run is classified),
// DRY_RUN ('true' prints the plan and changes nothing), GITHUB_REPOSITORY,
// GITHUB_SERVER_URL, GH_TOKEN.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeOpenIssue, openOrUpdateIssue, type Gh } from './github-issues.ts';

export const FLAKE_PREFIX = 'Flaky on main: ';
export const RED_PREFIX = 'Main is red: ';
const ISSUE_LABEL = 'lane:velocity';
/** Jobs that fail only because another job failed. */
const SUMMARY_JOBS: readonly string[] = ['CI / required'];
/** A run whose log parses into more failures than this files only this many. */
export const MAX_FLAKE_ISSUES = 10;
const MAX_TITLE = 240;

/** One failing test, or a failing job whose log names no test. */
export interface Failure {
  job: string;
  /** `<file> > <test name>`, or undefined when the log names no test. */
  test?: string;
  /** The error line the failure printed, with its source location. */
  assertion?: string;
}

export interface AttemptReport {
  runId: number;
  attempt: number;
  /** The run conclusion for this attempt: success, failure, cancelled, … */
  conclusion: string;
  headSha: string;
  url: string;
  failures: Failure[];
}

export interface OpenIssue {
  number: number;
  title: string;
}

export interface DecisionInput {
  current: AttemptReport;
  /** The attempt before `current`, when `current` is attempt 2. */
  previous?: AttemptReport;
  openIssues: OpenIssue[];
}

export interface IssueAction {
  kind: 'file-flake' | 'file-red';
  prefix: string;
  title: string;
  body: string;
  /** The open issue the filing comments on, or undefined when it opens one. */
  existing?: number;
}

export type Action =
  | { kind: 'rerun'; runId: number }
  | IssueAction
  | { kind: 'close-red'; number: number; body: string };

export interface Plan {
  reason: string;
  actions: Action[];
}

// ---------------------------------------------------------------------------
// Reading a job log

const ANSI = /\u001b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const TEST_GROUP = /^##\[group\](.+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const ERROR_LINE = /^(?:error|[A-Za-z]*Error)(?::\s|:$)/;
const STACK_LOCATION = /^at .*?\(?(?:file:\/\/)?\/home\/runner\/work\/[^/]+\/[^/]+\/([^)\s]+:\d+:\d+)\)?$/;
const FAILED_SUMMARY = /^\d+ tests? failed:$/;
const HOOK_NOTE = /^\^ (.+)$/;
const ACTIONS_ERROR = /^##\[error\](.+)$/;
/** `bun run` reports the script it ran exiting, which names no failure. */
const SCRIPT_EXIT = /^error: script ".*" exited with code \d+$/;

function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line) && !SCRIPT_EXIT.test(line);
}

function logLines(log: string): string[] {
  return log.replace(ANSI, '').split('\n').map((line) => line.replace(TIMESTAMP, '').replace(/\r$/, ''));
}

function withLocation(error: string, location: string | undefined): string {
  return location === undefined ? error : `${error} (at ${location})`;
}

/** The last error line in a log and where it was thrown, for a job whose
 *  log names no test. Falls back to the last Actions error annotation. */
function lastError(lines: string[]): string | undefined {
  const index = lines.findLastIndex((line) => isErrorLine(line));
  if (index !== -1) {
    const location = lines.slice(index + 1, index + 12)
      .map((line) => STACK_LOCATION.exec(line.trim())?.[1])
      .find((found) => found !== undefined);
    return withLocation(lines[index] ?? '', location);
  }
  const annotations = lines.map((line) => ACTIONS_ERROR.exec(line)?.[1]).filter((text) => text !== undefined);
  return annotations.at(-1);
}

/** The failing `bun test` tests a job log names, each with the last error line
 *  it printed, or the job itself with its last error when the log names none. */
export function parseFailures(job: string, log: string): Failure[] {
  const lines = logLines(log);
  const failures = new Map<string, Failure>();
  let file: string | undefined;
  let error: string | undefined;
  let location: string | undefined;
  let lastFailure: Failure | undefined;

  for (const line of lines) {
    if (FAILED_SUMMARY.test(line)) break;
    const group = TEST_GROUP.exec(line);
    if (group) {
      file = group[1];
      error = location = lastFailure = undefined;
      continue;
    }
    if (line.startsWith('##[endgroup]')) {
      file = error = location = lastFailure = undefined;
      continue;
    }
    const failed = FAIL_LINE.exec(line);
    if (failed) {
      const name = failed[1] ?? '(unnamed)';
      const test = file === undefined ? name : `${file} > ${name}`;
      const failure: Failure = { job, test, ...(error ? { assertion: withLocation(error, location) } : {}) };
      if (!failures.has(test)) failures.set(test, failure);
      lastFailure = failures.get(test);
      error = location = undefined;
      continue;
    }
    if (line.startsWith('(pass) ') || line.startsWith('(skip) ')) {
      error = location = lastFailure = undefined;
      continue;
    }
    const note = HOOK_NOTE.exec(line.trim());
    if (note && lastFailure && lastFailure.assertion === undefined) {
      lastFailure.assertion = note[1];
      continue;
    }
    if (isErrorLine(line)) {
      error = line;
      location = undefined;
      continue;
    }
    if (error !== undefined && location === undefined) {
      location = STACK_LOCATION.exec(line.trim())?.[1];
    }
  }

  if (failures.size > 0) return [...failures.values()];
  const assertion = lastError(lines);
  return [{ job, ...(assertion ? { assertion } : {}) }];
}

/** The jobs worth naming: summary jobs drop out when another job failed. */
export function namedFailedJobs(jobs: string[]): string[] {
  const real = jobs.filter((job) => !SUMMARY_JOBS.includes(job));
  return real.length > 0 ? real : jobs;
}

// ---------------------------------------------------------------------------
// Deciding

const FAILED = new Set(['failure', 'timed_out']);

function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What a flaky failure is called: its test, or its job when no test. */
function failureSubject(failure: Failure): string {
  return failure.test ?? failure.job;
}

/** The prefix a flake issue keeps. The closing backtick stops one test's
 *  prefix from matching a longer test name that starts with it. */
export function flakePrefix(failure: Failure): string {
  return `${FLAKE_PREFIX}\`${truncate(failureSubject(failure), MAX_TITLE - FLAKE_PREFIX.length - 2)}\``;
}

function existingIssue(openIssues: OpenIssue[], prefix: string): number | undefined {
  return openIssues.find((issue) => issue.title.startsWith(prefix))?.number;
}

function failureLines(failures: Failure[]): string[] {
  return failures.map((failure) => {
    const subject = failure.test === undefined ? `job \`${failure.job}\`` : `\`${failure.test}\` in \`${failure.job}\``;
    return `- ${subject}${failure.assertion ? `: \`${failure.assertion}\`` : ''}`;
  });
}

function uniqueSubjects(failures: Failure[]): Failure[] {
  const seen = new Map<string, Failure>();
  for (const failure of failures) {
    if (!seen.has(failureSubject(failure))) seen.set(failureSubject(failure), failure);
  }
  return [...seen.values()];
}

function flakeAction(failure: Failure, failed: AttemptReport, passed: AttemptReport, openIssues: OpenIssue[]): IssueAction {
  const prefix = flakePrefix(failure);
  const body = [
    `\`${failureSubject(failure)}\` failed on main and passed when its job was rerun.`,
    '',
    `- Commit: ${failed.headSha}`,
    `- Job: \`${failure.job}\``,
    `- Failing assertion: ${failure.assertion ? `\`${failure.assertion}\`` : 'not found in the job log'}`,
    `- Failed: ${failed.url}`,
    `- Passed on rerun: ${passed.url}`,
    '',
  ].join('\n');
  return { kind: 'file-flake', prefix, title: prefix, body, existing: existingIssue(openIssues, prefix) };
}

function failedJobs(failures: Failure[]): string[] {
  return [...new Set(failures.map((failure) => failure.job))];
}

function redAction(current: AttemptReport, previous: AttemptReport | undefined, openIssues: OpenIssue[]): IssueAction {
  const jobs = failedJobs(current.failures);
  const title = truncate(`${RED_PREFIX}${shortSha(current.headSha)} fails ${jobs.join(', ') || 'Build & Test'}`, MAX_TITLE);
  const body = [
    `Build & Test failed on main at ${current.headSha}, and failed again when its failed jobs were rerun.`,
    '',
    `- Attempt ${previous?.attempt ?? current.attempt - 1}: ${previous?.url ?? 'not found'}`,
    `- Attempt ${current.attempt}: ${current.url}`,
    '',
    '### Failing jobs and tests',
    '',
    ...failureLines(current.failures),
    '',
  ].join('\n');
  return { kind: 'file-red', prefix: RED_PREFIX, title, body, existing: existingIssue(openIssues, RED_PREFIX) };
}

function closeRedAction(current: AttemptReport, openIssues: OpenIssue[]): Action[] {
  const open = existingIssue(openIssues, RED_PREFIX);
  if (open === undefined) return [];
  const body = `Build & Test passed on main at ${current.headSha}: ${current.url}\n`;
  return [{ kind: 'close-red', number: open, body }];
}

/** What to do about one completed attempt of a push run on main. */
export function decide(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  const passed = current.conclusion === 'success';
  const failed = FAILED.has(current.conclusion);

  if (current.attempt >= 3) {
    return { reason: `attempt ${current.attempt}: past the one rerun, so nothing is rerun or filed`, actions: [] };
  }
  if (!passed && !failed) {
    return { reason: `attempt ${current.attempt} ended ${current.conclusion}, so nothing is rerun or filed`, actions: [] };
  }
  if (failed && current.attempt === 1) {
    return { reason: 'attempt 1 failed: rerun its failed jobs once', actions: [{ kind: 'rerun', runId: current.runId }] };
  }
  if (failed) {
    return { reason: 'attempt 2 failed again: main is red', actions: [redAction(current, previous, openIssues)] };
  }

  const closing = closeRedAction(current, openIssues);
  const rerunPassed = current.attempt === 2 && previous !== undefined && FAILED.has(previous.conclusion);
  if (!rerunPassed) {
    return { reason: `attempt ${current.attempt} passed`, actions: closing };
  }
  const flakes = uniqueSubjects(previous.failures).slice(0, MAX_FLAKE_ISSUES)
    .map((failure) => flakeAction(failure, previous, current, openIssues));
  return { reason: 'attempt 2 passed after attempt 1 failed: the failures were flakes', actions: [...flakes, ...closing] };
}

// ---------------------------------------------------------------------------
// Printing a plan

function describeIssue(action: IssueAction, verb: string): string {
  const target = action.existing === undefined ? 'open a new issue' : `comment on #${action.existing}`;
  return `${verb}: ${target} titled "${action.title}"\n${indent(action.body)}`;
}

function indent(text: string): string {
  return text.trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'rerun': return `Rerun the failed jobs of run ${action.runId}`;
    case 'file-flake': return describeIssue(action, 'File a flake');
    case 'file-red': return describeIssue(action, 'File main is red');
    case 'close-red': return `Close #${action.number} with the comment:\n${indent(action.body)}`;
  }
}

export function describePlan(report: AttemptReport, plan: Plan): string {
  const head = `Run ${report.runId} attempt ${report.attempt} (${report.conclusion}, ${shortSha(report.headSha)}): ${report.url}`;
  const actions = plan.actions.length === 0 ? ['Nothing to do.'] : plan.actions.map(describeAction);
  return [head, plan.reason, ...actions.map((text) => `- ${text}`)].join('\n');
}

// ---------------------------------------------------------------------------
// GitHub

/** Runs `gh` with room for a whole job log, which overflows the default buffer. */
function largeGh(): Gh {
  return (args) => {
    const out = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (out.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${out.stderr || out.error?.message}`);
    return out.stdout;
  };
}

interface Context {
  gh: Gh;
  repo: string;
}

function api<T>(context: Context, path: string): T {
  return JSON.parse(context.gh(['api', `repos/${context.repo}/${path}`])) as T;
}

interface RunAttemptJson {
  run_attempt: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
}

interface JobJson {
  id: number;
  name: string;
  conclusion: string | null;
}

function jobFailures(context: Context, job: JobJson): Failure[] {
  try {
    return parseFailures(job.name, context.gh(['api', `repos/${context.repo}/actions/jobs/${job.id}/logs`]));
  } catch (error) {
    console.warn(`Could not read the log of job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    return [{ job: job.name }];
  }
}

function attemptUrl(runUrl: string, attempt: number): string {
  return `${runUrl.replace(/\/attempts\/\d+$/, '')}/attempts/${attempt}`;
}

function collectAttempt(context: Context, runId: number, attempt: number): AttemptReport {
  const run = api<RunAttemptJson>(context, `actions/runs/${runId}/attempts/${attempt}`);
  const { jobs } = api<{ jobs: JobJson[] }>(context, `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  const failed = jobs.filter((job) => job.conclusion !== null && FAILED.has(job.conclusion));
  const named = new Set(namedFailedJobs(failed.map((job) => job.name)));
  const failures = FAILED.has(run.conclusion ?? '')
    ? failed.filter((job) => named.has(job.name)).flatMap((job) => jobFailures(context, job))
    : [];
  return {
    runId,
    attempt,
    conclusion: run.status === 'completed' ? run.conclusion ?? 'unknown' : run.status,
    headSha: run.head_sha,
    url: attemptUrl(run.html_url, attempt),
    failures,
  };
}

function openIssues(context: Context): OpenIssue[] {
  const search = (prefix: string): OpenIssue[] => JSON.parse(context.gh([
    'issue', 'list', '--repo', context.repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title', '--search', `"${prefix.trim().replace(/:$/, '')}" in:title`,
  ])) as OpenIssue[];
  return [...search(FLAKE_PREFIX), ...search(RED_PREFIX)];
}

function latestAttempt(context: Context, runId: number): number {
  return api<{ run_attempt: number }>(context, `actions/runs/${runId}`).run_attempt;
}

/** Waits for the attempt after `attempt` to complete. */
async function waitForNextAttempt(context: Context, runId: number, attempt: number): Promise<void> {
  const deadline = Date.now() + 80 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(30_000);
    const run = api<{ run_attempt: number; status: string }>(context, `actions/runs/${runId}`);
    if (run.run_attempt > attempt && run.status === 'completed') return;
  }
  throw new Error(`Attempt ${attempt + 1} of run ${runId} did not complete within 80 minutes`);
}

function fileIssue(context: Context, action: IssueAction, dir: string, index: number): string {
  const bodyFile = join(dir, `issue-${index}.md`);
  writeFileSync(bodyFile, action.body);
  return openOrUpdateIssue(context.gh, { prefix: action.prefix, title: action.title, label: ISSUE_LABEL, bodyFile });
}

function closeRed(context: Context, action: { number: number; body: string }, dir: string): string {
  const bodyFile = join(dir, 'close-red.md');
  writeFileSync(bodyFile, action.body);
  const closed = closeOpenIssue(context.gh, RED_PREFIX, bodyFile);
  return closed === undefined ? 'no open issue to close' : `closed #${closed}`;
}

/** Carries out every action but the rerun, which `handleAttempt` runs. */
function applyFilings(context: Context, plan: Plan): void {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'main-failure-'));
  plan.actions.forEach((action, index) => {
    if (action.kind === 'file-flake' || action.kind === 'file-red') console.log(fileIssue(context, action, dir, index));
    if (action.kind === 'close-red') console.log(closeRed(context, action, dir));
  });
}

function report(text: string): void {
  console.log(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n\n`);
}

function planFor(context: Context, runId: number, attempt: number, issues: OpenIssue[]): { current: AttemptReport; plan: Plan } {
  const current = collectAttempt(context, runId, attempt);
  const previous = attempt === 2 ? collectAttempt(context, runId, 1) : undefined;
  return { current, plan: decide({ current, previous, openIssues: issues }) };
}

/** Classifies one attempt and acts on it. A rerun waits for the next attempt
 *  and acts on that too, because a rerun started with the workflow token does
 *  not start this workflow again when it completes. */
async function handleAttempt(context: Context, runId: number, attempt: number): Promise<void> {
  const { current, plan } = planFor(context, runId, attempt, openIssues(context));
  report(describePlan(current, plan));
  const rerun = plan.actions.some((action) => action.kind === 'rerun');
  if (!rerun) {
    applyFilings(context, plan);
    return;
  }
  context.gh(['run', 'rerun', String(runId), '--failed', '--repo', context.repo]);
  console.log(`Reran the failed jobs of run ${runId}; waiting for attempt ${attempt + 1}.`);
  await waitForNextAttempt(context, runId, attempt);
  const next = planFor(context, runId, attempt + 1, openIssues(context));
  report(describePlan(next.current, next.plan));
  if (next.plan.actions.some((action) => action.kind === 'rerun')) throw new Error('A second rerun was planned; refusing it');
  applyFilings(context, next.plan);
}

/** Prints the plan for every attempt of a past run, changing nothing. */
function dryRun(context: Context, runId: number, attempt: number | undefined): void {
  const issues = openIssues(context);
  const last = attempt ?? latestAttempt(context, runId);
  const first = attempt ?? 1;
  console.log(`Dry run: nothing is rerun or filed.\n`);
  for (let current = first; current <= last; current += 1) {
    const planned = planFor(context, runId, current, issues);
    report(describePlan(planned.current, planned.plan));
  }
}

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

if (import.meta.main) {
  const runId = positive(process.env.RUN_ID);
  const repo = process.env.GITHUB_REPOSITORY;
  if (runId === undefined || !repo) {
    console.error('usage: RUN_ID=<run id> GITHUB_REPOSITORY=<owner/repo> [RUN_ATTEMPT=<n>] [DRY_RUN=true] bun scripts/ci/main-failure.ts');
    process.exit(2);
  }
  const context: Context = { gh: largeGh(), repo };
  const attempt = positive(process.env.RUN_ATTEMPT);
  if (process.env.DRY_RUN !== 'false') {
    dryRun(context, runId, attempt);
  } else {
    await handleAttempt(context, runId, attempt ?? latestAttempt(context, runId));
  }
}
