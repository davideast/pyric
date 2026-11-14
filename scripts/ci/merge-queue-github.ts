#!/usr/bin/env bun
// GitHub Actions merge queue runner for personal repositories where native
// `merge_group` is unavailable. `.github/workflows/merge-queue.yml` runs it
// under a single non-cancelling concurrency group (`merge-queue`).
//
// Add the `merge-queue` label to an open pull request targeting `main` to
// enqueue it. Each pass gathers repository state, asks `merge-queue.ts` for
// the next pure action, and executes transitions until the queue is either
// idle or waiting on an asynchronous check run.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUEUE_LABEL,
  STAGING_BRANCH,
  decideQueueStep,
  dequeueComment,
  formatStagingCommit,
  parseStagingCommit,
  type ActiveStaging,
  type CheckState,
  type QueueAction,
  type QueueFacts,
  type QueuedPull,
  type StagingRun,
} from './merge-queue.ts';

const BUILD_WORKFLOW = 'build.yml';
const SLOW_WORKFLOW = 'slow-scenarios.yml';
const SIMULATOR_WORKFLOW = 'simulator-parity.yml';
const REQUIRED_CHECK = 'CI / required';
const MAX_TRANSITIONS = 5;

export const SIMULATOR_PARITY_GLOBS: readonly string[] = [
  'packages/pyric/src/firestore/sandbox/**',
  'packages/rules/src/grammar/**',
  'packages/rules/src/simulator/**',
  'packages/pyric/src/rules-tools/**',
  'packages/pyric/test/sandbox/firestore/simulator/**',
  'packages/pyric/test/rules/**',
  'packages/rules/test/simulator/**',
  'packages/pyric/test/rules-tools/**',
  '.github/workflows/simulator-parity.yml',
];

const SIMULATOR_MATCHERS = SIMULATOR_PARITY_GLOBS.map((glob) => new Bun.Glob(glob));

export interface QueueIo {
  repo: string;
  gh: (args: string[]) => string;
  git: (args: string[]) => string;
  log: (text: string) => void;
  writeFile: (name: string, text: string) => string;
  now: () => number;
}

interface PullApiItem {
  number: number;
  title: string;
  state?: string;
  draft: boolean;
  created_at: string;
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string } | null;
  };
  labels: Array<{ name: string }>;
}

interface IssueEventItem {
  event: string;
  created_at: string;
  label?: { name?: string } | null;
}

interface CheckRunItem {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
}

interface WorkflowRunItem {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export function needsSimulatorParity(paths: readonly string[]): boolean {
  return paths.some((path) => SIMULATOR_MATCHERS.some((glob) => glob.match(path)));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function apiGet<T>(io: QueueIo, path: string): T {
  return JSON.parse(io.gh(['api', `repos/${io.repo}/${path}`])) as T;
}

function latestRequiredCheck(io: QueueIo, sha: string): { state: CheckState; conclusion: string | null } {
  const encoded = encodeURIComponent(REQUIRED_CHECK);
  const response = apiGet<{ check_runs: CheckRunItem[] }>(
    io,
    `commits/${sha}/check-runs?check_name=${encoded}&filter=latest`,
  );
  const run = response.check_runs.find((item) => item.app?.slug === 'github-actions') ?? response.check_runs[0];
  if (run === undefined || run.status !== 'completed') {
    return { state: 'pending', conclusion: null };
  }
  if (run.conclusion === 'success') {
    return { state: 'success', conclusion: 'success' };
  }
  return { state: 'failure', conclusion: run.conclusion };
}

function latestLabeledTime(io: QueueIo, prNumber: number, fallbackCreatedAt: string): string {
  let labeledAt = fallbackCreatedAt;
  for (let page = 1; page <= 10; page++) {
    const suffix = page === 1 ? 'per_page=100' : `per_page=100&page=${page}`;
    const events = apiGet<IssueEventItem[]>(io, `issues/${prNumber}/events?${suffix}`);
    for (const item of events) {
      if (item.event === 'labeled' && item.label?.name === QUEUE_LABEL) {
        labeledAt = item.created_at;
      }
    }
    if (events.length < 100) break;
  }
  return labeledAt;
}

function gatherQueuedPulls(io: QueueIo): QueuedPull[] {
  const pulls = apiGet<PullApiItem[]>(io, 'pulls?state=open&base=main&per_page=100');
  const queued = pulls.filter((item) => item.labels.some((label) => label.name === QUEUE_LABEL));
  return queued.map((item) => {
    const labelNames = item.labels.map((label) => label.name);
    const headRepoFullName = item.head.repo?.full_name ?? '';
    const labeledAt = latestLabeledTime(io, item.number, item.created_at);
    const requiredCheck = latestRequiredCheck(io, item.head.sha);
    return {
      number: item.number,
      title: item.title,
      isDraft: item.draft,
      headRef: item.head.ref,
      headSha: item.head.sha,
      headRepoFullName,
      labels: labelNames,
      labeledAt,
      prRequiredState: requiredCheck.state,
    };
  });
}

function failedJobNames(io: QueueIo, runId: number, attempt: number): string[] {
  const response = apiGet<{ jobs: Array<{ name: string; conclusion: string | null }> }>(
    io,
    `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
  );
  return response.jobs
    .filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out')
    .map((job) => job.name);
}

function gatherActiveStaging(io: QueueIo): ActiveStaging | undefined {
  const remote = io.git(['ls-remote', 'origin', `refs/heads/${STAGING_BRANCH}`]).trim();
  if (!remote) return undefined;
  const stagingSha = remote.split(/\s+/)[0];
  if (!stagingSha) return undefined;

  const commit = apiGet<{ commit: { message: string; committer: { date: string } } }>(io, `commits/${stagingSha}`);
  const meta = parseStagingCommit(commit.commit.message);
  const committedAtMs = Date.parse(commit.commit.committer.date);
  const encodedBranch = encodeURIComponent(STAGING_BRANCH);
  const runs = apiGet<{ workflow_runs: WorkflowRunItem[] }>(
    io,
    `actions/workflows/${BUILD_WORKFLOW}/runs?branch=${encodedBranch}&head_sha=${stagingSha}&per_page=10`,
  );
  const latestRun = runs.workflow_runs[0];
  const staging: ActiveStaging = { stagingSha, committedAtMs };
  if (meta !== undefined) staging.meta = meta;
  if (latestRun !== undefined) {
    let requiredCheckState: CheckState = 'pending';
    let requiredCheckConclusion: string | null = null;
    let failedJobs: string[] = [];
    if (latestRun.status === 'completed') {
      const check = latestRequiredCheck(io, stagingSha);
      requiredCheckState = check.state;
      requiredCheckConclusion = check.conclusion;
      if (latestRun.conclusion !== 'success') {
        failedJobs = failedJobNames(io, latestRun.id, latestRun.run_attempt);
      }
    }
    const buildRun: StagingRun = {
      id: latestRun.id,
      attempt: latestRun.run_attempt,
      totalRunsForCommit: runs.workflow_runs.length,
      status: latestRun.status,
      conclusion: latestRun.conclusion,
      requiredCheckState,
      requiredCheckConclusion,
      url: latestRun.html_url,
      failedJobs,
    };
    staging.buildRun = buildRun;
  }
  return staging;
}

export function gatherFacts(io: QueueIo): QueueFacts {
  const mainSha = apiGet<{ commit: { sha: string } }>(io, 'branches/main').commit.sha;
  const candidates = gatherQueuedPulls(io);
  const activeStaging = gatherActiveStaging(io);
  const facts: QueueFacts = {
    repo: io.repo,
    mainSha,
    candidates,
    nowMs: io.now(),
  };
  if (activeStaging !== undefined) facts.activeStaging = activeStaging;
  return facts;
}

function ignoreError(fn: () => void): void {
  try {
    fn();
  } catch {
    // Best-effort cleanup when a branch, label, or workflow run is already gone.
  }
}

function removeQueueLabel(io: QueueIo, prNumber: number): void {
  ignoreError(() => {
    io.gh(['api', '-X', 'DELETE', `repos/${io.repo}/issues/${prNumber}/labels/${QUEUE_LABEL}`]);
  });
}

function deleteRemoteStaging(io: QueueIo): void {
  ignoreError(() => {
    io.git(['push', 'origin', '--delete', STAGING_BRANCH]);
  });
}

function cancelRunIfPresent(io: QueueIo, runId: number | undefined): void {
  if (runId === undefined) return;
  ignoreError(() => {
    io.gh(['run', 'cancel', String(runId), '--repo', io.repo]);
  });
}

function executeDequeue(io: QueueIo, action: Extract<QueueAction, { kind: 'dequeue' }>, mainSha: string): void {
  removeQueueLabel(io, action.pull.number);
  const commentFile = io.writeFile(`dequeue-${action.pull.number}.md`, dequeueComment(action, mainSha));
  io.gh(['api', '-X', 'POST', `repos/${io.repo}/issues/${action.pull.number}/comments`, '-F', `body=@${commentFile}`]);
  if (action.cleanStaging) deleteRemoteStaging(io);
}

function dispatchStagingBuild(io: QueueIo, releaseProof: boolean): void {
  io.gh([
    'workflow', 'run', BUILD_WORKFLOW,
    '--repo', io.repo,
    '--ref', STAGING_BRANCH,
    '-f', `release_proof=${String(releaseProof)}`,
  ]);
}

function executeStage(
  io: QueueIo,
  action: Extract<QueueAction, { kind: 'stage' }>,
): QueueAction {
  cancelRunIfPresent(io, action.cancelRunId);
  io.git(['config', 'user.name', 'github-actions[bot]']);
  io.git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  io.git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', action.pull.headSha]);
  io.git(['checkout', '--detach', action.baseSha]);
  const message = formatStagingCommit({
    prNumber: action.pull.number,
    headSha: action.pull.headSha,
    baseSha: action.baseSha,
  });
  try {
    io.git(['merge', '--no-ff', '-m', message, action.pull.headSha]);
  } catch {
    ignoreError(() => io.git(['merge', '--abort']));
    const conflictDequeue: Extract<QueueAction, { kind: 'dequeue' }> = {
      kind: 'dequeue',
      pull: action.pull,
      reason: 'merge-conflict',
      cleanStaging: true,
    };
    executeDequeue(io, conflictDequeue, action.baseSha);
    io.log(`Pull request #${action.pull.number} conflicted with main (${action.baseSha.slice(0, 9)}) and was dequeued.`);
    return conflictDequeue;
  }
  io.git(['push', '--force', 'origin', `HEAD:refs/heads/${STAGING_BRANCH}`]);
  dispatchStagingBuild(io, action.releaseProof);
  io.log(`Staged #${action.pull.number} (${action.pull.headSha.slice(0, 9)}) onto main (${action.baseSha.slice(0, 9)}) and dispatched ${BUILD_WORKFLOW}.`);
  return action;
}

function pullChangedPaths(io: QueueIo, prNumber: number): string[] {
  const filenames: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const suffix = page === 1 ? 'per_page=100' : `per_page=100&page=${page}`;
    const batch = apiGet<Array<{ filename: string }>>(io, `pulls/${prNumber}/files?${suffix}`);
    for (const item of batch) filenames.push(item.filename);
    if (batch.length < 100) break;
  }
  return filenames;
}

function dispatchPostMergeMainWorkflows(io: QueueIo, prPaths: readonly string[]): void {
  io.gh(['workflow', 'run', BUILD_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  io.gh(['workflow', 'run', SLOW_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  if (needsSimulatorParity(prPaths)) {
    io.gh(['workflow', 'run', SIMULATOR_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  }
}

function isPersistentMergeRefusal(io: QueueIo, action: Extract<QueueAction, { kind: 'merge' }>): boolean {
  try {
    const currentMain = apiGet<{ commit: { sha: string } }>(io, 'branches/main').commit.sha;
    if (currentMain !== action.baseSha) return false;
    const currentPr = apiGet<{ state: string; head: { sha: string } }>(io, `pulls/${action.pull.number}`);
    return currentPr.state === 'open' && currentPr.head.sha === action.pull.headSha;
  } catch {
    return false;
  }
}

function executeMerge(
  io: QueueIo,
  action: Extract<QueueAction, { kind: 'merge' }>,
  usingWorkflowToken: boolean,
): { outcome: QueueAction; advance: boolean } {
  let prPaths: string[] = [];
  if (usingWorkflowToken) {
    prPaths = pullChangedPaths(io, action.pull.number);
  }
  try {
    io.gh([
      'api', '-X', 'PUT', `repos/${io.repo}/pulls/${action.pull.number}/merge`,
      '-f', 'merge_method=merge',
      '-f', `sha=${action.pull.headSha}`,
    ]);
  } catch (error) {
    const detail = errorText(error).split('\n')[0] ?? 'merge refused';
    if (isPersistentMergeRefusal(io, action)) {
      const refusedDequeue: Extract<QueueAction, { kind: 'dequeue' }> = {
        kind: 'dequeue',
        pull: action.pull,
        reason: 'merge-refused',
        mergeError: detail,
        cleanStaging: true,
      };
      executeDequeue(io, refusedDequeue, action.baseSha);
      io.log(`Dequeued #${action.pull.number}: GitHub refused merge while main and head were unchanged (${detail}).`);
      return { outcome: refusedDequeue, advance: true };
    }
    io.log(`Could not merge #${action.pull.number} at ${action.pull.headSha.slice(0, 9)} (${detail}); main or head moved, will re-evaluate.`);
    deleteRemoteStaging(io);
    return { outcome: action, advance: false };
  }
  removeQueueLabel(io, action.pull.number);
  deleteRemoteStaging(io);
  if (usingWorkflowToken) {
    dispatchPostMergeMainWorkflows(io, prPaths);
  }
  io.log(`Merged #${action.pull.number} into main after green staging run (${action.runUrl}).`);
  return { outcome: action, advance: true };
}

export function runQueuePass(
  io: QueueIo,
  options: { dryRun: boolean; usingWorkflowToken: boolean },
): QueueAction[] {
  const executed: QueueAction[] = [];
  for (let step = 0; step < MAX_TRANSITIONS; step++) {
    const facts = gatherFacts(io);
    const action = decideQueueStep(facts);
    if (options.dryRun) {
      io.log(`Dry run: would execute ${action.kind}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'idle') {
      io.log(`Merge queue idle: ${action.reason}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'clean-staging') {
      cancelRunIfPresent(io, action.cancelRunId);
      deleteRemoteStaging(io);
      io.log(`Cleaned ${STAGING_BRANCH}: ${action.reason}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'wait-pr-checks') {
      if (action.cleanStaging) {
        cancelRunIfPresent(io, action.cancelRunId);
        deleteRemoteStaging(io);
      }
      io.log(`Waiting for pull request checks on #${action.pull.number} (${action.pull.headSha.slice(0, 9)}).`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'wait-staging') {
      io.log(`Waiting on ${STAGING_BRANCH} for #${action.pull.number}: ${action.reason}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'dispatch-staging') {
      dispatchStagingBuild(io, action.releaseProof);
      io.log(`Re-dispatched ${BUILD_WORKFLOW} on ${STAGING_BRANCH} for #${action.pull.number}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'rerun-staging') {
      io.gh(['run', 'rerun', String(action.runId), '--failed', '--repo', io.repo]);
      io.log(`Reran failed jobs once on staging run ${action.runUrl} for #${action.pull.number}.`);
      executed.push(action);
      return executed;
    }
    if (action.kind === 'dequeue') {
      executeDequeue(io, action, facts.mainSha);
      io.log(`Dequeued #${action.pull.number} (${action.reason}).`);
      executed.push(action);
      continue;
    }
    if (action.kind === 'stage') {
      const outcome = executeStage(io, action);
      executed.push(outcome);
      if (outcome.kind === 'dequeue') continue;
      return executed;
    }
    if (action.kind === 'merge') {
      const result = executeMerge(io, action, options.usingWorkflowToken);
      executed.push(result.outcome);
      if (!result.advance) return executed;
      continue;
    }
  }
  return executed;
}

function runCommand(command: string, args: string[]): string {
  const out = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${out.stderr || out.error?.message}`);
  return out.stdout;
}

function defaultIo(repo: string): QueueIo {
  let dir: string | undefined;
  return {
    repo,
    gh: (args) => runCommand('gh', args),
    git: (args) => runCommand('git', args),
    now: () => Date.now(),
    log: (text) => {
      console.log(text);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, `${text}\n\n`);
    },
    writeFile: (name, text) => {
      dir ??= mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'merge-queue-'));
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
  };
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY is required');
    process.exit(2);
  }
  const dryRun = process.env.DRY_RUN === 'true';
  const usingWorkflowToken = process.env.USING_WORKFLOW_TOKEN !== 'false';
  runQueuePass(defaultIo(repo), { dryRun, usingWorkflowToken });
}
