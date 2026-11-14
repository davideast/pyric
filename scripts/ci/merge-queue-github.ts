#!/usr/bin/env bun
// GitHub Actions merge queue runner for personal repositories where native
// `merge_group` is unavailable. `.github/workflows/merge-queue.yml` runs it
// under a single non-cancelling concurrency group (`merge-queue`).
//
// Add the `merge-queue` label to an open pull request targeting `main` to
// enqueue it. Each pass gathers repository state (`merge-queue-facts.ts`),
// asks `merge-queue.ts` for the next pure action, and executes transitions
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
  type StageAction,
  type StagedMeta,
} from './merge-queue.ts';
import {
  BUILD_WORKFLOW,
  SLOW_WORKFLOW,
  apiGet,
  gatherFacts,
  mainHeadSha,
  pullChangedPaths,
  type QueueIo,
} from './merge-queue-facts.ts';

export { gatherFacts, type QueueIo };

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

function isAncestor(io: QueueIo, candidate: string, descendant: string): boolean {
  try {
    io.git(['merge-base', '--is-ancestor', candidate, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Places any pull request whose head is a strict ancestor of another pull
 *  request in the same batch ahead of its descendant, while preserving queue
 *  order among unrelated pull requests so every merge in the chain is a real
 *  two-parent commit. */
function orderAncestorsFirst(io: QueueIo, pulls: readonly QueuedPull[]): QueuedPull[] {
  if (pulls.length <= 1) return [...pulls];
  const prereqs = pulls.map(() => new Set<number>());
  for (let left = 0; left < pulls.length; left++) {
    const a = pulls[left];
    if (a === undefined) continue;
    for (let right = 0; right < pulls.length; right++) {
      if (left === right) continue;
      const b = pulls[right];
      const rightDeps = prereqs[right];
      if (b === undefined || rightDeps === undefined || a.headSha === b.headSha) continue;
      if (isAncestor(io, a.headSha, b.headSha)) rightDeps.add(left);
    }
  }
  const ordered: QueuedPull[] = [];
  const picked = new Set<number>();
  while (ordered.length < pulls.length) {
    let chosen = -1;
    for (let index = 0; index < pulls.length; index++) {
      if (picked.has(index)) continue;
      const deps = prereqs[index];
      if (deps !== undefined && [...deps].every((dep) => picked.has(dep))) {
        chosen = index;
        break;
      }
    }
    if (chosen === -1) {
      for (const [index, pull] of pulls.entries()) {
        if (!picked.has(index)) ordered.push(pull);
      }
      break;
    }
    const next = pulls[chosen];
    picked.add(chosen);
    if (next !== undefined) ordered.push(next);
  }
  return ordered;
}

function appendExplicitMerge(io: QueueIo, head: string, pull: QueuedPull, message: string): void {
  const tree = io.git(['rev-parse', 'HEAD^{tree}']).trim();
  const commit = io.git(['commit-tree', tree, '-p', head, '-p', pull.headSha, '-m', message]).trim();
  io.git(['reset', '--soft', commit]);
}

/** Merges each pull request onto the checked-out base in order, placing
 *  stacked ancestors ahead of their descendants. Pull requests already in
 *  `main` or that conflict are removed from the queue and left out. */
function mergeChain(io: QueueIo, action: StageAction): { merged: QueuedPull[]; dequeued: DequeueAction[] } {
  const merged: QueuedPull[] = [];
  const dequeued: DequeueAction[] = [];
  const pending: QueuedPull[] = [];
  for (const pull of action.pulls) {
    if (isAncestor(io, pull.headSha, action.baseSha)) {
      const dequeue: DequeueAction = { kind: 'dequeue', pulls: [pull], reason: 'already-on-main', cleanStaging: false };
      executeDequeue(io, dequeue, action.baseSha);
      dequeued.push(dequeue);
    } else {
      pending.push(pull);
    }
  }
  const ordered = orderAncestorsFirst(io, pending);
  for (const pull of ordered) {
    const message = pullMergeMessage(pull, `Merge-Queue-Pull: #${pull.number} ${pull.headSha}`);
    if (merged.length > 0) {
      const head = io.git(['rev-parse', 'HEAD']).trim();
      if (isAncestor(io, pull.headSha, head)) {
        appendExplicitMerge(io, head, pull, message);
        merged.push(pull);
        continue;
      }
    }
    try {
      io.git(['merge', '--no-ff', '-m', message, pull.headSha]);
      merged.push(pull);
    } catch {
      ignoreError(() => io.git(['merge', '--abort']));
      const dequeue: DequeueAction = { kind: 'dequeue', pulls: [pull], reason: 'merge-conflict', cleanStaging: false };
      executeDequeue(io, dequeue, action.baseSha);
      dequeued.push(dequeue);
    }
  }
  return { merged, dequeued };
}

/** Writes the commit the staging branch will point at and returns its sha:
 *  the lone merge commit with the queue's trailers, or for a batch a commit
 *  of the chain's tree whose first parent is the base. */
function writeTip(io: QueueIo, merged: readonly QueuedPull[], meta: StagedMeta): string {
  const head = io.git(['rev-parse', 'HEAD']).trim();
  if (head === meta.baseSha) {
    throw new Error(`Refusing to stage ${meta.baseSha}: no merge commit was created on top of main.`);
  }
  const trailers = formatStagingTrailers(meta);
  const only = merged[0];
  if (merged.length === 1 && only !== undefined) {
    io.git(['commit', '--amend', '-m', pullMergeMessage(only, trailers)]);
    return io.git(['rev-parse', 'HEAD']).trim();
  }
  const tree = io.git(['rev-parse', 'HEAD^{tree}']).trim();
  return io.git(['commit-tree', tree, '-p', meta.baseSha, '-p', head, '-m', batchMessage(merged, trailers)]).trim();
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
  const matched = refusal.split('\n').find((line) => WORKFLOW_PUSH_REFUSAL.test(line));
  let mergeError = 'push refused';
  if (matched !== undefined) mergeError = matched.trim();
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
  const { merged, dequeued } = mergeChain(io, action);
  if (merged.length === 0) {
    deleteRemoteBranch(io, STAGING_BRANCH);
    return dequeued;
  }
  const meta: StagedMeta = { baseSha: action.baseSha, pulls: merged.map((pull) => ({ number: pull.number, headSha: pull.headSha })) };
  if (action.search !== undefined) meta.search = action.search;
  const tip = writeTip(io, merged, meta);
  try {
    io.git(['push', '--force', 'origin', `${tip}:refs/heads/${STAGING_BRANCH}`]);
  } catch (error) {
    return [...dequeued, handleStagingRefusal(io, action, merged, error)];
  }
  dispatchStagingBuild(io, action.releaseProof);
  let purpose = '';
  if (action.search !== undefined) purpose = ` as a probe of ${action.search.suspects.length} suspects`;
  io.log(`Staged ${numbersOf(merged)} onto main (${action.baseSha.slice(0, 9)}) as ${tip.slice(0, 9)}${purpose} and dispatched ${BUILD_WORKFLOW}.`);
  return [...dequeued, { ...action, pulls: merged }];
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
  let landedPaths: string[] = [];
  if (usingWorkflowToken) {
    landedPaths = action.pulls.flatMap((pull) => pullChangedPaths(io, pull.number));
  }
  if (!landingStillStands(io, action)) {
    io.log(`Did not land ${numbersOf(action.pulls)}: main or a pull request head moved since staging; will re-evaluate.`);
    deleteRemoteBranch(io, STAGING_BRANCH);
    return { outcomes: [action], advance: true };
  }
  try {
    io.git(['fetch', '--no-tags', 'origin', action.stagingSha]);
    // No force: the push is refused unless main is still an ancestor of the staged commit.
    io.git(['push', 'origin', `${action.stagingSha}:refs/heads/main`]);
  } catch (error) {
    if (landingStillStands(io, action)) return handleRefusal(io, action, errorText(error));
    io.log(`Could not land ${numbersOf(action.pulls)} (${errorText(error).split('\n')[0]}); main or a pull request head moved, will re-evaluate.`);
    deleteRemoteBranch(io, STAGING_BRANCH);
    return { outcomes: [action], advance: true };
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
