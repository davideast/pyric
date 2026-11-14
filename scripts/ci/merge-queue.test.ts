import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  QUEUE_LABEL,
  STAGING_BRANCH,
  decideQueueStep,
  dequeueComment,
  formatStagingCommit,
  parseStagingCommit,
  type QueueFacts,
  type QueuedPull,
  type StagingRun,
} from './merge-queue.ts';

const MAIN = '1'.repeat(40);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const STAGED = 'c'.repeat(40);
const NOW = Date.parse('2026-11-14T12:00:00Z');

function pull(overrides: Partial<QueuedPull> = {}): QueuedPull {
  return {
    number: 101,
    title: 'fix(rules): tighten path normalization',
    isDraft: false,
    headRef: 'fix/rules-path',
    headSha: HEAD_A,
    headRepoFullName: 'owner/repo',
    labels: [QUEUE_LABEL],
    labeledAt: '2026-11-14T11:50:00Z',
    prRequiredState: 'success',
    ...overrides,
  };
}

function stagingRun(overrides: Partial<StagingRun> = {}): StagingRun {
  return {
    id: 500,
    attempt: 1,
    totalRunsForCommit: 1,
    status: 'completed',
    conclusion: 'success',
    requiredCheckState: 'success',
    requiredCheckConclusion: 'success',
    url: 'https://github.com/owner/repo/actions/runs/500',
    failedJobs: [],
    ...overrides,
  };
}

function facts(overrides: Partial<QueueFacts> = {}): QueueFacts {
  return {
    repo: 'owner/repo',
    mainSha: MAIN,
    candidates: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe('staging commit metadata', () => {
  test('round-trips the pull request number, head sha, and base sha', () => {
    const message = formatStagingCommit({ prNumber: 101, headSha: HEAD_A, baseSha: MAIN });
    expect(parseStagingCommit(`${message}\n\nExtra git trailers`)).toEqual({
      prNumber: 101,
      headSha: HEAD_A,
      baseSha: MAIN,
    });
    expect(parseStagingCommit('Merge pull request #101 from owner/fix')).toBeUndefined();
  });
});

describe('merge queue decisions', () => {
  test('idles when empty and cleans an orphan staging branch when the queue drains', () => {
    expect(decideQueueStep(facts())).toEqual({ kind: 'idle', reason: 'queue is empty' });
    expect(decideQueueStep(facts({
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 10_000,
        meta: { prNumber: 99, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ status: 'in_progress', conclusion: null }),
      },
    }))).toEqual({
      kind: 'clean-staging',
      reason: 'no ready pull requests remain',
      cancelRunId: 500,
    });
  });

  test('orders ready pull requests FIFO by label time, with revert pull requests in the fastlane', () => {
    const older = pull({ number: 101, labeledAt: '2026-11-14T11:40:00Z' });
    const newer = pull({ number: 102, headSha: HEAD_B, labeledAt: '2026-11-14T11:45:00Z' });
    expect(decideQueueStep(facts({ candidates: [newer, older] }))).toEqual({
      kind: 'stage',
      pull: older,
      baseSha: MAIN,
      releaseProof: false,
    });

    const revertPr = pull({
      number: 103,
      title: 'revert: fix(cli): broken flag',
      headRef: `auto-revert/${MAIN}`,
      headSha: HEAD_B,
      labeledAt: '2026-11-14T11:59:00Z',
    });
    expect(decideQueueStep(facts({ candidates: [older, revertPr] }))).toEqual({
      kind: 'stage',
      pull: revertPr,
      baseSha: MAIN,
      releaseProof: false,
    });
  });

  test('does not preempt an in-flight normal staging run when an earlier normal PR turns green, unless a fastlane revert arrives', () => {
    const earlierNowGreen = pull({ number: 101, headSha: HEAD_A, prRequiredState: 'success', labeledAt: '2026-11-14T11:35:00Z' });
    const stagedSecond = pull({ number: 102, headSha: HEAD_B, prRequiredState: 'success', labeledAt: '2026-11-14T11:36:00Z' });
    const active = {
      stagingSha: STAGED,
      committedAtMs: NOW - 60_000,
      meta: { prNumber: 102, headSha: HEAD_B, baseSha: MAIN },
      buildRun: stagingRun({ id: 601, status: 'in_progress', conclusion: null }),
    };
    expect(decideQueueStep(facts({ candidates: [earlierNowGreen, stagedSecond], activeStaging: active }))).toEqual({
      kind: 'wait-staging',
      pull: stagedSecond,
      stagingSha: STAGED,
      runUrl: 'https://github.com/owner/repo/actions/runs/500',
      reason: 'staging Build & Test is in progress',
    });

    const fastRevert = pull({ number: 105, title: 'revert: fix: break', headSha: 'd'.repeat(40), labeledAt: '2026-11-14T11:58:00Z' });
    expect(decideQueueStep(facts({ candidates: [earlierNowGreen, stagedSecond, fastRevert], activeStaging: active }))).toEqual({
      kind: 'stage',
      pull: fastRevert,
      baseSha: MAIN,
      releaseProof: false,
      cancelRunId: 601,
    });
  });

  test('skips drafts, stages green PRs ahead of pending PRs, and waits when all PRs are pending', () => {
    const draft = pull({ number: 100, isDraft: true, labeledAt: '2026-11-14T11:30:00Z' });
    const pendingPr = pull({ number: 101, prRequiredState: 'pending', labeledAt: '2026-11-14T11:35:00Z' });
    const greenPr = pull({ number: 102, headSha: HEAD_B, prRequiredState: 'success', labeledAt: '2026-11-14T11:40:00Z' });
    expect(decideQueueStep(facts({ candidates: [draft, pendingPr, greenPr] }))).toEqual({
      kind: 'stage',
      pull: greenPr,
      baseSha: MAIN,
      releaseProof: false,
    });
    expect(decideQueueStep(facts({ candidates: [pendingPr] }))).toEqual({
      kind: 'wait-pr-checks',
      pull: pendingPr,
    });
  });

  test('dequeues immediately on failed PR required checks or fork pull requests', () => {
    const failedPr = pull({ number: 101, prRequiredState: 'failure' });
    expect(decideQueueStep(facts({ candidates: [failedPr] }))).toEqual({
      kind: 'dequeue',
      pull: failedPr,
      reason: 'pull-request-checks-failed',
      cleanStaging: false,
    });
    const forkPr = pull({ number: 104, headRepoFullName: 'stranger/repo' });
    expect(decideQueueStep(facts({ candidates: [forkPr] }))).toEqual({
      kind: 'dequeue',
      pull: forkPr,
      reason: 'cross-repository-pull-request',
      cleanStaging: false,
    });
  });

  test('forwards ci-packaging as releaseProof and cancels stale staging runs when main moved', () => {
    const packaged = pull({ labels: [QUEUE_LABEL, 'ci-packaging'] });
    const staleRun = stagingRun({ id: 444, status: 'in_progress', conclusion: null });
    expect(decideQueueStep(facts({
      candidates: [packaged],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 30_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: '0'.repeat(40) },
        buildRun: staleRun,
      },
    }))).toEqual({
      kind: 'stage',
      pull: packaged,
      baseSha: MAIN,
      releaseProof: true,
      cancelRunId: 444,
    });
  });

  test('waits during the 60s registration window, re-dispatches a cancelled run at most once, and dequeues on a second cancellation', () => {
    const candidate = pull();
    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 15_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
      },
    }))).toEqual({
      kind: 'wait-staging',
      pull: candidate,
      stagingSha: STAGED,
      reason: 'waiting for dispatched Build & Test run to register',
    });

    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 120_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'cancelled', totalRunsForCommit: 1 }),
      },
    }))).toEqual({
      kind: 'dispatch-staging',
      pull: candidate,
      stagingSha: STAGED,
      releaseProof: false,
    });

    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 240_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'cancelled', totalRunsForCommit: 2 }),
      },
    }))).toEqual({
      kind: 'dequeue',
      pull: candidate,
      reason: 'staging-cancelled',
      runUrl: 'https://github.com/owner/repo/actions/runs/500',
      cleanStaging: true,
    });
  });

  test('reruns a first-attempt staging failure once and dequeues on a confirmed second failure', () => {
    const candidate = pull();
    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 120_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ id: 501, attempt: 1, conclusion: 'failure', failedJobs: ['Packaging gate'] }),
      },
    }))).toEqual({
      kind: 'rerun-staging',
      pull: candidate,
      runId: 501,
      runUrl: 'https://github.com/owner/repo/actions/runs/500',
    });

    const dequeued = decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 240_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ id: 501, attempt: 2, conclusion: 'failure', failedJobs: ['Packaging gate'] }),
      },
    }));
    expect(dequeued).toEqual({
      kind: 'dequeue',
      pull: candidate,
      reason: 'staging-checks-failed',
      runUrl: 'https://github.com/owner/repo/actions/runs/500',
      failedJobs: ['Packaging gate'],
      cleanStaging: true,
    });
    if (dequeued.kind === 'dequeue') {
      const comment = dequeueComment(dequeued, MAIN);
      expect(comment).toContain('Packaging gate');
      expect(comment).toContain('actions/runs/500');
      expect(comment).not.toContain('\u2014');
    }
  });

  test('waits if CI / required is still settling on a passing run, dequeues if it failed, and merges once both succeeded', () => {
    const candidate = pull();
    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 180_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'success', requiredCheckState: 'pending', requiredCheckConclusion: null }),
      },
    })).kind).toBe('wait-staging');

    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 180_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'success', requiredCheckState: 'failure', requiredCheckConclusion: 'failure' }),
      },
    })).kind).toBe('dequeue');

    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 180_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'success', requiredCheckState: 'success', requiredCheckConclusion: 'success' }),
      },
    }))).toEqual({
      kind: 'merge',
      pull: candidate,
      baseSha: MAIN,
      stagingSha: STAGED,
      runUrl: 'https://github.com/owner/repo/actions/runs/500',
    });
    expect(STAGING_BRANCH).toBe('merge-queue/staging');
  });
});

describe('the merge queue workflow contract', () => {
  const workflowDir = resolve(import.meta.dir, '../../.github/workflows');
  const lane = () => Bun.YAML.parse(readFileSync(resolve(workflowDir, 'merge-queue.yml'), 'utf8')) as {
    name: string;
    on: Record<string, Record<string, unknown> | null>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    permissions: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      permissions?: Record<string, string>;
      steps: Array<{ run?: string; env?: Record<string, string> }>;
    }>;
  };

  test('serializes runs without cancelling an active merge, guards fork pull requests, and defaults dispatch to dry-run', () => {
    const parsed = lane();
    expect(parsed.concurrency).toEqual({ group: 'merge-queue', 'cancel-in-progress': false });
    expect(parsed.permissions).toEqual({ contents: 'read' });
    expect(parsed.jobs.queue?.permissions).toEqual({
      actions: 'write',
      contents: 'write',
      issues: 'write',
      'pull-requests': 'write',
    });
    expect(parsed.jobs.queue?.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    const inputs = parsed.on.workflow_dispatch?.inputs as Record<string, { default?: unknown }>;
    expect(inputs.dry_run?.default).toBe(true);
    const runStep = parsed.jobs.queue?.steps.find((step) => step.run === 'bun scripts/ci/merge-queue-github.ts');
    expect(runStep).toBeDefined();
  });
});
