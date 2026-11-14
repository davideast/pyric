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
import {
  needsSimulatorParity,
  runQueuePass,
  type QueueIo,
} from './merge-queue-github.ts';

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
    status: 'completed',
    conclusion: 'success',
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
  });

  test('returns undefined for unrelated commit messages', () => {
    expect(parseStagingCommit('Merge pull request #101 from owner/fix')).toBeUndefined();
  });
});

describe('merge queue decisions', () => {
  test('idles when no pull request is queued and no staging branch exists', () => {
    expect(decideQueueStep(facts())).toEqual({ kind: 'idle', reason: 'queue is empty' });
  });

  test('cleans an orphan staging branch and cancels its in-flight run when the queue drains', () => {
    const run = stagingRun({ status: 'in_progress', conclusion: null });
    expect(decideQueueStep(facts({
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 10_000,
        meta: { prNumber: 99, headSha: HEAD_A, baseSha: MAIN },
        buildRun: run,
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

  test('skips draft pull requests and lets an already-green pull request stage ahead of one whose PR checks are still running', () => {
    const draft = pull({ number: 100, isDraft: true, labeledAt: '2026-11-14T11:30:00Z' });
    const pendingPr = pull({ number: 101, prRequiredState: 'pending', labeledAt: '2026-11-14T11:35:00Z' });
    const greenPr = pull({ number: 102, headSha: HEAD_B, prRequiredState: 'success', labeledAt: '2026-11-14T11:40:00Z' });
    expect(decideQueueStep(facts({ candidates: [draft, pendingPr, greenPr] }))).toEqual({
      kind: 'stage',
      pull: greenPr,
      baseSha: MAIN,
      releaseProof: false,
    });
  });

  test('waits quietly when every queued pull request still has pending PR checks', () => {
    const pendingPr = pull({ number: 101, prRequiredState: 'pending' });
    expect(decideQueueStep(facts({ candidates: [pendingPr] }))).toEqual({
      kind: 'wait-pr-checks',
      pull: pendingPr,
    });
  });

  test('dequeues a pull request immediately when its own PR required check failed or it comes from a fork', () => {
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

  test('forwards ci-packaging as releaseProof when staging and cancels any stale staging run when main moved', () => {
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

  test('waits while a newly pushed staging commit registers its workflow run, then re-dispatches after 60s', () => {
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
        committedAtMs: NOW - 65_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
      },
    }))).toEqual({
      kind: 'dispatch-staging',
      pull: candidate,
      stagingSha: STAGED,
      releaseProof: false,
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

  test('merges only when both the staging workflow and CI / required succeeded on the current main tip', () => {
    const candidate = pull();
    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 180_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'success', requiredCheckConclusion: 'failure' }),
      },
    })).kind).toBe('rerun-staging');

    expect(decideQueueStep(facts({
      candidates: [candidate],
      activeStaging: {
        stagingSha: STAGED,
        committedAtMs: NOW - 180_000,
        meta: { prNumber: 101, headSha: HEAD_A, baseSha: MAIN },
        buildRun: stagingRun({ conclusion: 'success', requiredCheckConclusion: 'success' }),
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

describe('executing a queue pass', () => {
  const MAIN_2 = '2'.repeat(40);

  interface Harness {
    gh: string[][];
    git: string[][];
    comments: string[];
    io: QueueIo;
    setState: (next: {
      mainSha?: string;
      remoteStagingSha?: string;
      pulls?: Array<{
        number: number;
        title: string;
        draft?: boolean;
        headRef: string;
        headSha: string;
        headRepo?: string;
        labels: string[];
        createdAt?: string;
      }>;
      eventsByPr?: Record<number, Array<{ event: string; created_at: string; label?: { name: string } }>>;
      checkBySha?: Record<string, { status: string; conclusion: string | null } | undefined>;
      stagingCommit?: { message: string; date: string };
      stagingRuns?: Array<{ id: number; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
      failedJobsByAttempt?: Record<string, string[]>;
      filesByPr?: Record<number, string[]>;
      mergeConflictOn?: Set<string>;
      onMergePr?: (prNumber: number) => void;
    }) => void;
  }

  function createHarness(): Harness {
    const gh: string[][] = [];
    const git: string[][]= [];
    const comments: string[] = [];
    let state: Parameters<Harness['setState']>[0] = {};

    const io: QueueIo = {
      repo: 'owner/repo',
      now: () => NOW,
      log: () => {},
      writeFile: (name, text) => {
        comments.push(text);
        return `/tmp/${name}`;
      },
      git: (args) => {
        git.push(args);
        if (args[0] === 'ls-remote') {
          return state.remoteStagingSha ? `${state.remoteStagingSha}\trefs/heads/${STAGING_BRANCH}\n` : '';
        }
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const targetSha = args.at(-1) ?? '';
          if (state.mergeConflictOn?.has(targetSha)) {
            throw new Error('CONFLICT (content): Merge conflict in packages/cli/src/serve/rules.ts');
          }
        }
        if (args[0] === 'push' && args.includes('--delete')) {
          state.remoteStagingSha = undefined;
        }
        return '';
      },
      gh: (args) => {
        gh.push(args);
        if (args[0] !== 'api') return '';
        const methodIdx = args.indexOf('-X');
        const method = methodIdx === -1 ? 'GET' : args[methodIdx + 1];
        const pathArg = args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? '';
        const path = pathArg.replace('repos/owner/repo/', '');

        if (method === 'GET' && path === 'branches/main') {
          return JSON.stringify({ commit: { sha: state.mainSha ?? MAIN } });
        }
        if (method === 'GET' && path.startsWith('pulls?')) {
          const pulls = (state.pulls ?? []).map((item) => ({
            number: item.number,
            title: item.title,
            draft: item.draft ?? false,
            created_at: item.createdAt ?? '2026-11-14T11:00:00Z',
            head: { ref: item.headRef, sha: item.headSha, repo: { full_name: item.headRepo ?? 'owner/repo' } },
            labels: item.labels.map((name) => ({ name })),
          }));
          return JSON.stringify(pulls);
        }
        const eventsMatch = /^issues\/(\d+)\/events\?/.exec(path);
        if (method === 'GET' && eventsMatch) {
          return JSON.stringify(state.eventsByPr?.[Number(eventsMatch[1])] ?? []);
        }
        const checkMatch = /^commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
        if (method === 'GET' && checkMatch) {
          const check = state.checkBySha?.[checkMatch[1]!];
          return JSON.stringify({
            check_runs: check ? [{ name: 'CI / required', status: check.status, conclusion: check.conclusion, app: { slug: 'github-actions' } }] : [],
          });
        }
        if (method === 'GET' && path === `commits/${state.remoteStagingSha}`) {
          return JSON.stringify({
            sha: state.remoteStagingSha,
            commit: {
              message: state.stagingCommit?.message ?? '',
              committer: { date: state.stagingCommit?.date ?? '2026-11-14T11:55:00Z' },
            },
          });
        }
        if (method === 'GET' && path.startsWith('actions/workflows/build.yml/runs?')) {
          return JSON.stringify({ workflow_runs: state.stagingRuns ?? [] });
        }
        const jobsMatch = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path);
        if (method === 'GET' && jobsMatch) {
          const failed = state.failedJobsByAttempt?.[`${jobsMatch[1]}:${jobsMatch[2]}`] ?? [];
          return JSON.stringify({ jobs: failed.map((name) => ({ name, conclusion: 'failure' })) });
        }
        const filesMatch = /^pulls\/(\d+)\/files\?/.exec(path);
        if (method === 'GET' && filesMatch) {
          const files = state.filesByPr?.[Number(filesMatch[1])] ?? [];
          return JSON.stringify(files.map((filename) => ({ filename })));
        }
        const deleteLabelMatch = /^issues\/(\d+)\/labels\/merge-queue$/.exec(path);
        if (method === 'DELETE' && deleteLabelMatch) {
          const prNum = Number(deleteLabelMatch[1]);
          state.pulls = (state.pulls ?? []).map((item) => {
            if (item.number !== prNum) return item;
            return { ...item, labels: item.labels.filter((label) => label !== QUEUE_LABEL) };
          });
          return '{}';
        }
        const mergeMatch = /^pulls\/(\d+)\/merge$/.exec(path);
        if (method === 'PUT' && mergeMatch) {
          const prNum = Number(mergeMatch[1]);
          state.pulls = (state.pulls ?? []).filter((item) => item.number !== prNum);
          state.onMergePr?.(prNum);
          return JSON.stringify({ merged: true, sha: MAIN_2 });
        }
        if (method === 'POST' && /^issues\/\d+\/comments$/.test(path)) {
          return JSON.stringify({ id: 1 });
        }
        throw new Error(`unexpected gh api ${method} ${path}`);
      },
    };

    return {
      gh,
      git,
      comments,
      io,
      setState: (next) => { state = next; },
    };
  }

  test('merges a green staged PR, dispatches main workflows under the workflow token, and stages the next queued PR in one pass', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      remoteStagingSha: STAGED,
      pulls: [
        { number: 101, title: 'fix(rules): simulator parity', headRef: 'fix/sim', headSha: HEAD_A, labels: [QUEUE_LABEL] },
        { number: 102, title: 'fix(cli): packaging flag', headRef: 'fix/pkg', headSha: HEAD_B, labels: [QUEUE_LABEL, 'ci-packaging'] },
      ],
      eventsByPr: {
        101: [{ event: 'labeled', created_at: '2026-11-14T11:40:00Z', label: { name: QUEUE_LABEL } }],
        102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }],
      },
      checkBySha: {
        [HEAD_A]: { status: 'completed', conclusion: 'success' },
        [HEAD_B]: { status: 'completed', conclusion: 'success' },
        [STAGED]: { status: 'completed', conclusion: 'success' },
      },
      stagingCommit: {
        message: formatStagingCommit({ prNumber: 101, headSha: HEAD_A, baseSha: MAIN }),
        date: '2026-11-14T11:50:00Z',
      },
      stagingRuns: [{ id: 500, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/500' }],
      filesByPr: { 101: ['packages/rules/src/simulator/eval.ts'] },
      onMergePr: () => {
        h.setState({
          mainSha: MAIN_2,
          remoteStagingSha: undefined,
          pulls: [{ number: 102, title: 'fix(cli): packaging flag', headRef: 'fix/pkg', headSha: HEAD_B, labels: [QUEUE_LABEL, 'ci-packaging'] }],
          eventsByPr: { 102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }] },
          checkBySha: { [HEAD_B]: { status: 'completed', conclusion: 'success' } },
        });
      },
    });

    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['merge', 'stage']);
    expect(h.gh).toContainEqual(['api', '-X', 'PUT', 'repos/owner/repo/pulls/101/merge', '-f', 'merge_method=merge', '-f', `sha=${HEAD_A}`]);
    expect(h.gh).toContainEqual(['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.gh).toContainEqual(['workflow', 'run', 'slow-scenarios.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.gh).toContainEqual(['workflow', 'run', 'simulator-parity.yml', '--repo', 'owner/repo', '--ref', 'main']);
    expect(h.git).toContainEqual(['checkout', '--detach', MAIN_2]);
    expect(h.gh).toContainEqual(['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', STAGING_BRANCH, '-f', 'release_proof=true']);
  });

  test('aborts a conflicting merge, dequeues the conflicting PR with a comment, and stages the next PR immediately', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      pulls: [
        { number: 101, title: 'fix(cli): conflict', headRef: 'fix/conflict', headSha: HEAD_A, labels: [QUEUE_LABEL] },
        { number: 102, title: 'fix(cli): clean', headRef: 'fix/clean', headSha: HEAD_B, labels: [QUEUE_LABEL] },
      ],
      eventsByPr: {
        101: [{ event: 'labeled', created_at: '2026-11-14T11:40:00Z', label: { name: QUEUE_LABEL } }],
        102: [{ event: 'labeled', created_at: '2026-11-14T11:45:00Z', label: { name: QUEUE_LABEL } }],
      },
      checkBySha: {
        [HEAD_A]: { status: 'completed', conclusion: 'success' },
        [HEAD_B]: { status: 'completed', conclusion: 'success' },
      },
      mergeConflictOn: new Set([HEAD_A]),
    });

    const actions = runQueuePass(h.io, { dryRun: false, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['dequeue', 'stage']);
    expect(h.git).toContainEqual(['merge', '--abort']);
    expect(h.gh).toContainEqual(['api', '-X', 'DELETE', 'repos/owner/repo/issues/101/labels/merge-queue']);
    expect(h.comments[0]).toContain('produced a conflict');
    expect(h.git).toContainEqual(['merge', '--no-ff', '-m', formatStagingCommit({ prNumber: 102, headSha: HEAD_B, baseSha: MAIN }), HEAD_B]);
  });

  test('dryRun computes the next action and performs no git or GitHub mutations', () => {
    const h = createHarness();
    h.setState({
      mainSha: MAIN,
      pulls: [{ number: 101, title: 'fix(cli): clean', headRef: 'fix/clean', headSha: HEAD_A, labels: [QUEUE_LABEL] }],
      checkBySha: { [HEAD_A]: { status: 'completed', conclusion: 'success' } },
    });

    const actions = runQueuePass(h.io, { dryRun: true, usingWorkflowToken: true });
    expect(actions.map((action) => action.kind)).toEqual(['stage']);
    expect(h.git.filter((args) => args[0] !== 'ls-remote')).toEqual([]);
    expect(h.gh.filter((args) => args[0] !== 'api' || args.includes('-X'))).toEqual([]);
  });

  test('detects simulator parity paths accurately', () => {
    expect(needsSimulatorParity(['packages/rules/src/grammar/firestore.ohm'])).toBe(true);
    expect(needsSimulatorParity(['packages/cli/src/serve/rules.ts'])).toBe(false);
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
