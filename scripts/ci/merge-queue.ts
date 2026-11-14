// Pure FIFO + fastlane merge queue decision engine for personal GitHub
// repositories where native `merge_group` is unavailable.
//
// `merge-queue-github.ts` gathers repository state and executes each step,
// serialized under `.github/workflows/merge-queue.yml`.

import { BRANCH_PREFIX as AUTO_REVERT_PREFIX } from './auto-revert.ts';

export const QUEUE_LABEL = 'merge-queue';
export const STAGING_BRANCH = 'merge-queue/staging';
const REGISTER_GRACE_MS = 60_000;
const STAGING_COMMIT_RE = /^merge-queue: stage #(\d+) \(([0-9a-f]{7,40})\) onto ([0-9a-f]{7,40})$/m;

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

export interface StagedMeta {
  prNumber: number;
  headSha: string;
  baseSha: string;
}

export interface StagingRun {
  id: number;
  attempt: number;
  status: string;
  conclusion: string | null;
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
  nowMs: number;
}

export type DequeueReason =
  | 'cross-repository-pull-request'
  | 'pull-request-checks-failed'
  | 'merge-conflict'
  | 'staging-checks-failed'
  | 'staging-cancelled';

export type QueueAction =
  | { kind: 'idle'; reason: string }
  | { kind: 'clean-staging'; reason: string; cancelRunId?: number }
  | { kind: 'wait-pr-checks'; pull: QueuedPull; cancelRunId?: number; cleanStaging?: boolean }
  | { kind: 'stage'; pull: QueuedPull; baseSha: string; releaseProof: boolean; cancelRunId?: number }
  | { kind: 'dispatch-staging'; pull: QueuedPull; stagingSha: string; releaseProof: boolean }
  | { kind: 'wait-staging'; pull: QueuedPull; stagingSha: string; runUrl?: string; reason: string }
  | { kind: 'rerun-staging'; pull: QueuedPull; runId: number; runUrl: string }
  | { kind: 'merge'; pull: QueuedPull; baseSha: string; stagingSha: string; runUrl: string }
  | {
    kind: 'dequeue';
    pull: QueuedPull;
    reason: DequeueReason;
    runUrl?: string;
    failedJobs?: readonly string[];
    cleanStaging: boolean;
  };

export function formatStagingCommit(meta: StagedMeta): string {
  return `merge-queue: stage #${meta.prNumber} (${meta.headSha}) onto ${meta.baseSha}`;
}

export function parseStagingCommit(message: string): StagedMeta | undefined {
  const match = STAGING_COMMIT_RE.exec(message);
  if (!match) return undefined;
  return {
    prNumber: Number(match[1]),
    headSha: match[2]!,
    baseSha: match[3]!,
  };
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

function inFlightStagingRunId(staging: ActiveStaging | undefined): number | undefined {
  const run = staging?.buildRun;
  if (run !== undefined && run.status !== 'completed') return run.id;
  return undefined;
}

function matchesStagedHead(staging: ActiveStaging | undefined, pull: QueuedPull, mainSha: string): staging is ActiveStaging {
  const meta = staging?.meta;
  if (meta === undefined) return false;
  return meta.prNumber === pull.number && meta.headSha === pull.headSha && meta.baseSha === mainSha;
}

function isOwnedStaging(staging: ActiveStaging | undefined, prNumber: number): boolean {
  return staging?.meta?.prNumber === prNumber;
}

function decideActiveStaging(pull: QueuedPull, mainSha: string, staging: ActiveStaging, nowMs: number): QueueAction {
  const releaseProof = pull.labels.includes('ci-packaging');
  const run = staging.buildRun;
  if (run === undefined) {
    const withinGraceWindow = nowMs - staging.committedAtMs < REGISTER_GRACE_MS;
    if (withinGraceWindow) {
      return {
        kind: 'wait-staging',
        pull,
        stagingSha: staging.stagingSha,
        reason: 'waiting for dispatched Build & Test run to register',
      };
    }
    return { kind: 'dispatch-staging', pull, stagingSha: staging.stagingSha, releaseProof };
  }
  if (run.status !== 'completed') {
    return {
      kind: 'wait-staging',
      pull,
      stagingSha: staging.stagingSha,
      runUrl: run.url,
      reason: 'staging Build & Test is in progress',
    };
  }
  const passed = run.conclusion === 'success' && run.requiredCheckConclusion === 'success';
  if (passed) {
    return { kind: 'merge', pull, baseSha: mainSha, stagingSha: staging.stagingSha, runUrl: run.url };
  }
  const cancelled = run.conclusion === 'cancelled';
  if (cancelled) {
    if (run.attempt === 1) {
      return { kind: 'dispatch-staging', pull, stagingSha: staging.stagingSha, releaseProof };
    }
    return { kind: 'dequeue', pull, reason: 'staging-cancelled', runUrl: run.url, cleanStaging: true };
  }
  if (run.attempt === 1) {
    return { kind: 'rerun-staging', pull, runId: run.id, runUrl: run.url };
  }
  const action: Extract<QueueAction, { kind: 'dequeue' }> = {
    kind: 'dequeue',
    pull,
    reason: 'staging-checks-failed',
    runUrl: run.url,
    cleanStaging: true,
  };
  if (run.failedJobs.length > 0) action.failedJobs = run.failedJobs;
  return action;
}

export function decideQueueStep(facts: QueueFacts): QueueAction {
  const nonDraft = facts.candidates.filter((pull) => !pull.isDraft);
  for (const pull of nonDraft) {
    if (pull.headRepoFullName !== facts.repo) {
      return {
        kind: 'dequeue',
        pull,
        reason: 'cross-repository-pull-request',
        cleanStaging: isOwnedStaging(facts.activeStaging, pull.number),
      };
    }
    if (pull.prRequiredState === 'failure') {
      return {
        kind: 'dequeue',
        pull,
        reason: 'pull-request-checks-failed',
        cleanStaging: isOwnedStaging(facts.activeStaging, pull.number),
      };
    }
  }

  const ordered = [...nonDraft].sort(compareQueuedPulls);
  const ready = ordered.filter((pull) => pull.prRequiredState === 'success');
  if (ready.length === 0) {
    const pending = ordered[0];
    if (pending !== undefined) {
      const action: Extract<QueueAction, { kind: 'wait-pr-checks' }> = { kind: 'wait-pr-checks', pull: pending };
      if (facts.activeStaging !== undefined) {
        action.cleanStaging = true;
        const cancelRunId = inFlightStagingRunId(facts.activeStaging);
        if (cancelRunId !== undefined) action.cancelRunId = cancelRunId;
      }
      return action;
    }
    if (facts.activeStaging !== undefined) {
      const action: Extract<QueueAction, { kind: 'clean-staging' }> = {
        kind: 'clean-staging',
        reason: 'no ready pull requests remain',
      };
      const cancelRunId = inFlightStagingRunId(facts.activeStaging);
      if (cancelRunId !== undefined) action.cancelRunId = cancelRunId;
      return action;
    }
    return { kind: 'idle', reason: 'queue is empty' };
  }

  const head = ready[0]!;
  if (matchesStagedHead(facts.activeStaging, head, facts.mainSha)) {
    return decideActiveStaging(head, facts.mainSha, facts.activeStaging, facts.nowMs);
  }

  const stageAction: Extract<QueueAction, { kind: 'stage' }> = {
    kind: 'stage',
    pull: head,
    baseSha: facts.mainSha,
    releaseProof: head.labels.includes('ci-packaging'),
  };
  const cancelRunId = inFlightStagingRunId(facts.activeStaging);
  if (cancelRunId !== undefined) stageAction.cancelRunId = cancelRunId;
  return stageAction;
}

export function dequeueComment(action: Extract<QueueAction, { kind: 'dequeue' }>, mainSha: string): string {
  const shortMain = mainSha.slice(0, 9);
  const shortHead = action.pull.headSha.slice(0, 9);
  if (action.reason === 'cross-repository-pull-request') {
    return `Removed \`${QUEUE_LABEL}\`: fork pull requests cannot run on \`${STAGING_BRANCH}\`.`;
  }
  if (action.reason === 'pull-request-checks-failed') {
    return `Removed \`${QUEUE_LABEL}\`: \`CI / required\` failed on pull request head \`${shortHead}\`. Fix the failing check and re-apply \`${QUEUE_LABEL}\`.`;
  }
  if (action.reason === 'merge-conflict') {
    return `Removed \`${QUEUE_LABEL}\`: merging \`${shortHead}\` onto \`main\` (\`${shortMain}\`) produced a conflict. Merge or rebase \`main\`, wait for \`CI / required\`, and re-apply \`${QUEUE_LABEL}\`.`;
  }
  if (action.reason === 'staging-cancelled') {
    let runSuffix = '';
    if (action.runUrl) runSuffix = ` (${action.runUrl})`;
    return `Removed \`${QUEUE_LABEL}\`: the staged \`Build & Test\` run on \`${STAGING_BRANCH}\` was cancelled twice${runSuffix}. Re-apply \`${QUEUE_LABEL}\` when ready.`;
  }
  const lines = [
    `Removed \`${QUEUE_LABEL}\`: staged \`Build & Test\` failed after one rerun when merging \`${shortHead}\` onto \`main\` (\`${shortMain}\`).`,
  ];
  if (action.runUrl) lines.push(`- Staging run: ${action.runUrl}`);
  if (action.failedJobs && action.failedJobs.length > 0) {
    lines.push(`- Failing jobs: ${action.failedJobs.map((job) => `\`${job}\``).join(', ')}`);
  }
  lines.push('', `Fix the failure on this branch, wait for \`CI / required\`, and re-apply \`${QUEUE_LABEL}\`.`);
  return lines.join('\n');
}
