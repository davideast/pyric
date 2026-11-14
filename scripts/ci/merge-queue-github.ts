#!/usr/bin/env bun
// GitHub Actions merge queue runner for personal repositories where native
// `merge_group` is unavailable. `.github/workflows/merge-queue.yml` runs it
// under a single non-cancelling concurrency group (`merge-queue`).
//
// Add the `merge-queue` label to an open pull request targeting `main` to
// enqueue it. Each pass gathers repository state, asks `merge-queue.ts` for the next pure action, and executes transitions
// until the queue is either idle or waiting on an asynchronous check run.
//
// A batch is staged as a chain of merge commits, one per pull request, on top
// of `main`. A batch of two or more gets one more commit on top: the same
// tree, with `main` as its first parent and the chain as its second, so the
// commit that lands has the previous `main` as its first parent whatever the
// batch size. Landing pushes that commit to `main` without force, so `main`
// becomes the commit the staging run proved, or does not move at all.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUEUE_LABEL,
  REFUSED_BRANCH,
  STAGING_BRANCH,
  decideQueueStep,
  dequeueComment,
  formatStagingTrailers,
  landedComment,
  type DequeueAction,
  type LandAction,
  type QueueAction,
  type QueuedPull,
  parseStagingCommit,
  type ActiveStaging,
  type CheckState,
  type QueueFacts,
  type StageAction,
  type StagedMeta,
  type StagingRun,
} from './merge-queue.ts';

const BUILD_WORKFLOW = 'build.yml';
const SLOW_WORKFLOW = 'slow-scenarios.yml';
const REQUIRED_CHECK = 'CI / required';
/** The workflows whose failure on the head of `main` holds the queue: the
 *  ones the auto-revert lane watches. */
const WATCHED_ON_MAIN: ReadonlyArray<{ file: string; name: string }> = [
  { file: BUILD_WORKFLOW, name: 'Build & Test' },
  { file: SLOW_WORKFLOW, name: 'Slow app scenarios' },
];
const FAILED = new Set(['failure', 'timed_out']);

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
  head: { ref: string; sha: string; repo: { full_name: string } | null };
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

function apiGet<T>(io: QueueIo, path: string): T {
  return JSON.parse(io.gh(['api', `repos/${io.repo}/${path}`])) as T;
}

function mainHeadSha(io: QueueIo): string {
  return apiGet<{ commit: { sha: string } }>(io, 'branches/main').commit.sha;
}

function latestRequiredCheck(io: QueueIo, sha: string): { state: CheckState; conclusion: string | null } {
  const encoded = encodeURIComponent(REQUIRED_CHECK);
  const response = apiGet<{ check_runs: CheckRunItem[] }>(
    io,
    `commits/${sha}/check-runs?check_name=${encoded}&filter=latest`,
  );
  const run = response.check_runs.find((item) => item.app?.slug === 'github-actions') ?? response.check_runs[0];
  if (run === undefined || run.status !== 'completed') return { state: 'pending', conclusion: null };
  if (run.conclusion === 'success') return { state: 'success', conclusion: 'success' };
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
      number: item.number, title: item.title, isDraft: item.draft, headRef: item.head.ref, headSha: item.head.sha,
      headRepoFullName, labels: labelNames, labeledAt, prRequiredState: requiredCheck.state,
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

/** The commits the queue's own branches point at, by branch name. */
function queueBranches(io: QueueIo): Map<string, string> {
  const listing = io.git(['ls-remote', 'origin', `refs/heads/${STAGING_BRANCH}`, `refs/heads/${REFUSED_BRANCH}`]);
  const branches = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) branches.set(ref.replace('refs/heads/', ''), sha);
  }
  return branches;
}

function stagingBuildRun(io: QueueIo, stagingSha: string): StagingRun | undefined {
  const encodedBranch = encodeURIComponent(STAGING_BRANCH);
  const runs = apiGet<{ workflow_runs: WorkflowRunItem[] }>(
    io,
    `actions/workflows/${BUILD_WORKFLOW}/runs?branch=${encodedBranch}&head_sha=${stagingSha}&per_page=10`,
  );
  const latestRun = runs.workflow_runs[0];
  if (latestRun === undefined) return undefined;
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
  return {
    id: latestRun.id, attempt: latestRun.run_attempt, totalRunsForCommit: runs.workflow_runs.length,
    status: latestRun.status, conclusion: latestRun.conclusion, requiredCheckState,
    requiredCheckConclusion, url: latestRun.html_url, failedJobs,
  };
}

function gatherActiveStaging(io: QueueIo, stagingSha: string | undefined): ActiveStaging | undefined {
  if (stagingSha === undefined) return undefined;
  const commit = apiGet<{ commit: { message: string; committer: { date: string } } }>(io, `commits/${stagingSha}`);
  const meta = parseStagingCommit(commit.commit.message);
  const staging: ActiveStaging = { stagingSha, committedAtMs: Date.parse(commit.commit.committer.date) };
  if (meta !== undefined) staging.meta = meta;
  const buildRun = stagingBuildRun(io, stagingSha);
  if (buildRun !== undefined) staging.buildRun = buildRun;
  return staging;
}

/** A watched workflow whose latest run on the head of `main` failed, or is
 *  being rerun, which only happens after a failed attempt. A run still in
 *  its first attempt, or no run at all, does not hold the queue. */
function gatherMainRed(io: QueueIo, mainSha: string): QueueFacts['mainRed'] {
  for (const watched of WATCHED_ON_MAIN) {
    const runs = apiGet<{ workflow_runs: WorkflowRunItem[] }>(
      io,
      `actions/workflows/${watched.file}/runs?branch=main&head_sha=${mainSha}&per_page=5`,
    );
    const latest = runs.workflow_runs[0];
    if (latest === undefined) continue;
    const failed = latest.status === 'completed' && FAILED.has(latest.conclusion ?? '');
    const rerunning = latest.status !== 'completed' && latest.run_attempt > 1;
    if (failed || rerunning) return { workflow: watched.name, runUrl: latest.html_url };
  }
  return undefined;
}

export function gatherFacts(io: QueueIo): QueueFacts {
  const mainSha = mainHeadSha(io);
  const candidates = gatherQueuedPulls(io);
  const branches = queueBranches(io);
  const activeStaging = gatherActiveStaging(io, branches.get(STAGING_BRANCH));
  const mainRed = gatherMainRed(io, mainSha);
  const refusedStagingSha = branches.get(REFUSED_BRANCH);
  const facts: QueueFacts = { repo: io.repo, mainSha, candidates, nowMs: io.now() };
  if (activeStaging !== undefined) facts.activeStaging = activeStaging;
  if (mainRed !== undefined) facts.mainRed = mainRed;
  if (refusedStagingSha !== undefined) facts.refusedStagingSha = refusedStagingSha;
  return facts;
}

const SIMULATOR_WORKFLOW = 'simulator-parity.yml';
const MAX_TRANSITIONS = 5;
/** How much of a refused push's output goes to the log and the summary. */
const REFUSAL_TEXT_LIMIT = 4000;
/** What a push says when the token may not change workflow files. */
const WORKFLOW_PUSH_REFUSAL = /without `?workflows?`? permission|create or update workflow/i;
const WORKFLOW_DIR = '.github/workflows/';

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

export function needsSimulatorParity(paths: readonly string[]): boolean {
  return paths.some((path) => SIMULATOR_MATCHERS.some((glob) => glob.match(path)));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function numbersOf(pulls: readonly QueuedPull[]): string {
  return pulls.map((pull) => `#${pull.number}`).join(', ');
}

function ignoreError(fn: () => void): void {
  try { fn(); } catch { /* Best-effort cleanup when a branch, label, or workflow run is already gone. */ }
}

function removeQueueLabel(io: QueueIo, prNumber: number): void {
  ignoreError(() => io.gh(['api', '-X', 'DELETE', `repos/${io.repo}/issues/${prNumber}/labels/${QUEUE_LABEL}`]));
}

function deleteRemoteBranch(io: QueueIo, branch: string): void {
  ignoreError(() => io.git(['push', 'origin', '--delete', branch]));
}

function cancelRunIfPresent(io: QueueIo, runId: number | undefined): void {
  if (runId !== undefined) ignoreError(() => io.gh(['run', 'cancel', String(runId), '--repo', io.repo]));
}

function comment(io: QueueIo, prNumber: number, name: string, text: string): void {
  const file = io.writeFile(name, text);
  io.gh(['api', '-X', 'POST', `repos/${io.repo}/issues/${prNumber}/comments`, '-F', `body=@${file}`]);
}

function executeDequeue(io: QueueIo, action: DequeueAction, mainSha: string): void {
  for (const pull of action.pulls) {
    removeQueueLabel(io, pull.number);
    comment(io, pull.number, `dequeue-${pull.number}.md`, dequeueComment(action, pull, mainSha));
  }
  if (action.cleanStaging) deleteRemoteBranch(io, STAGING_BRANCH);
  io.log(`Dequeued ${numbersOf(action.pulls)} (${action.reason}).`);
}

function dispatchStagingBuild(io: QueueIo, releaseProof: boolean): void {
  io.gh(['workflow', 'run', BUILD_WORKFLOW, '--repo', io.repo, '--ref', STAGING_BRANCH, '-f', `release_proof=${String(releaseProof)}`]);
}

function pullMergeMessage(pull: QueuedPull, trailers: string): string {
  return `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n\n${trailers}`;
}

function batchMessage(pulls: readonly QueuedPull[], trailers: string): string {
  const titles = pulls.map((pull) => `- #${pull.number} ${pull.title}`).join('\n');
  return `Merge queue batch: ${numbersOf(pulls)}\n\n${titles}\n\n${trailers}`;
}

/** Merges each pull request onto the checked-out base in order. One that
 *  conflicts is removed from the queue and left out; the rest go on. */
function mergeChain(io: QueueIo, action: StageAction): { merged: QueuedPull[]; conflicted: DequeueAction[] } {
  const merged: QueuedPull[] = [];
  const conflicted: DequeueAction[] = [];
  for (const pull of action.pulls) {
    try {
      io.git(['merge', '--no-ff', '-m', pullMergeMessage(pull, `Merge-Queue-Pull: #${pull.number} ${pull.headSha}`), pull.headSha]);
      merged.push(pull);
    } catch {
      ignoreError(() => io.git(['merge', '--abort']));
      const dequeue: DequeueAction = { kind: 'dequeue', pulls: [pull], reason: 'merge-conflict', cleanStaging: false };
      executeDequeue(io, dequeue, action.baseSha);
      conflicted.push(dequeue);
    }
  }
  return { merged, conflicted };
}

/** Writes the commit the staging branch will point at and returns its sha:
 *  the lone merge commit with the queue's trailers, or for a batch a commit
 *  of the chain's tree whose first parent is the base. */
function writeTip(io: QueueIo, merged: readonly QueuedPull[], meta: StagedMeta): string {
  const trailers = formatStagingTrailers(meta);
  const only = merged[0];
  if (merged.length === 1 && only !== undefined) {
    io.git(['commit', '--amend', '-m', pullMergeMessage(only, trailers)]);
    return io.git(['rev-parse', 'HEAD']).trim();
  }
  const tree = io.git(['rev-parse', 'HEAD^{tree}']).trim();
  const chain = io.git(['rev-parse', 'HEAD']).trim();
  return io.git(['commit-tree', tree, '-p', meta.baseSha, '-p', chain, '-m', batchMessage(merged, trailers)]).trim();
}

/** The push of the staged commit was refused. When GitHub says the token may
 *  not change workflow files, the pull requests that change them are removed
 *  with the refusal and the rest are staged again; any other refusal is
 *  thrown, so the pass fails where it can be seen and nobody is removed. */
function handleStagingRefusal(io: QueueIo, action: StageAction, merged: readonly QueuedPull[], error: unknown): DequeueAction {
  const refusal = errorText(error);
  if (!WORKFLOW_PUSH_REFUSAL.test(refusal)) throw error;
  const touching = merged.filter((pull) => pullChangedPaths(io, pull.number).some((path) => path.startsWith(WORKFLOW_DIR)));
  if (touching.length === 0) throw error;
  const mergeError = refusal.split('\n').find((line) => WORKFLOW_PUSH_REFUSAL.test(line))?.trim() ?? 'push refused';
  const refused: DequeueAction = { kind: 'dequeue', pulls: touching, reason: 'staging-push-refused', mergeError, cleanStaging: false };
  executeDequeue(io, refused, action.baseSha);
  io.log(`GitHub refused the push of the staged commit for ${numbersOf(merged)}.\n\n\`\`\`\n${refusal.slice(0, REFUSAL_TEXT_LIMIT)}\n\`\`\``);
  return refused;
}

function executeStage(io: QueueIo, action: StageAction): QueueAction[] {
  cancelRunIfPresent(io, action.cancelRunId);
  io.git(['config', 'user.name', 'github-actions[bot]']);
  io.git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  io.git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', ...action.pulls.map((pull) => pull.headSha)]);
  io.git(['checkout', '--detach', action.baseSha]);
  const { merged, conflicted } = mergeChain(io, action);
  if (merged.length === 0) {
    deleteRemoteBranch(io, STAGING_BRANCH);
    return conflicted;
  }
  const meta: StagedMeta = { baseSha: action.baseSha, pulls: merged.map((pull) => ({ number: pull.number, headSha: pull.headSha })) };
  if (action.search !== undefined) meta.search = action.search;
  const tip = writeTip(io, merged, meta);
  try {
    io.git(['push', '--force', 'origin', `${tip}:refs/heads/${STAGING_BRANCH}`]);
  } catch (error) {
    return [...conflicted, handleStagingRefusal(io, action, merged, error)];
  }
  dispatchStagingBuild(io, action.releaseProof);
  const purpose = action.search === undefined ? '' : ` as a probe of ${action.search.suspects.length} suspects`;
  io.log(`Staged ${numbersOf(merged)} onto main (${action.baseSha.slice(0, 9)}) as ${tip.slice(0, 9)}${purpose} and dispatched ${BUILD_WORKFLOW}.`);
  return [...conflicted, { ...action, pulls: merged }];
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

/** One dispatch per landing: the head of `main` is the whole batch. */
function dispatchPostMergeMainWorkflows(io: QueueIo, landedPaths: readonly string[]): void {
  io.gh(['workflow', 'run', BUILD_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  io.gh(['workflow', 'run', SLOW_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  if (needsSimulatorParity(landedPaths)) {
    io.gh(['workflow', 'run', SIMULATOR_WORKFLOW, '--repo', io.repo, '--ref', 'main']);
  }
}

/** Whether `main` is still the batch's base and every pull request in it is
 *  still open at the staged head. */
function landingStillStands(io: QueueIo, action: LandAction): boolean {
  try {
    if (mainHeadSha(io) !== action.baseSha) return false;
    return action.pulls.every((pull) => {
      const current = apiGet<{ state: string; head: { sha: string } }>(io, `pulls/${pull.number}`);
      return current.state === 'open' && current.head.sha === pull.headSha;
    });
  } catch {
    return false;
  }
}

/** Throws unless the tree on `main` is the tree the staging run proved. */
function verifyLanded(io: QueueIo, action: LandAction): void {
  const mainSha = io.git(['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/)[0] ?? '';
  io.git(['fetch', '--no-tags', 'origin', mainSha]);
  const mainTree = io.git(['rev-parse', `${mainSha}^{tree}`]).trim();
  const provenTree = io.git(['rev-parse', `${action.stagingSha}^{tree}`]).trim();
  if (mainTree === '' || mainTree !== provenTree) {
    throw new Error(`After landing ${numbersOf(action.pulls)}, main is ${mainSha} with tree ${mainTree}, but the staging run (${action.runUrl}) proved ${action.stagingSha} with tree ${provenTree}.`);
  }
}

/** A push to `main` that was refused while nothing had moved. The first
 *  refusal of a staged commit changes nothing but a marker branch, and the
 *  next pass tries once more; the second removes the batch from the queue. */
function handleRefusal(io: QueueIo, action: LandAction, refusal: string): { outcomes: QueueAction[]; advance: boolean } {
  const shown = refusal.slice(0, REFUSAL_TEXT_LIMIT);
  if (!action.refusedBefore) {
    ignoreError(() => io.git(['push', '--force', 'origin', `${action.stagingSha}:refs/heads/${REFUSED_BRANCH}`]));
    io.log(`GitHub refused moving main to ${action.stagingSha} (${numbersOf(action.pulls)}). Nothing landed and nobody was removed from the queue; the next pass tries once more.\n\n\`\`\`\n${shown}\n\`\`\``);
    return { outcomes: [action], advance: false };
  }
  const mergeError = refusal.split('\n')[0] ?? 'push refused';
  const refused: DequeueAction = { kind: 'dequeue', pulls: action.pulls, reason: 'merge-refused', mergeError, cleanStaging: true };
  executeDequeue(io, refused, action.baseSha);
  deleteRemoteBranch(io, REFUSED_BRANCH);
  io.log(`GitHub refused moving main to ${action.stagingSha} a second time while main and the pull request heads were unchanged.\n\n\`\`\`\n${shown}\n\`\`\``);
  return { outcomes: [refused], advance: true };
}

function executeLand(
  io: QueueIo,
  action: LandAction,
  usingWorkflowToken: boolean,
): { outcomes: QueueAction[]; advance: boolean } {
  const landedPaths = usingWorkflowToken ? action.pulls.flatMap((pull) => pullChangedPaths(io, pull.number)) : [];
  if (!landingStillStands(io, action)) {
    io.log(`Did not land ${numbersOf(action.pulls)}: main or a pull request head moved since staging; will re-evaluate.`);
    deleteRemoteBranch(io, STAGING_BRANCH);
    return { outcomes: [action], advance: false };
  }
  try {
    io.git(['fetch', '--no-tags', 'origin', action.stagingSha]);
    // No force: the push is refused unless main is still an ancestor of the staged commit.
    io.git(['push', 'origin', `${action.stagingSha}:refs/heads/main`]);
  } catch (error) {
    if (landingStillStands(io, action)) return handleRefusal(io, action, errorText(error));
    io.log(`Could not land ${numbersOf(action.pulls)} (${errorText(error).split('\n')[0]}); main or a pull request head moved, will re-evaluate.`);
    deleteRemoteBranch(io, STAGING_BRANCH);
    return { outcomes: [action], advance: false };
  }
  verifyLanded(io, action);
  for (const pull of action.pulls) {
    comment(io, pull.number, `landed-${pull.number}.md`, landedComment(action, pull));
    removeQueueLabel(io, pull.number);
  }
  if (action.refusedBefore) deleteRemoteBranch(io, REFUSED_BRANCH);
  if (action.search === undefined) deleteRemoteBranch(io, STAGING_BRANCH);
  if (usingWorkflowToken) dispatchPostMergeMainWorkflows(io, landedPaths);
  io.log(`Landed ${numbersOf(action.pulls)} on main as ${action.stagingSha} after green staging run (${action.runUrl}).`);
  return { outcomes: [action], advance: true };
}

/** Carries out a step that ends the pass. */
function executeResting(io: QueueIo, action: QueueAction): void {
  if (action.kind === 'idle') io.log(`Merge queue idle: ${action.reason}.`);
  if (action.kind === 'hold-main-red') {
    io.log(`Merge queue held: ${action.workflow} is red on main (${action.runUrl}). Only revert pull requests are staged until it is green.`);
  }
  if (action.kind === 'clean-staging') {
    cancelRunIfPresent(io, action.cancelRunId);
    deleteRemoteBranch(io, STAGING_BRANCH);
    io.log(`Cleaned ${STAGING_BRANCH}: ${action.reason}.`);
  }
  if (action.kind === 'wait-pr-checks') {
    if (action.cleanStaging) {
      cancelRunIfPresent(io, action.cancelRunId);
      deleteRemoteBranch(io, STAGING_BRANCH);
    }
    io.log(`Waiting for pull request checks on #${action.pull.number} (${action.pull.headSha.slice(0, 9)}).`);
  }
  if (action.kind === 'wait-staging') io.log(`Waiting on ${STAGING_BRANCH} for ${numbersOf(action.pulls)}: ${action.reason}.`);
  if (action.kind === 'dispatch-staging') {
    dispatchStagingBuild(io, action.releaseProof);
    io.log(`Re-dispatched ${BUILD_WORKFLOW} on ${STAGING_BRANCH} for ${numbersOf(action.pulls)}.`);
  }
  if (action.kind === 'rerun-staging') {
    io.gh(['run', 'rerun', String(action.runId), '--failed', '--repo', io.repo]);
    io.log(`Reran failed jobs once on staging run ${action.runUrl} for ${numbersOf(action.pulls)}.`);
  }
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
    if (action.kind === 'dequeue') {
      executeDequeue(io, action, facts.mainSha);
      executed.push(action);
      continue;
    }
    if (action.kind === 'stage') {
      const outcomes = executeStage(io, action);
      executed.push(...outcomes);
      if (outcomes.at(-1)?.kind === 'stage') return executed;
      continue;
    }
    if (action.kind === 'land') {
      const result = executeLand(io, action, options.usingWorkflowToken);
      executed.push(...result.outcomes);
      if (!result.advance) return executed;
      continue;
    }
    executeResting(io, action);
    executed.push(action);
    return executed;
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
