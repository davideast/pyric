#!/usr/bin/env bun
// Reverts the merge that turned main red. `.github/workflows/auto-revert.yml`
// runs it when a push run of a watched workflow on main fails:
//
//   RUN_ID=<id> RUN_ATTEMPT=<n> bun scripts/ci/auto-revert-github.ts
//
// It gathers the facts `auto-revert.ts` decides on, then carries out the
// verdict: rerun the failed jobs (attempt 1 of a workflow no other lane
// reruns), or push a revert branch, open a ready `revert: <title>` pull
// request and enable auto-merge (attempt 2). It never pushes to main.
//
// A pull request opened with the workflow token starts no workflows, so it
// then dispatches Build & Test on the revert branch, whose `CI / required`
// meets the ruleset's required check on the branch's head commit. A branch or
// pull request another job already made, or one a person closed, ends the
// job quietly.
//
// When the failing commit is a merge queue batch, the batch is bisected
// (`auto-revert-batch.ts`) and only the pull request the bisect names is
// reverted. `bun scripts/ci/auto-revert-github.ts bisect` handles a finished
// probe run: it reruns a first failure, and otherwise takes the next step
// for the batch the probe belongs to.
//
// Environment: RUN_ID and RUN_ATTEMPT (required), GITHUB_REPOSITORY,
// GH_TOKEN, DRY_RUN ('true' prints the verdict and changes nothing).
//
// `bun scripts/ci/auto-revert-github.ts report` files or comments on the one
// `Red on main: Auto revert` issue when the revert job fails. Environment:
// LANE_RUN_URL, FAILED_RUN_URL, FAILED_WORKFLOW, HEAD_SHA, GH_REPO.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOrUpdateIssue, type Gh } from './github-issues.ts';
import { collectAttempt, defaultContext, type Context } from '../lib/main-failure/github.ts';
import { readEntries, todayUtc } from '../lib/quarantine/entries.ts';
import { BRANCH_PREFIX, decide, isRevert, originalTitle, revertBody, revertCommands, type FailedRun, type Facts, type Verdict } from './auto-revert.ts';
import { batchMembers, bisectBatch, deleteProbes, parseBisectBranch, queuedPull, type BatchCommit, type BatchMember } from './auto-revert-batch.ts';
import { parseStagedPulls } from './merge-queue.ts';

/** What `gh pr create` prints when the repository does not let workflows
 *  open pull requests (Settings, Actions, General). */
const PR_CREATE_REFUSED = 'not permitted to create or approve pull requests';
/** What a second job sees when the first opened the pull request. */
const PR_EXISTS = /pull request for branch .* already exists/;
/** What a second job sees when the first pushed the branch. */
const PUSH_LOST_RACE = /\[rejected\]|fetch first|non-fast-forward|already exists/;
/** Started on the revert branch, since its pull request starts no workflows. */
const BUILD_WORKFLOW = 'build.yml';
const FAILURE_ISSUE = 'Red on main: Auto revert';

export interface Io {
  gh: Gh;
  git: (args: string[]) => string;
  /** Reads the failures of one attempt from its job logs. */
  failures: (runId: number, attempt: number) => FailedRun['failures'];
  log: (text: string) => void;
  writeFile: (name: string, text: string) => string;
  repo: string;
}

interface RunJson {
  name: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  workflow_id: number;
  html_url: string;
  /** The workflow file, such as `.github/workflows/build.yml`. */
  path?: string;
  actor?: { login?: string } | null;
}

const FAILED = new Set(['failure', 'timed_out']);

const BOT_ACTOR = 'github-actions[bot]';
const MERGE_QUEUE_LABEL = 'merge-queue';

function isBotMainDispatch(run: Pick<RunJson, 'event' | 'head_branch' | 'actor'>): boolean {
  return run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.actor?.login === BOT_ACTOR;
}

function isWatchedMainRun(run: Pick<RunJson, 'event' | 'head_branch' | 'actor'>): boolean {
  if (run.event === 'push' && run.head_branch === 'main') return true;
  return isBotMainDispatch(run);
}

interface CommitJson {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string };
}

interface PullJson {
  number: number;
  title: string;
  merge_commit_sha: string | null;
  head: { ref: string };
}

function api<T>(io: Io, path: string): T {
  return JSON.parse(io.gh(['api', `repos/${io.repo}/${path}`])) as T;
}

/** The pull request a commit merged. A merge queue commit names it in its
 *  trailer; a batch names several, and the bisect picks one of them. */
function mergedPull(io: Io, sha: string, message: string): FailedRun['pull'] {
  const staged = parseStagedPulls(message);
  if (staged.length === 1) return queuedPull(io, message);
  if (staged.length > 1) return undefined;
  const pulls = api<PullJson[]>(io, `commits/${sha}/pulls`);
  const pull = pulls.find((candidate) => candidate.merge_commit_sha === sha) ?? pulls[0];
  if (pull === undefined) return undefined;
  return { number: pull.number, title: pull.title, headRef: pull.head.ref };
}

function parentRun(io: Io, run: RunJson, parent: string | undefined): RunJson | undefined {
  if (parent === undefined) return undefined;
  const pushQuery = `actions/workflows/${run.workflow_id}/runs?branch=main&event=push&head_sha=${parent}&per_page=5`;
  const pushMatch = api<{ workflow_runs: RunJson[] }>(io, pushQuery).workflow_runs[0];
  if (pushMatch !== undefined) return pushMatch;
  // A merge performed by the Actions merge queue with the workflow token starts
  // main's workflows by bot dispatch rather than push.
  const dispatchQuery = `actions/workflows/${run.workflow_id}/runs?branch=main&event=workflow_dispatch&head_sha=${parent}&per_page=5`;
  return api<{ workflow_runs: RunJson[] }>(io, dispatchQuery).workflow_runs.find(isBotMainDispatch);
}

function superseded(io: Io, run: RunJson, runId: number): boolean {
  const head = api<{ commit: { sha: string } }>(io, 'branches/main').commit.sha;
  if (head !== run.head_sha) return true;
  const recentPush = api<{ workflow_runs: (RunJson & { id: number })[] }>(io, `actions/workflows/${run.workflow_id}/runs?branch=main&event=push&per_page=10`);
  if (recentPush.workflow_runs.some((other) => other.id !== runId && other.status !== 'completed')) return true;
  if (!isBotMainDispatch(run)) return false;
  const recentDispatch = api<{ workflow_runs: (RunJson & { id: number })[] }>(io, `actions/workflows/${run.workflow_id}/runs?branch=main&event=workflow_dispatch&per_page=10`);
  return recentDispatch.workflow_runs.some((other) => other.id !== runId && isBotMainDispatch(other) && other.status !== 'completed');
}

/** A revert pull request for the commit in any state, so one a person closed
 *  is not opened again. */
function existingRevert(io: Io, sha: string): Facts['existingRevert'] {
  const found = JSON.parse(io.gh([
    'pr', 'list', '--repo', io.repo, '--state', 'all', '--head', `${BRANCH_PREFIX}${sha}`, '--json', 'number,state',
  ])) as { number: number; state: string }[];
  return found[0];
}

export interface Gathered {
  facts: Facts;
  failedJobs: string[];
  parentRunUrl?: string;
  /** The failing commit and the workflow that failed on it. */
  commit: BatchCommit;
  workflowId: number;
  workflowFile: string;
  /** Set when the run being reverted is one pull request out of a batch. */
  batch?: { commit: string; size: number };
}

/** Reads the run, its commit and pull request, the parent's run and the
 *  quarantine. Returns a reason instead when the run is not a failed push
 *  run on main. */
export function gather(io: Io, runId: number, attempt: number, quarantine: Facts['quarantine'], today: string): Gathered | string {
  const run = api<RunJson>(io, `actions/runs/${runId}/attempts/${attempt}`);
  const failed = FAILED.has(run.conclusion ?? '');
  if (!isWatchedMainRun(run) || !failed) {
    return `attempt ${attempt} of run ${runId} is a ${run.event} run on ${run.head_branch} that ended ${run.conclusion ?? run.status}`;
  }
  const commit = api<CommitJson>(io, `commits/${run.head_sha}`);
  const parents = commit.parents.map((parent) => parent.sha);
  const parent = parentRun(io, run, parents[0]);
  const failures = io.failures(runId, attempt);
  const failedRun: FailedRun = {
    workflow: run.name, runId, attempt, url: run.html_url, headSha: run.head_sha, parents,
    message: commit.commit.message, pull: mergedPull(io, run.head_sha, commit.commit.message), failures,
  };
  const facts: Facts = {
    run: failedRun,
    parentConclusion: parent?.status === 'completed' ? parent.conclusion ?? undefined : undefined,
    superseded: attempt === 1 && superseded(io, run, runId),
    existingRevert: attempt === 2 ? existingRevert(io, run.head_sha) : undefined,
    quarantine,
    today,
  };
  return {
    facts, failedJobs: [...new Set(failures.map((failure) => failure.job))], parentRunUrl: parent?.html_url,
    commit: { sha: run.head_sha, parents, message: commit.commit.message },
    workflowId: run.workflow_id,
    workflowFile: (run.path ?? '').split('/').at(-1) ?? '',
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Opens the pull request. Returns undefined when another job opened it first. */
function openPullRequest(io: Io, gathered: Gathered, verdict: RevertVerdict): string | undefined {
  const body = io.writeFile('revert-body.md', revertBody({ run: gathered.facts.run, failedJobs: gathered.failedJobs, parentRunUrl: gathered.parentRunUrl, batch: gathered.batch }));
  try {
    return io.gh(['pr', 'create', '--repo', io.repo, '--base', 'main', '--head', verdict.branch, '--title', verdict.title, '--body-file', body]).trim();
  } catch (error) {
    const message = errorText(error);
    if (PR_EXISTS.test(message)) return undefined;
    if (!message.includes(PR_CREATE_REFUSED)) throw error;
    const compare = `https://github.com/${io.repo}/compare/main...${verdict.branch}?expand=1`;
    throw new Error(`The revert is pushed to ${verdict.branch}, but this repository does not let workflows open pull requests. Open it by hand: ${compare}`);
  }
}

/** Pushes the revert branch. Returns false when another job pushed it first. */
function pushBranch(io: Io, branch: string): boolean {
  try {
    io.git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (PUSH_LOST_RACE.test(errorText(error))) return false;
    throw error;
  }
}

type RevertVerdict = Extract<Verdict, { kind: 'revert' }>;

function quietly(io: Io, reason: string): Verdict {
  io.log(`Nothing to do: ${reason}.`);
  return { kind: 'skip', reason };
}

function revert(io: Io, gathered: Gathered, verdict: RevertVerdict): Verdict {
  const { run } = gathered.facts;
  const remote = io.git(['ls-remote', 'origin', `refs/heads/${verdict.branch}`]);
  if (remote.trim() !== '') return quietly(io, `${verdict.branch} already exists, so another job is reverting this commit`);
  io.git(['config', 'user.name', 'github-actions[bot]']);
  io.git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const [branch, revertCommit] = revertCommands(run, verdict);
  io.git(branch);
  try {
    io.git(revertCommit);
  } catch (error) {
    throw new Error(`Reverting ${run.headSha} does not apply cleanly to main; revert it by hand. ${errorText(error)}`);
  }
  if (!pushBranch(io, verdict.branch)) return quietly(io, `another job pushed ${verdict.branch} first`);
  const url = openPullRequest(io, gathered, verdict);
  if (url === undefined) return quietly(io, `another job opened the pull request for ${verdict.branch} first`);
  // A pull request opened with the workflow token starts no workflows, but a
  // dispatch does, and its `CI / required` lands on the branch's head commit.
  io.gh(['workflow', 'run', BUILD_WORKFLOW, '--repo', io.repo, '--ref', verdict.branch]);
  const prNumber = /\/pull\/(\d+)\s*$/.exec(url)?.[1];
  if (prNumber !== undefined) {
    try {
      io.gh(['api', '-X', 'POST', `repos/${io.repo}/issues/${prNumber}/labels`, '-f', `labels[]=${MERGE_QUEUE_LABEL}`]);
    } catch {
      // Best-effort if the merge-queue label has not been created yet.
    }
  }
  io.gh(['pr', 'merge', url, '--repo', io.repo, '--auto', '--merge']);
  io.log(`Opened ${url}, started ${BUILD_WORKFLOW} on ${verdict.branch}, labeled ${MERGE_QUEUE_LABEL}, and enabled auto-merge: ${verdict.title}`);
  return verdict;
}

export interface LaneFailure {
  laneRunUrl: string;
  failedRunUrl: string;
  workflow: string;
  headSha: string;
}

/** Files, or comments on, the one `Red on main: Auto revert` issue when the
 *  revert job fails, so a person reverts by hand. */
export function reportFailure(io: Pick<Io, 'gh' | 'writeFile' | 'repo'>, failure: LaneFailure): string {
  const body = [
    `The auto revert lane failed while reverting ${failure.headSha}, which turned ${failure.workflow} red on main.`,
    '',
    `- Lane run: ${failure.laneRunUrl}`,
    `- Failing run: ${failure.failedRunUrl}`,
    '',
    'Main stays red until someone reverts or fixes that commit by hand. The lane run says why it stopped.',
    '',
  ].join('\n');
  const bodyFile = io.writeFile('failure-body.md', body);
  return openOrUpdateIssue(io.gh, { prefix: FAILURE_ISSUE, title: FAILURE_ISSUE, label: 'flake', bodyFile });
}

/** The failing commit is a batch: takes the next bisect step, and once the
 *  bisect names a pull request reverts that one merge commit alone. */
function handleBatch(io: Io, gathered: Gathered, members: readonly BatchMember[], dryRun: boolean): Verdict {
  const batch = gathered.commit;
  const step = bisectBatch(io, { commit: batch, workflowId: gathered.workflowId, workflowFile: gathered.workflowFile }, members, dryRun);
  if (step.kind !== 'culprit') return { kind: 'bisect', step: step.kind, index: step.index };
  const member = members[step.index];
  if (member === undefined) throw new Error(`batch ${batch.sha} has no member ${step.index}`);
  const run: FailedRun = { ...gathered.facts.run, headSha: member.sha, parents: member.parents, message: member.message, pull: member.pull };
  if (isRevert(run)) return quietly(io, `${member.sha} is a revert; reverting it again is left to a person`);
  const existing = existingRevert(io, member.sha);
  if (existing !== undefined) return quietly(io, `revert pull request #${existing.number} already exists (${existing.state.toLowerCase()})`);
  const verdict: RevertVerdict = { kind: 'revert', title: `revert: ${originalTitle(run)}`, branch: `${BRANCH_PREFIX}${member.sha}`, mainline: true };
  const prefix = dryRun ? 'Dry run, would ' : '';
  io.log(`${prefix}revert ${member.sha}, pull request ${step.index + 1} of ${members.length} in batch ${batch.sha}, on ${verdict.branch}: ${verdict.title}`);
  if (dryRun) return verdict;
  const culprit: Gathered = { ...gathered, facts: { ...gathered.facts, run }, batch: { commit: batch.sha, size: members.length } };
  const outcome = revert(io, culprit, verdict);
  deleteProbes(io, batch.sha, gathered.workflowId);
  return outcome;
}

/** Decides on one attempt and carries out the verdict, unless `dryRun`. */
export function handle(io: Io, runId: number, attempt: number, dryRun: boolean, quarantine: Facts['quarantine'], today: string): Verdict {
  const gathered = gather(io, runId, attempt, quarantine, today);
  if (typeof gathered === 'string') {
    io.log(`Nothing to do: ${gathered}.`);
    return { kind: 'skip', reason: gathered };
  }
  const verdict = decide(gathered.facts);
  const prefix = dryRun ? 'Dry run, would ' : '';
  if (verdict.kind === 'skip') io.log(`Nothing to do: ${verdict.reason}.`);
  if (verdict.kind === 'rerun') io.log(`${prefix}rerun the failed jobs of run ${runId}; attempt 2 decides the revert.`);
  if (verdict.kind !== 'revert') {
    if (verdict.kind === 'rerun' && !dryRun) io.gh(['run', 'rerun', String(runId), '--failed', '--repo', io.repo]);
    return verdict;
  }
  const members = batchMembers(io, gathered.commit);
  if (members !== undefined) return handleBatch(io, gathered, members, dryRun);
  io.log(`${prefix}revert ${gathered.facts.run.headSha} on ${verdict.branch}: ${verdict.title}`);
  if (dryRun) return verdict;
  return revert(io, gathered, verdict);
}

/** A bisect probe finished. Its first failure is rerun; a pass or a second
 *  failure takes the next step for the batch the probe belongs to. */
export function handleProbe(io: Io, runId: number, attempt: number, dryRun: boolean, quarantine: Facts['quarantine'], today: string): Verdict {
  const run = api<RunJson>(io, `actions/runs/${runId}/attempts/${attempt}`);
  const target = parseBisectBranch(run.head_branch);
  const ownDispatch = run.event === 'workflow_dispatch' && run.actor?.login === BOT_ACTOR;
  if (target === undefined || !ownDispatch) return quietly(io, `run ${runId} on ${run.head_branch} is not a bisect probe`);
  const failed = FAILED.has(run.conclusion ?? '');
  if (failed && attempt === 1) {
    io.log(`${dryRun ? 'Dry run, would ' : ''}rerun the failed jobs of probe run ${runId}; attempt 2 counts.`);
    if (!dryRun) io.gh(['run', 'rerun', String(runId), '--failed', '--repo', io.repo]);
    return { kind: 'rerun' };
  }
  if (!failed && run.conclusion !== 'success') return quietly(io, `probe run ${runId} ended ${run.conclusion ?? run.status}, so the bisect stops here`);
  const query = `actions/workflows/${target.workflowId}/runs?branch=main&head_sha=${target.commit}&per_page=10`;
  const candidates = api<{ workflow_runs: (RunJson & { id: number; run_attempt: number })[] }>(io, query).workflow_runs;
  const batchRun = candidates.find((candidate) => isWatchedMainRun(candidate) && FAILED.has(candidate.conclusion ?? ''));
  if (batchRun === undefined) return quietly(io, `no failed run of the workflow on batch ${target.commit}`);
  return handle(io, batchRun.id, batchRun.run_attempt, dryRun, quarantine, today);
}

function spawn(command: string, args: string[]): string {
  const out = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${out.stderr || out.error?.message}`);
  return out.stdout;
}

function defaultIo(repo: string, context: Context): Io {
  let dir: string | undefined;
  return {
    gh: (args) => spawn('gh', args),
    git: (args) => spawn('git', args),
    failures: (runId, attempt) => collectAttempt(context, runId, attempt).failures,
    log: (text) => {
      console.log(text);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, `${text}\n\n`);
    },
    writeFile: (name, text) => {
      dir ??= mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'auto-revert-'));
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    repo,
  };
}

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function mainReport(): void {
  const repo = required('GITHUB_REPOSITORY');
  const url = reportFailure(defaultIo(repo, defaultContext(repo)), {
    laneRunUrl: required('LANE_RUN_URL'),
    failedRunUrl: required('FAILED_RUN_URL'),
    workflow: required('FAILED_WORKFLOW'),
    headSha: required('HEAD_SHA'),
  });
  console.log(url);
}

if (import.meta.main && process.argv[2] === 'report') {
  mainReport();
} else if (import.meta.main) {
  const act = process.argv[2] === 'bisect' ? handleProbe : handle;
  const runId = positive(process.env.RUN_ID);
  const attempt = positive(process.env.RUN_ATTEMPT);
  const repo = process.env.GITHUB_REPOSITORY;
  if (runId === undefined || attempt === undefined || !repo) {
    console.error('usage: RUN_ID=<run id> RUN_ATTEMPT=<n> GITHUB_REPOSITORY=<owner/repo> [DRY_RUN=true] bun scripts/ci/auto-revert-github.ts');
    process.exit(2);
  }
  const io = defaultIo(repo, defaultContext(repo));
  act(io, runId, attempt, process.env.DRY_RUN === 'true', readEntries(), todayUtc());
}
