// Pure batching merge queue decision engine for personal GitHub repositories
// where native `merge_group` is unavailable.
//
// `merge-queue-github.ts` gathers repository state and executes each step,
// serialized under `.github/workflows/merge-queue.yml`.
//
// Every ready pull request is staged together: revert pull requests first (a
// batch that holds a revert holds only reverts), the rest first-in first-out,
// up to `MAX_BATCH`. One green staging run lands the whole batch by moving
// `main` to the staged commit itself. The engine keeps no state of its own;
// what it knows between passes is read from the tip commit of the staging
// branch (`StagedMeta`).
//
// A batch that fails its run and one rerun is split to find the culprit. The
// suspects are the failed batch. The first half is staged as a probe: if it
// passes it lands and the suspects become the rest, if it fails twice the
// suspects become the probe. A lone suspect is removed, on the evidence of a
// run and a rerun that failed on exactly `main` plus that pull request. That
// takes at most ceil(log2(n)) probes, each rerun at most once
// (`maxSearchRuns`). Pull requests outside the suspects are never removed and
// join the next batch.
//
// While a watched workflow is red on the head of `main`, a staging run proves
// nothing about a batch that does not repair it, so only the ready reverts
// are staged or landed, and nobody is removed for a failed run.

import { BRANCH_PREFIX as AUTO_REVERT_PREFIX } from './auto-revert.ts';

export const QUEUE_LABEL = 'merge-queue';
export const STAGING_BRANCH = 'merge-queue/staging';
/** Points at a staged commit whose move onto `main` was refused once. */
export const REFUSED_BRANCH = 'merge-queue/refused';
/** The most pull requests one staging run proves. */
export const MAX_BATCH = 8;
const REGISTER_GRACE_MS = 60_000;
const SHA = '[0-9a-f]{7,40}';
const BASE_TRAILER = new RegExp(`^Merge-Queue-Base: (${SHA})$`);
const PULL_TRAILER = new RegExp(`^Merge-Queue-Pull: #(\\d+) (${SHA})$`);
const SUSPECT_TRAILER = new RegExp(`^Merge-Queue-Suspect: #(\\d+) (${SHA})$`);
const FAILED_RUN_TRAILER = /^Merge-Queue-Failed-Run: (\S+)$/;
const FAILED_JOB_TRAILER = /^Merge-Queue-Failed-Job: (.+)$/;

export type CheckState = 'success' | 'failure' | 'pending';

export interface QueuedPull {
  number: number;
  title: string;
  isDraft: boolean;
  headRef: string;
  headSha: string;
  headRepoFullName: string;
  labels: readonly string[];
  labeledAt: string;
  /** Latest `CI / required` check-run state on `headSha` (which already checks deletion-guard on PRs). */
  prRequiredState: CheckState;
}

/** One pull request as the staging branch holds it. */
export interface StagedPull {
  number: number;
  headSha: string;
}

/** A culprit search in progress: `suspects`, merged in order onto the base
 *  the search started from, failed `failedRunUrl` and its rerun. */
export interface SearchState {
  suspects: readonly StagedPull[];
  failedRunUrl: string;
  failedJobs?: readonly string[];
}

/** What the tip commit of the staging branch records. */
export interface StagedMeta {
  baseSha: string;
  pulls: readonly StagedPull[];
  search?: SearchState;
}

export interface StagingRun {
  id: number;
  attempt: number;
  totalRunsForCommit?: number;
  status: string;
  conclusion: string | null;
  requiredCheckState?: CheckState;
  requiredCheckConclusion: string | null;
  url: string;
  failedJobs: readonly string[];
}

export interface ActiveStaging {
  stagingSha: string;
  committedAtMs: number;
  meta?: StagedMeta;
  buildRun?: StagingRun;
}

export interface QueueFacts {
  repo: string;
  mainSha: string;
  candidates: readonly QueuedPull[];
  activeStaging?: ActiveStaging;
  /** A watched workflow's run on `mainSha` failed, or is being rerun after a
   *  failure. */
  mainRed?: { workflow: string; runUrl: string };
  /** The staged commit whose move onto `main` was refused on an earlier pass. */
  refusedStagingSha?: string;
  nowMs: number;
}

export type DequeueReason =
  | 'cross-repository-pull-request'
  | 'pull-request-checks-failed'
  | 'already-on-main'
  | 'merge-conflict'
  | 'merge-refused'
  | 'staging-push-refused'
  | 'staging-checks-failed'
  | 'staging-cancelled';

export interface StageAction {
  kind: 'stage';
  pulls: readonly QueuedPull[];
  baseSha: string;
  releaseProof: boolean;
  cancelRunId?: number;
  search?: SearchState;
}

export interface LandAction {
  kind: 'land';
  pulls: readonly QueuedPull[];
  baseSha: string;
  stagingSha: string;
  runUrl: string;
  /** An earlier pass tried this landing and was refused; a second refusal
   *  removes the batch from the queue. */
  refusedBefore: boolean;
  /** Set while a culprit search goes on: the staging branch is kept after the
   *  landing so the next step can read the remaining suspects from it. */
  search?: SearchState;
}

export interface DequeueAction {
  kind: 'dequeue';
  pulls: readonly QueuedPull[];
  reason: DequeueReason;
  runUrl?: string;
  failedJobs?: readonly string[];
  mergeError?: string;
  /** The pull request was singled out by splitting a failed batch. */
  bySearch?: boolean;
  cleanStaging: boolean;
}

export type QueueAction =
  | { kind: 'idle'; reason: string }
  | { kind: 'clean-staging'; reason: string; cancelRunId?: number }
  | { kind: 'wait-pr-checks'; pull: QueuedPull; cancelRunId?: number; cleanStaging?: boolean }
  | { kind: 'hold-main-red'; workflow: string; runUrl: string }
  | StageAction
  | { kind: 'dispatch-staging'; pulls: readonly QueuedPull[]; stagingSha: string; releaseProof: boolean }
  | { kind: 'wait-staging'; pulls: readonly QueuedPull[]; stagingSha: string; runUrl?: string; reason: string }
  | { kind: 'rerun-staging'; pulls: readonly QueuedPull[]; runId: number; runUrl: string }
  | LandAction
  | DequeueAction;

/** The most staging runs (reruns included) a culprit search over a failed
 *  batch of `batchSize` starts before it removes one pull request. */
export function maxSearchRuns(batchSize: number): number {
  return 2 * Math.ceil(Math.log2(Math.max(batchSize, 1)));
}

/** The trailer block the tip commit of the staging branch ends with. */
export function formatStagingTrailers(meta: StagedMeta): string {
  const lines = [`Merge-Queue-Base: ${meta.baseSha}`];
  for (const pull of meta.pulls) lines.push(`Merge-Queue-Pull: #${pull.number} ${pull.headSha}`);
  if (meta.search !== undefined) {
    for (const pull of meta.search.suspects) lines.push(`Merge-Queue-Suspect: #${pull.number} ${pull.headSha}`);
    lines.push(`Merge-Queue-Failed-Run: ${meta.search.failedRunUrl}`);
    for (const job of meta.search.failedJobs ?? []) lines.push(`Merge-Queue-Failed-Job: ${job}`);
  }
  return lines.join('\n');
}

function trailerLines(message: string): string[] {
  const paragraphs = message.trimEnd().split(/\n\s*\n/);
  const last = paragraphs.at(-1);
  if (last === undefined) return [];
  return last.split('\n');
}

function trailerPulls(lines: readonly string[], pattern: RegExp): StagedPull[] {
  const pulls: StagedPull[] = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) pulls.push({ number: Number(match[1]), headSha: match[2]! });
  }
  return pulls;
}

/** The pull requests a queue commit merged, read from its last paragraph. */
export function parseStagedPulls(message: string): StagedPull[] {
  return trailerPulls(trailerLines(message), PULL_TRAILER);
}

export function parseStagingCommit(message: string): StagedMeta | undefined {
  const lines = trailerLines(message);
  let baseSha: string | undefined;
  let failedRunUrl: string | undefined;
  const failedJobs: string[] = [];
  for (const line of lines) {
    baseSha = BASE_TRAILER.exec(line)?.[1] ?? baseSha;
    failedRunUrl = FAILED_RUN_TRAILER.exec(line)?.[1] ?? failedRunUrl;
    const jobMatch = FAILED_JOB_TRAILER.exec(line);
    if (jobMatch !== null && jobMatch[1] !== undefined) failedJobs.push(jobMatch[1]);
  }
  const pulls = trailerPulls(lines, PULL_TRAILER);
  if (baseSha === undefined || pulls.length === 0) return undefined;
  const meta: StagedMeta = { baseSha, pulls };
  const suspects = trailerPulls(lines, SUSPECT_TRAILER);
  if (failedRunUrl !== undefined && suspects.length > 0) {
    const search: SearchState = { suspects, failedRunUrl };
    if (failedJobs.length > 0) search.failedJobs = failedJobs;
    meta.search = search;
  }
  return meta;
}

export function isFastlaneRevert(pull: Pick<QueuedPull, 'title' | 'headRef'>): boolean {
  const revertTitle = /^revert[:(\s"]/i.test(pull.title);
  const revertBranch = pull.headRef.startsWith(AUTO_REVERT_PREFIX);
  return revertTitle || revertBranch;
}

function compareQueuedPulls(left: QueuedPull, right: QueuedPull): number {
  const leftFast = isFastlaneRevert(left);
  const rightFast = isFastlaneRevert(right);
  if (leftFast !== rightFast) return leftFast ? -1 : 1;
  const byTime = left.labeledAt.localeCompare(right.labeledAt);
  if (byTime !== 0) return byTime;
  return left.number - right.number;
}

/** The next batch from the ready pull requests in queue order: the reverts
 *  alone when there are any, otherwise everything, up to the cap. */
function selectBatch(ready: readonly QueuedPull[]): QueuedPull[] {
  const reverts = ready.filter(isFastlaneRevert);
  const lane = reverts.length > 0 ? reverts : ready;
  return lane.slice(0, MAX_BATCH);
}

function inFlightStagingRunId(staging: ActiveStaging | undefined): number | undefined {
  const run = staging?.buildRun;
  if (run !== undefined && run.status !== 'completed') return run.id;
  return undefined;
}

/** The ready pull requests `staged` names, in its order, or undefined when
 *  one of them is no longer ready at the staged head. */
function resolveStaged(staged: readonly StagedPull[], ready: readonly QueuedPull[]): QueuedPull[] | undefined {
  const resolved: QueuedPull[] = [];
  for (const entry of staged) {
    const pull = ready.find((candidate) => candidate.number === entry.number && candidate.headSha === entry.headSha);
    if (pull === undefined) return undefined;
    resolved.push(pull);
  }
  return resolved;
}

/** A ready revert goes ahead of any normal pull request that is staged or
 *  suspected. */
function revertPreempts(ready: readonly QueuedPull[], held: readonly QueuedPull[]): boolean {
  return ready.some(isFastlaneRevert) && held.some((pull) => !isFastlaneRevert(pull));
}

function isStagedOrSuspected(staging: ActiveStaging | undefined, prNumber: number): boolean {
  const meta = staging?.meta;
  if (meta === undefined) return false;
  if (meta.pulls.some((pull) => pull.number === prNumber)) return true;
  const suspects = meta.search?.suspects;
  return suspects !== undefined && suspects.some((pull) => pull.number === prNumber);
}

function asStaged(pulls: readonly QueuedPull[]): StagedPull[] {
  return pulls.map((pull) => ({ number: pull.number, headSha: pull.headSha }));
}

function wantsReleaseProof(pulls: readonly QueuedPull[]): boolean {
  return pulls.some((pull) => pull.labels.includes('ci-packaging'));
}

/** The next step of a culprit search over `suspects`, which failed a run and
 *  its rerun on top of `baseSha`: remove a lone suspect, otherwise stage the
 *  first half as a probe. */
function searchStep(suspects: readonly QueuedPull[], baseSha: string, failed: Pick<StagingRun, 'url' | 'failedJobs'>, split: boolean): QueueAction {
  if (suspects.length === 1) {
    const action: DequeueAction = { kind: 'dequeue', pulls: suspects, reason: 'staging-checks-failed', runUrl: failed.url, cleanStaging: true };
    if (failed.failedJobs.length > 0) action.failedJobs = failed.failedJobs;
    if (split) action.bySearch = true;
    return action;
  }
  const probe = suspects.slice(0, Math.floor(suspects.length / 2));
  const search: SearchState = { suspects: asStaged(suspects), failedRunUrl: failed.url };
  if (failed.failedJobs.length > 0) search.failedJobs = failed.failedJobs;
  return {
    kind: 'stage',
    pulls: probe,
    baseSha,
    releaseProof: wantsReleaseProof(probe),
    search,
  };
}

function decideCompletedRun(pulls: readonly QueuedPull[], facts: QueueFacts, staging: ActiveStaging, run: StagingRun): QueueAction {
  const search = staging.meta?.search;
  const mainSha = facts.mainSha;
  if (run.conclusion === 'success') {
    if (run.requiredCheckConclusion === 'success') {
      const refusedBefore = facts.refusedStagingSha === staging.stagingSha;
      const land: LandAction = { kind: 'land', pulls, baseSha: mainSha, stagingSha: staging.stagingSha, runUrl: run.url, refusedBefore };
      if (search !== undefined) land.search = search;
      return land;
    }
    if (run.requiredCheckState === 'pending') {
      return { kind: 'wait-staging', pulls, stagingSha: staging.stagingSha, runUrl: run.url, reason: 'waiting for CI / required check run to settle' };
    }
    return searchStep(pulls, mainSha, { url: run.url, failedJobs: [] }, search !== undefined);
  }
  if (run.conclusion === 'cancelled') {
    const totalRuns = run.totalRunsForCommit ?? 1;
    if (run.attempt === 1 && totalRuns < 2) {
      return { kind: 'dispatch-staging', pulls, stagingSha: staging.stagingSha, releaseProof: wantsReleaseProof(pulls) };
    }
    return { kind: 'dequeue', pulls, reason: 'staging-cancelled', runUrl: run.url, cleanStaging: true };
  }
  if (run.attempt === 1) {
    return { kind: 'rerun-staging', pulls, runId: run.id, runUrl: run.url };
  }
  return searchStep(pulls, mainSha, run, search !== undefined);
}

function decideActiveStaging(pulls: readonly QueuedPull[], facts: QueueFacts, staging: ActiveStaging): QueueAction {
  const run = staging.buildRun;
  if (run === undefined) {
    const withinGraceWindow = facts.nowMs - staging.committedAtMs < REGISTER_GRACE_MS;
    if (withinGraceWindow) {
      return { kind: 'wait-staging', pulls, stagingSha: staging.stagingSha, reason: 'waiting for dispatched Build & Test run to register' };
    }
    return { kind: 'dispatch-staging', pulls, stagingSha: staging.stagingSha, releaseProof: wantsReleaseProof(pulls) };
  }
  if (run.status !== 'completed') {
    return { kind: 'wait-staging', pulls, stagingSha: staging.stagingSha, runUrl: run.url, reason: 'staging Build & Test is in progress' };
  }
  return decideCompletedRun(pulls, facts, staging, run);
}

/** The staged pull requests when the staging branch still stands for the
 *  queue as it is now: built on the current `main`, every staged and
 *  suspected pull request still ready at its staged head, and no revert
 *  waiting behind a normal pull request. */
function currentBatch(staging: ActiveStaging | undefined, ready: readonly QueuedPull[], mainSha: string): QueuedPull[] | undefined {
  const meta = staging?.meta;
  if (meta === undefined || meta.baseSha !== mainSha) return undefined;
  const pulls = resolveStaged(meta.pulls, ready);
  const suspects = resolveStaged(meta.search?.suspects ?? [], ready);
  if (pulls === undefined || suspects === undefined) return undefined;
  if (revertPreempts(ready, [...pulls, ...suspects])) return undefined;
  return pulls;
}

/** The staging branch is the commit `main` now points at: its batch landed.
 *  A culprit search goes on with the suspects that did not land. */
function decideAfterLanding(meta: StagedMeta, ready: readonly QueuedPull[], mainSha: string): QueueAction {
  const search = meta.search;
  if (search === undefined) return { kind: 'clean-staging', reason: 'the staged batch landed' };
  const landed = new Set(meta.pulls.map((pull) => pull.number));
  const remaining = resolveStaged(search.suspects.filter((pull) => !landed.has(pull.number)), ready);
  if (remaining === undefined || remaining.length === 0 || revertPreempts(ready, remaining)) {
    return { kind: 'clean-staging', reason: 'the culprit search was abandoned because the queue changed' };
  }
  return searchStep(remaining, mainSha, { url: search.failedRunUrl, failedJobs: search.failedJobs ?? [] }, true);
}

function decideWithoutReady(ordered: readonly QueuedPull[], staging: ActiveStaging | undefined): QueueAction {
  const cancelRunId = inFlightStagingRunId(staging);
  const pending = ordered[0];
  if (pending !== undefined) {
    const action: Extract<QueueAction, { kind: 'wait-pr-checks' }> = { kind: 'wait-pr-checks', pull: pending };
    if (staging !== undefined) action.cleanStaging = true;
    if (cancelRunId !== undefined) action.cancelRunId = cancelRunId;
    return action;
  }
  if (staging !== undefined) {
    const action: Extract<QueueAction, { kind: 'clean-staging' }> = { kind: 'clean-staging', reason: 'no ready pull requests remain' };
    if (cancelRunId !== undefined) action.cancelRunId = cancelRunId;
    return action;
  }
  return { kind: 'idle', reason: 'queue is empty' };
}

function samePullSet(left: readonly QueuedPull[], right: readonly QueuedPull[]): boolean {
  if (left.length !== right.length) return false;
  const numbers = new Set(left.map((pull) => pull.number));
  return right.every((pull) => numbers.has(pull.number));
}

function hasCurrentRevertBatch(
  staging: ActiveStaging,
  staged: readonly QueuedPull[],
  reverts: readonly QueuedPull[],
): boolean {
  if (staging.meta?.search !== undefined) return false;
  return samePullSet(staged, reverts);
}

/** While `main` is red, a staging run says nothing about a batch that does
 *  not repair it. Normal pull requests are neither staged nor landed: what
 *  is staged is left alone and goes on if `main` turns green at the same
 *  commit. The ready reverts are staged together and land if their run
 *  passes; if it fails twice nobody is blamed and the staged commit is kept,
 *  so nothing more runs until the set of ready reverts, or `main`, changes. */
function decideOnRedMain(facts: QueueFacts, red: NonNullable<QueueFacts['mainRed']>, ready: readonly QueuedPull[]): QueueAction {
  const staging = facts.activeStaging;
  const cancelRunId = inFlightStagingRunId(staging);
  const hold: QueueAction = { kind: 'hold-main-red', workflow: red.workflow, runUrl: red.runUrl };
  const reverts = ready.filter(isFastlaneRevert).slice(0, MAX_BATCH);
  if (reverts.length === 0) return hold;
  const staged = currentBatch(staging, ready, facts.mainSha);
  if (staging === undefined || staged === undefined || !hasCurrentRevertBatch(staging, staged, reverts)) {
    const stage: StageAction = { kind: 'stage', pulls: reverts, baseSha: facts.mainSha, releaseProof: wantsReleaseProof(reverts) };
    if (cancelRunId !== undefined) stage.cancelRunId = cancelRunId;
    return stage;
  }
  const action = decideActiveStaging(staged, facts, staging);
  const blames = action.kind === 'stage' || (action.kind === 'dequeue' && action.reason === 'staging-checks-failed');
  return blames ? hold : action;
}

function ineligible(pull: QueuedPull, repo: string): DequeueReason | undefined {
  if (pull.headRepoFullName !== repo) return 'cross-repository-pull-request';
  if (pull.prRequiredState === 'failure') return 'pull-request-checks-failed';
  return undefined;
}

export function decideQueueStep(facts: QueueFacts): QueueAction {
  const staging = facts.activeStaging;
  const nonDraft = facts.candidates.filter((pull) => !pull.isDraft);
  for (const pull of nonDraft) {
    const reason = ineligible(pull, facts.repo);
    if (reason !== undefined) {
      return { kind: 'dequeue', pulls: [pull], reason, cleanStaging: isStagedOrSuspected(staging, pull.number) };
    }
  }

  const ordered = [...nonDraft].sort(compareQueuedPulls);
  const ready = ordered.filter((pull) => pull.prRequiredState === 'success');
  if (ready.length === 0) return decideWithoutReady(ordered, staging);

  if (facts.mainRed !== undefined) return decideOnRedMain(facts, facts.mainRed, ready);
  if (staging?.meta !== undefined && staging.stagingSha === facts.mainSha) {
    return decideAfterLanding(staging.meta, ready, facts.mainSha);
  }
  const staged = currentBatch(staging, ready, facts.mainSha);
  if (staged !== undefined && staging !== undefined) {
    return decideActiveStaging(staged, facts, staging);
  }

  const batch = selectBatch(ready);
  const stage: StageAction = { kind: 'stage', pulls: batch, baseSha: facts.mainSha, releaseProof: wantsReleaseProof(batch) };
  const cancelRunId = inFlightStagingRunId(staging);
  if (cancelRunId !== undefined) stage.cancelRunId = cancelRunId;
  return stage;
}

function stagingFailureComment(action: DequeueAction, shortHead: string, shortMain: string): string {
  const lines = [
    `Removed \`${QUEUE_LABEL}\`: staged \`Build & Test\` failed after one rerun with \`${shortHead}\` merged onto \`main\` (\`${shortMain}\`).`,
  ];
  if (action.runUrl) lines.push(`- Staging run: ${action.runUrl}`);
  if (action.failedJobs && action.failedJobs.length > 0) {
    lines.push(`- Failing jobs: ${action.failedJobs.map((job) => `\`${job}\``).join(', ')}`);
  }
  if (action.bySearch) {
    lines.push('- Found by splitting a failed batch: the pull requests staged ahead of this one passed without it.');
  }
  lines.push('', `Fix the failure on this branch, wait for \`CI / required\`, and re-apply \`${QUEUE_LABEL}\`.`);
  return lines.join('\n');
}

export function dequeueComment(action: DequeueAction, pull: QueuedPull, mainSha: string): string {
  const shortMain = mainSha.slice(0, 9);
  const shortHead = pull.headSha.slice(0, 9);
  if (action.reason === 'cross-repository-pull-request') {
    return `Removed \`${QUEUE_LABEL}\`: fork pull requests cannot run on \`${STAGING_BRANCH}\`.`;
  }
  if (action.reason === 'pull-request-checks-failed') {
    return `Removed \`${QUEUE_LABEL}\`: \`CI / required\` failed on pull request head \`${shortHead}\`. Fix the failing check and re-apply \`${QUEUE_LABEL}\`.`;
  }
  if (action.reason === 'already-on-main') {
    return `Removed \`${QUEUE_LABEL}\`: \`${shortHead}\` is already in \`main\` (\`${shortMain}\`), so there is nothing to merge.`;
  }
  if (action.reason === 'merge-conflict') {
    return `Removed \`${QUEUE_LABEL}\`: merging \`${shortHead}\` onto \`main\` (\`${shortMain}\`) and the pull requests queued ahead of it produced a conflict. Merge or rebase \`main\`, wait for \`CI / required\`, and re-apply \`${QUEUE_LABEL}\`.`;
  }
  if (action.reason === 'merge-refused') {
    let detailSuffix = '';
    if (action.mergeError) detailSuffix = ` (${action.mergeError})`;
    return `Removed \`${QUEUE_LABEL}\`: GitHub refused moving \`main\` (\`${shortMain}\`) to the staged commit that holds \`${shortHead}\` after staging passed${detailSuffix}. Resolve the branch or ruleset requirement and re-apply \`${QUEUE_LABEL}\`.`;
  }
  if (action.reason === 'staging-push-refused') {
    let detailSuffix = '';
    if (action.mergeError) detailSuffix = ` (${action.mergeError})`;
    return `Removed \`${QUEUE_LABEL}\`: GitHub refused the push to \`${STAGING_BRANCH}\` of a commit that merges \`${shortHead}\`${detailSuffix}. The queue's token may not push changes to workflow files; merge this pull request by hand, or give the queue a token that may.`;
  }
  if (action.reason === 'staging-cancelled') {
    let runSuffix = '';
    if (action.runUrl) runSuffix = ` (${action.runUrl})`;
    return `Removed \`${QUEUE_LABEL}\`: the staged \`Build & Test\` run on \`${STAGING_BRANCH}\` was cancelled twice${runSuffix}. Re-apply \`${QUEUE_LABEL}\` when ready.`;
  }
  return stagingFailureComment(action, shortHead, shortMain);
}

/** The comment a landed pull request gets: the commit `main` moved to and the
 *  staging run that proved it. */
export function landedComment(action: LandAction, pull: QueuedPull): string {
  const others = action.pulls.filter((other) => other.number !== pull.number).map((other) => `#${other.number}`);
  const lines = [
    `Landed on \`main\` as \`${action.stagingSha}\`, the commit the merge queue staged and tested.`,
    `- Staging run that proved it: ${action.runUrl}`,
  ];
  if (others.length > 0) lines.push(`- Staged and landed together with: ${others.join(', ')}`);
  return lines.join('\n');
}
