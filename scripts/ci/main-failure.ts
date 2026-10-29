#!/usr/bin/env bun
// Reruns a failed Build & Test run on main once, then files what happened.
// `.github/workflows/main-failure.yml` runs it when a push run on main
// completes, and on a manual dispatch:
//
//   bun scripts/ci/main-failure.ts
//
// Attempt 1 failed: rerun only its failed jobs, wait for attempt 2, and file
// its result. Build & Test on main cancels an in-progress run when another
// starts, and a rerun joins that group, so attempt 1 is rerun only while its
// commit is still the head of main and no newer push run is pending; otherwise
// its failures go to the one `Unconfirmed failures on main: ` issue. Attempt 2
// passed: each test (or job, when its log names no test) that failed in
// attempt 1 is a flake, filed as one `lane:velocity` issue titled
// `Flaky on main: <test>`, or commented on an open issue that already names
// the test file. Attempt 2 failed: open or update the one `Main is red: `
// issue. Attempt 2 cancelled: attempt 1's failures go to the unconfirmed
// issue. Any green run closes the red issue. Nothing is rerun past attempt 1,
// so a run is never rerun twice. Issues go through `github-issues.ts`.
//
// Environment: RUN_ID (required), RUN_ATTEMPT (the attempt that completed;
// a dispatch leaves it empty and every attempt of the run is classified),
// DRY_RUN ('true' prints the plan and changes nothing), GITHUB_REPOSITORY,
// GH_TOKEN.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeOpenIssue, openOrUpdateIssue, type Gh } from './github-issues.ts';

export const FLAKE_PREFIX = 'Flaky on main: ';
export const RED_PREFIX = 'Main is red: ';
export const UNCONFIRMED_PREFIX = 'Unconfirmed failures on main: ';
const ISSUE_LABEL = 'lane:velocity';
/** The only workflow this lane reruns. */
const BUILD_WORKFLOW_PATH = '.github/workflows/build.yml';
/** Jobs that fail only because another job failed. */
const SUMMARY_JOBS: readonly string[] = ['CI / required'];
/** A run whose log parses into more failures than this files only this many. */
export const MAX_FLAKE_ISSUES = 10;
const MAX_TITLE = 240;
/** How long the rerun job waits for attempt 2. The job's timeout is longer. */
export const ATTEMPT_WAIT_MINUTES = 80;
const POLL_MS = 30_000;
const REPO_ROOT = resolve(import.meta.dir, '../..');

/** One failing test, or a failing job whose log names no test. */
export interface Failure {
  job: string;
  /** `<repo path of the file> > <test name>`, or undefined when the log names no test. */
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
  body?: string;
}

export interface DecisionInput {
  current: AttemptReport;
  /** The attempt before `current`, when `current` is attempt 2. */
  previous?: AttemptReport;
  openIssues: OpenIssue[];
  /** The commit is no longer the head of main, or a newer push run is
   *  pending, so a rerun would join (and cancel, or be cancelled by) it. */
  superseded?: boolean;
}

export interface IssueAction {
  kind: 'file-flake' | 'file-red' | 'file-unconfirmed';
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
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_GROUP = /^##\[group\](.+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const ERROR_LINE = /^(?:error|[A-Za-z]*Error)(?::\s|:$)/;
const STACK_LOCATION = /^at .*?\(?(?:file:\/\/)?\/home\/runner\/work\/[^/]+\/[^/]+\/([^)\s]+:\d+:\d+)\)?$/;
const FAILED_SUMMARY = /^\d+ tests? failed:$/;
const HOOK_NOTE = /^\^ (.+)$/;
const ACTIONS_ERROR = /^##\[error\](.+)$/;
/** `bun run` reports the script it ran exiting, which names no failure. */
const SCRIPT_EXIT = /^error: script ".*" exited with code \d+$/;

/** Turns a test file path, relative to the directory `bun test` ran in, into
 *  its path in the repository. */
export type FileResolver = (relative: string) => string;

function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line) && !SCRIPT_EXIT.test(line);
}

function isResultLine(line: string): boolean {
  return line.startsWith('(pass) ') || line.startsWith('(skip) ');
}

function logLines(log: string): string[] {
  return log.replace(ANSI, '').split('\n').map((line) => line.replace(TIMESTAMP, '').replace(/\r$/, ''));
}

function withLocation(error: string, location: string | undefined): string {
  if (location === undefined) return error;
  return `${error} (at ${location})`;
}

function stackLocation(line: string): string | undefined {
  return STACK_LOCATION.exec(line.trim())?.[1];
}

/** The last error line in a log and where it was thrown, for a job whose
 *  log names no test. Falls back to the last Actions error annotation. */
function lastError(lines: string[]): string | undefined {
  const index = lines.findLastIndex((line) => isErrorLine(line));
  if (index !== -1) {
    const location = lines.slice(index + 1, index + 12).map(stackLocation).find((found) => found !== undefined);
    return withLocation(lines[index] ?? '', location);
  }
  const annotations = lines.map((line) => ACTIONS_ERROR.exec(line)?.[1]).filter((text) => text !== undefined);
  return annotations.at(-1);
}

/** What the parser remembers between lines of a log. */
interface ParseState {
  /** The repository path of the test file whose group is open. */
  file?: string;
  /** The last error line since the previous test result. */
  error?: string;
  /** Where `error` was thrown. */
  location?: string;
  /** The failure just recorded, which a hook note on the next line explains. */
  lastFailure?: Failure;
}

function clearError(state: ParseState): void {
  state.error = undefined;
  state.location = undefined;
}

function clearTest(state: ParseState): void {
  clearError(state);
  state.lastFailure = undefined;
}

function clearGroup(state: ParseState): void {
  clearTest(state);
  state.file = undefined;
}

function testId(state: ParseState, name: string): string {
  if (state.file === undefined) return name;
  return `${state.file} > ${name}`;
}

function withAssertion(failure: Failure, assertion: string | undefined): Failure {
  if (assertion === undefined) return failure;
  return { ...failure, assertion };
}

function currentAssertion(state: ParseState): string | undefined {
  if (state.error === undefined) return undefined;
  return withLocation(state.error, state.location);
}

/** The failing `bun test` tests a job log names, each with the last error line
 *  it printed, or the job itself with its last error when the log names none.
 *  A test that fails twice in one log keeps its first failure. */
export function parseFailures(job: string, log: string, resolveFile: FileResolver = (file) => file): Failure[] {
  const lines = logLines(log);
  const failures = new Map<string, Failure>();
  const state: ParseState = {};

  for (const line of lines) {
    if (FAILED_SUMMARY.test(line)) break;
    const group = TEST_GROUP.exec(line);
    if (group) {
      clearGroup(state);
      state.file = resolveFile(group[1] ?? '');
      continue;
    }
    if (line.startsWith('##[endgroup]')) {
      clearGroup(state);
      continue;
    }
    const failed = FAIL_LINE.exec(line);
    if (failed) {
      const test = testId(state, failed[1] ?? '(unnamed)');
      if (!failures.has(test)) failures.set(test, withAssertion({ job, test }, currentAssertion(state)));
      clearError(state);
      state.lastFailure = failures.get(test);
      continue;
    }
    if (isResultLine(line)) {
      clearTest(state);
      continue;
    }
    const note = HOOK_NOTE.exec(line.trim());
    const explainsLastFailure = note !== null && state.lastFailure?.assertion === undefined;
    if (explainsLastFailure && state.lastFailure) {
      state.lastFailure.assertion = note[1];
      continue;
    }
    if (isErrorLine(line)) {
      state.error = line;
      state.location = undefined;
      continue;
    }
    if (state.error !== undefined && state.location === undefined) state.location = stackLocation(line);
  }

  if (failures.size > 0) return [...failures.values()];
  return [withAssertion({ job }, lastError(lines))];
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
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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

/** The test file's name without its directory or test extension, which an
 *  issue filed by hand is likely to mention. */
export function testFileStem(failure: Failure): string | undefined {
  const file = failure.test?.split(' > ')[0];
  if (file === undefined || !TEST_FILE.test(file)) return undefined;
  return file.split('/').at(-1)?.replace(TEST_FILE, '');
}

function issueWithPrefix(openIssues: OpenIssue[], prefix: string): number | undefined {
  return openIssues.find((issue) => issue.title.startsWith(prefix))?.number;
}

function isLaneStandingIssue(issue: OpenIssue): boolean {
  return issue.title.startsWith(RED_PREFIX) || issue.title.startsWith(UNCONFIRMED_PREFIX);
}

function mentions(issue: OpenIssue, stem: string): boolean {
  return issue.title.includes(stem) || (issue.body ?? '').includes(stem);
}

/** The open issue a flake belongs to: this lane's issue for the test, or else
 *  any other open issue that names the test file, such as one filed by hand. */
function flakeIssue(openIssues: OpenIssue[], failure: Failure): number | undefined {
  const own = issueWithPrefix(openIssues, flakePrefix(failure));
  if (own !== undefined) return own;
  const stem = testFileStem(failure);
  if (stem === undefined) return undefined;
  return openIssues.find((issue) => !isLaneStandingIssue(issue) && mentions(issue, stem))?.number;
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

function uniqueSubjects(failures: Failure[]): Failure[] {
  const seen = new Map<string, Failure>();
  for (const failure of failures) {
    if (!seen.has(failureSubject(failure))) seen.set(failureSubject(failure), failure);
  }
  return [...seen.values()];
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

function flakeAction(failure: Failure, failed: AttemptReport, passed: AttemptReport, openIssues: OpenIssue[]): IssueAction {
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
  ].join('\n');
  return { kind: 'file-flake', prefix, title: prefix, body, existing: flakeIssue(openIssues, failure) };
}

function redAction(current: AttemptReport, previous: AttemptReport | undefined, openIssues: OpenIssue[]): IssueAction {
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
  return { kind: 'file-red', prefix: RED_PREFIX, title, body, existing: issueWithPrefix(openIssues, RED_PREFIX) };
}

/** Failures that were never rerun to a result, so nobody knows whether they
 *  were flakes. `why` says what stopped the rerun. */
function unconfirmedAction(failed: AttemptReport, why: string, openIssues: OpenIssue[]): IssueAction {
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
  return {
    kind: 'file-unconfirmed',
    prefix: UNCONFIRMED_PREFIX,
    title,
    body,
    existing: issueWithPrefix(openIssues, UNCONFIRMED_PREFIX),
  };
}

function closeRedAction(current: AttemptReport, openIssues: OpenIssue[]): Action[] {
  const open = issueWithPrefix(openIssues, RED_PREFIX);
  if (open === undefined) return [];
  const body = `Build & Test passed on main at ${current.headSha}: ${current.url}\n`;
  return [{ kind: 'close-red', number: open, body }];
}

const SUPERSEDED_REASON = 'a newer push to main superseded it before the rerun';
const RERUN_CANCELLED_REASON = 'the rerun of its failed jobs was cancelled';

function decideFailed(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  if (current.attempt >= 3) {
    return { reason: `attempt ${current.attempt} failed: past the one rerun, so nothing is rerun or filed`, actions: [] };
  }
  if (current.attempt === 2) {
    return { reason: 'attempt 2 failed again: main is red', actions: [redAction(current, previous, openIssues)] };
  }
  if (input.superseded === true) {
    return {
      reason: 'attempt 1 failed, but rerunning it would share the concurrency group with a newer push run: filed unconfirmed',
      actions: [unconfirmedAction(current, SUPERSEDED_REASON, openIssues)],
    };
  }
  return { reason: 'attempt 1 failed: rerun its failed jobs once', actions: [{ kind: 'rerun', runId: current.runId }] };
}

function decidePassed(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  const closing = closeRedAction(current, openIssues);
  const rerunPassed = current.attempt === 2 && previous !== undefined && FAILED.has(previous.conclusion);
  if (!rerunPassed) return { reason: `attempt ${current.attempt} passed`, actions: closing };
  const flakes = uniqueSubjects(previous.failures).slice(0, MAX_FLAKE_ISSUES)
    .map((failure) => flakeAction(failure, previous, current, openIssues));
  return { reason: 'attempt 2 passed after attempt 1 failed: the failures were flakes', actions: [...flakes, ...closing] };
}

function decideUnfinished(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  const rerunCancelled = current.attempt === 2 && current.conclusion === 'cancelled'
    && previous !== undefined && FAILED.has(previous.conclusion);
  if (rerunCancelled) {
    return {
      reason: 'attempt 2 was cancelled after attempt 1 failed: filed unconfirmed',
      actions: [unconfirmedAction(previous, RERUN_CANCELLED_REASON, openIssues)],
    };
  }
  return { reason: `attempt ${current.attempt} ended ${current.conclusion}, so nothing is rerun or filed`, actions: [] };
}

/** What to do about one completed attempt of a push run on main. */
export function decide(input: DecisionInput): Plan {
  if (input.current.conclusion === 'success') return decidePassed(input);
  if (FAILED.has(input.current.conclusion)) return decideFailed(input);
  return decideUnfinished(input);
}

// ---------------------------------------------------------------------------
// Printing a plan

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

export interface Context {
  gh: Gh;
  repo: string;
  /** Prints a plan, and adds it to the job summary in a workflow. */
  log: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  resolveFile: FileResolver;
  /** Where issue bodies are written before `gh` reads them. */
  tempDir: () => string;
}

type FieldType = 'string' | 'number' | 'string?';

/** Checks that `value` is an object whose fields have these types. */
function checked<T>(value: unknown, shape: Record<string, FieldType>, what: string): T {
  if (typeof value !== 'object' || value === null) throw new Error(`${what}: expected an object`);
  const record = value as Record<string, unknown>;
  for (const [key, type] of Object.entries(shape)) {
    const field = record[key];
    const absent = field === null || field === undefined;
    if (absent && type === 'string?') continue;
    if (typeof field !== type.replace('?', '')) throw new Error(`${what}: field ${key} is not a ${type}`);
  }
  return value as T;
}

function checkedList<T>(value: unknown, shape: Record<string, FieldType>, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a list`);
  return value.map((item, index) => checked<T>(item, shape, `${what}[${index}]`));
}

function api(context: Context, path: string): unknown {
  return JSON.parse(context.gh(['api', `repos/${context.repo}/${path}`]));
}

interface RunJson {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  workflow_id: number;
  created_at: string;
  updated_at: string;
  html_url: string;
}

const RUN_SHAPE: Record<string, FieldType> = {
  id: 'number', run_attempt: 'number', status: 'string', conclusion: 'string?', head_sha: 'string',
  head_branch: 'string', event: 'string', path: 'string', workflow_id: 'number', created_at: 'string',
  updated_at: 'string', html_url: 'string',
};

interface JobJson {
  id: number;
  name: string;
  conclusion: string | null;
}

const JOB_SHAPE: Record<string, FieldType> = { id: 'number', name: 'string', conclusion: 'string?' };
const ISSUE_SHAPE: Record<string, FieldType> = { number: 'number', title: 'string', body: 'string?' };

function getRun(context: Context, runId: number, attempt?: number): RunJson {
  const path = attempt === undefined ? `actions/runs/${runId}` : `actions/runs/${runId}/attempts/${attempt}`;
  return checked<RunJson>(api(context, path), RUN_SHAPE, `run ${runId}`);
}

function listRuns(context: Context, path: string): RunJson[] {
  const page = checked<{ workflow_runs: unknown }>(api(context, path), {}, 'workflow runs');
  return checkedList<RunJson>(page.workflow_runs, RUN_SHAPE, 'workflow runs');
}

/** A job log holds colour codes. The gh on GitHub's runners refuses to print
 *  them without --allow-escape-sequences, and an older gh rejects that flag. */
function readJobLog(context: Context, jobId: number): string {
  const path = `repos/${context.repo}/actions/jobs/${jobId}/logs`;
  try {
    return context.gh(['api', '--allow-escape-sequences', path]);
  } catch (error) {
    const flagUnknown = error instanceof Error && error.message.includes('unknown flag');
    if (!flagUnknown) throw error;
    return context.gh(['api', path]);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function jobFailures(context: Context, job: JobJson): Failure[] {
  try {
    return parseFailures(job.name, readJobLog(context, job.id), context.resolveFile);
  } catch (error) {
    console.warn(`Could not read the log of job ${job.id}: ${errorText(error)}`);
    return [{ job: job.name }];
  }
}

function attemptUrl(runUrl: string, attempt: number): string {
  return `${runUrl.replace(/\/attempts\/\d+$/, '')}/attempts/${attempt}`;
}

function attemptConclusion(run: RunJson): string {
  if (run.status !== 'completed') return run.status;
  return run.conclusion ?? 'unknown';
}

export function collectAttempt(context: Context, runId: number, attempt: number): AttemptReport {
  const run = getRun(context, runId, attempt);
  const page = checked<{ jobs: unknown }>(api(context, `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`), {}, 'jobs');
  const jobs = checkedList<JobJson>(page.jobs, JOB_SHAPE, 'jobs');
  const failed = jobs.filter((job) => job.conclusion !== null && FAILED.has(job.conclusion));
  const named = new Set(namedFailedJobs(failed.map((job) => job.name)));
  const runFailed = FAILED.has(run.conclusion ?? '');
  const failures = runFailed ? failed.filter((job) => named.has(job.name)).flatMap((job) => jobFailures(context, job)) : [];
  return {
    runId,
    attempt,
    conclusion: attemptConclusion(run),
    headSha: run.head_sha,
    url: attemptUrl(run.html_url, attempt),
    failures,
  };
}

function searchIssues(context: Context, query: string): OpenIssue[] {
  const found = JSON.parse(context.gh([
    'issue', 'list', '--repo', context.repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,body', '--search', query,
  ]));
  return checkedList<OpenIssue>(found, ISSUE_SHAPE, 'issues');
}

/** This lane's open issues, and any open issue that names a test file in
 *  `failures`. */
function openIssues(context: Context, failures: Failure[]): OpenIssue[] {
  const prefixes = [FLAKE_PREFIX, RED_PREFIX, UNCONFIRMED_PREFIX].map((prefix) => `"${prefix.replace(/: $/, '')}" in:title`);
  const stems = [...new Set(failures.map(testFileStem).filter((stem) => stem !== undefined))].slice(0, MAX_FLAKE_ISSUES);
  const queries = [...prefixes, ...stems.map((stem) => `"${stem}" in:title,body`)];
  const byNumber = new Map<number, OpenIssue>();
  for (const issue of queries.flatMap((query) => searchIssues(context, query))) byNumber.set(issue.number, issue);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Whether the run's commit is no longer the head of main, or a newer push
 *  run of the workflow is queued or in progress. Either way a rerun would
 *  join that run's concurrency group. */
function supersededNow(context: Context, run: RunJson): boolean {
  const branch = checked<{ commit: unknown }>(api(context, 'branches/main'), {}, 'branch main');
  const head = checked<{ sha: string }>(branch.commit, { sha: 'string' }, 'branch main commit');
  const headMoved = head.sha !== run.head_sha;
  const recent = listRuns(context, `actions/workflows/${run.workflow_id}/runs?branch=main&event=push&per_page=10`);
  const newerPending = recent.some((other) => other.id !== run.id && other.status !== 'completed');
  return headMoved || newerPending;
}

/** For a past run: whether a newer push run started before attempt 1 ended,
 *  which is what `supersededNow` would have seen when attempt 1 completed. */
function supersededThen(context: Context, run: RunJson, attemptOne: RunJson): boolean {
  const window = `${run.created_at}..${attemptOne.updated_at}`;
  const started = listRuns(context, `actions/workflows/${run.workflow_id}/runs?branch=main&event=push&per_page=10&created=${window}`);
  return started.some((other) => other.id !== run.id);
}

/** Refuses anything but a push run of Build & Test on main. */
export function assertMainPushRun(run: RunJson): void {
  const isMainPush = run.event === 'push' && run.head_branch === 'main' && run.path === BUILD_WORKFLOW_PATH;
  if (!isMainPush) {
    throw new Error(`Run ${run.id} is a ${run.event} run of ${run.path} on ${run.head_branch}; only push runs of ${BUILD_WORKFLOW_PATH} on main are handled`);
  }
}

/** Waits for the attempt after `attempt` to complete. A failed poll is
 *  retried on the next tick. */
export async function waitForNextAttempt(context: Context, runId: number, attempt: number): Promise<void> {
  const deadline = context.now() + ATTEMPT_WAIT_MINUTES * 60 * 1000;
  while (context.now() < deadline) {
    await context.sleep(POLL_MS);
    try {
      const run = getRun(context, runId);
      if (run.run_attempt > attempt && run.status === 'completed') return;
    } catch (error) {
      console.warn(`Polling run ${runId} failed, retrying: ${errorText(error)}`);
    }
  }
  throw new Error(`Attempt ${attempt + 1} of run ${runId} did not complete within ${ATTEMPT_WAIT_MINUTES} minutes`);
}

function writeBody(context: Context, name: string, body: string): string {
  const bodyFile = join(context.tempDir(), name);
  writeFileSync(bodyFile, body);
  return bodyFile;
}

/** A flake whose issue is open gets a comment there, whoever filed it, and
 *  keeps its title. Everything else opens or updates its issue by prefix. */
function fileIssue(context: Context, action: IssueAction, index: number): string {
  const bodyFile = writeBody(context, `issue-${index}.md`, action.body);
  const commentsOnly = action.kind === 'file-flake' && action.existing !== undefined;
  if (commentsOnly) return context.gh(['issue', 'comment', String(action.existing), '--body-file', bodyFile]).trim();
  return openOrUpdateIssue(context.gh, { prefix: action.prefix, title: action.title, label: ISSUE_LABEL, bodyFile });
}

function closeRed(context: Context, body: string): string {
  const closed = closeOpenIssue(context.gh, RED_PREFIX, writeBody(context, 'close-red.md', body));
  if (closed === undefined) return 'no open issue to close';
  return `closed #${closed}`;
}

/** Carries out every action but the rerun, which `handleAttempt` runs. */
function applyFilings(context: Context, plan: Plan): void {
  plan.actions.forEach((action, index) => {
    if (action.kind === 'close-red') console.log(closeRed(context, action.body));
    else if (action.kind !== 'rerun') console.log(fileIssue(context, action, index));
  });
}

interface Planned {
  current: AttemptReport;
  plan: Plan;
}

function planFor(context: Context, runId: number, attempt: number, superseded: boolean): Planned {
  const current = collectAttempt(context, runId, attempt);
  const previous = attempt === 2 ? collectAttempt(context, runId, 1) : undefined;
  const issues = openIssues(context, [...(previous?.failures ?? []), ...current.failures]);
  return { current, plan: decide({ current, previous, openIssues: issues, superseded }) };
}

function plansRerun(plan: Plan): boolean {
  return plan.actions.some((action) => action.kind === 'rerun');
}

/** Classifies one attempt and acts on it. A rerun waits for the next attempt
 *  and acts on that too, because a rerun started with the workflow token does
 *  not start this workflow again when it completes. */
export async function handleAttempt(context: Context, runId: number, attempt: number): Promise<void> {
  const run = getRun(context, runId);
  assertMainPushRun(run);
  const superseded = attempt === 1 && supersededNow(context, run);
  const first = planFor(context, runId, attempt, superseded);
  context.log(describePlan(first.current, first.plan));
  if (!plansRerun(first.plan)) {
    applyFilings(context, first.plan);
    return;
  }
  context.gh(['run', 'rerun', String(runId), '--failed', '--repo', context.repo]);
  console.log(`Reran the failed jobs of run ${runId}; waiting for attempt ${attempt + 1}.`);
  await waitForNextAttempt(context, runId, attempt);
  const next = planFor(context, runId, attempt + 1, false);
  context.log(describePlan(next.current, next.plan));
  if (plansRerun(next.plan)) throw new Error('A second rerun was planned; refusing it');
  applyFilings(context, next.plan);
}

/** Prints the plan for every attempt of a past run, changing nothing. */
export function dryRun(context: Context, runId: number, attempt: number | undefined): void {
  const run = getRun(context, runId);
  const superseded = supersededThen(context, run, getRun(context, runId, 1));
  const first = attempt ?? 1;
  const last = attempt ?? run.run_attempt;
  context.log('Dry run: nothing is rerun or filed.');
  for (let current = first; current <= last; current += 1) {
    const planned = planFor(context, runId, current, current === 1 && superseded);
    context.log(describePlan(planned.current, planned.plan));
  }
}

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return undefined;
}

function packageDirs(root: string): string[] {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages).map((name) => `packages/${name}`);
}

function repoPath(dir: string, file: string): string {
  if (dir === '') return file;
  return `${dir}/${file}`;
}

/** `bun test --cwd packages/<name>` prints paths relative to the package, so
 *  a path is placed in the one directory of the checkout that holds it. */
export function checkoutResolver(root: string): FileResolver {
  const dirs = ['', ...packageDirs(root)];
  return (file) => {
    const holders = dirs.filter((dir) => existsSync(join(root, dir, file)));
    if (holders.length !== 1) return file;
    return repoPath(holders[0] ?? '', file);
  };
}

function logToConsoleAndSummary(text: string): void {
  console.log(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n\n`);
}

function defaultContext(repo: string): Context {
  let dir: string | undefined;
  return {
    gh: largeGh(),
    repo,
    log: logToConsoleAndSummary,
    sleep: (ms) => sleep(ms).then(() => undefined),
    now: () => Date.now(),
    resolveFile: checkoutResolver(REPO_ROOT),
    tempDir: () => (dir ??= mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'main-failure-'))),
  };
}

if (import.meta.main) {
  const runId = positive(process.env.RUN_ID);
  const repo = process.env.GITHUB_REPOSITORY;
  if (runId === undefined || !repo) {
    console.error('usage: RUN_ID=<run id> GITHUB_REPOSITORY=<owner/repo> [RUN_ATTEMPT=<n>] [DRY_RUN=true] bun scripts/ci/main-failure.ts');
    process.exit(2);
  }
  const context = defaultContext(repo);
  const attempt = positive(process.env.RUN_ATTEMPT);
  if (process.env.DRY_RUN !== 'false') {
    dryRun(context, runId, attempt);
  } else {
    await handleAttempt(context, runId, attempt ?? getRun(context, runId).run_attempt);
  }
}
