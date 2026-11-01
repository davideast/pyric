// The GitHub side of the main failure lane: reads a run's attempts and job
// logs, finds the open issues, checks whether a newer push supersedes the
// run, reruns its failed jobs, waits for the rerun, and files the plan.
// Everything goes through an injectable `gh`, so tests drive it with a fake.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeOpenIssue, openOrUpdateIssue, type Gh } from '../../ci/github-issues.ts';
import { FAILED, MAX_FLAKE_ISSUES, decide, type AttemptReport, type IssueAction, type OpenIssue, type Plan } from './decide.ts';
import { FLAKE_PREFIX, RED_PREFIX, UNCONFIRMED_PREFIX, describePlan, testFilePath } from './issue-text.ts';
import { checkoutResolver, namedFailedJobs, parseFailures, type Failure, type FileResolver } from './parse-log.ts';

const ISSUE_LABEL = 'lane:velocity';
/** The only workflow this lane reruns. */
const BUILD_WORKFLOW_PATH = '.github/workflows/build.yml';
/** How long the rerun job waits for attempt 2. The job's timeout is longer. */
export const ATTEMPT_WAIT_MINUTES = 80;
const POLL_MS = 30_000;
const REPO_ROOT = resolve(import.meta.dir, '../../..');

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

export function getRun(context: Context, runId: number, attempt?: number): RunJson {
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

/** This lane's open issues, and any open issue that names the repository
 *  path of a test file in `failures`. `decide` checks the path again on a
 *  word boundary, since search matches loosely. */
function openIssues(context: Context, failures: Failure[]): OpenIssue[] {
  const prefixes = [FLAKE_PREFIX, RED_PREFIX, UNCONFIRMED_PREFIX].map((prefix) => `"${prefix.replace(/: $/, '')}" in:title`);
  const paths = [...new Set(failures.map(testFilePath).filter((path) => path !== undefined))].slice(0, MAX_FLAKE_ISSUES);
  const queries = [...prefixes, ...paths.map((path) => `"${path}" in:title,body`)];
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

function closeStanding(context: Context, prefix: string, body: string, index: number): string {
  const closed = closeOpenIssue(context.gh, prefix, writeBody(context, `close-${index}.md`, body));
  if (closed === undefined) return `no open "${prefix.trim()}" issue to close`;
  return `closed #${closed}`;
}

/** Carries out every action but the rerun, which `handleAttempt` runs. */
function applyFilings(context: Context, plan: Plan): void {
  plan.actions.forEach((action, index) => {
    if (action.kind === 'close') console.log(closeStanding(context, action.prefix, action.body, index));
    else if (action.kind !== 'rerun') console.log(fileIssue(context, action, index));
  });
}

interface Planned {
  current: AttemptReport;
  previous?: AttemptReport;
  issues: OpenIssue[];
  plan: Plan;
}

function planFor(context: Context, runId: number, attempt: number, superseded: boolean): Planned {
  const current = collectAttempt(context, runId, attempt);
  const previous = attempt === 2 ? collectAttempt(context, runId, 1) : undefined;
  const issues = openIssues(context, [...(previous?.failures ?? []), ...current.failures]);
  return { current, previous, issues, plan: decide({ current, previous, openIssues: issues, superseded }) };
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
  // Reading the logs and issues takes time, so a push may have landed since
  // the first check. Check again right before the rerun joins the group.
  if (supersededNow(context, run)) {
    const late = decide({ current: first.current, previous: first.previous, openIssues: first.issues, superseded: true });
    context.log(describePlan(first.current, late));
    applyFilings(context, late);
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

function logToConsoleAndSummary(text: string): void {
  console.log(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n\n`);
}

export function defaultContext(repo: string): Context {
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
