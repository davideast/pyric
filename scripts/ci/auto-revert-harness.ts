import type { Io } from './auto-revert-github.ts';
import type { FailedRun } from './auto-revert.ts';
import { bisectBranch } from './auto-revert-batch.ts';
import { formatStagingTrailers } from './merge-queue.ts';

export const SHA = 'b'.repeat(40);
export const PARENT = 'a'.repeat(40);
export const BRANCH_TIP = 'c'.repeat(40);
export const BATCH = 'd'.repeat(40);
export const PROBE = 'e'.repeat(40);
export const RUN_URL = 'https://github.com/owner/repo/actions/runs/9';
export const TEST = 'packages/cli/test/serve/host.test.ts > host > answers';

export function failedRun(overrides: Partial<FailedRun> = {}): FailedRun {
  return {
    workflow: 'Slow app scenarios',
    runId: 9,
    attempt: 2,
    url: RUN_URL,
    headSha: SHA,
    parents: [PARENT, BRANCH_TIP],
    message: 'Merge pull request #12 from owner/feat/host\n\nfeat(cli): host answers',
    pull: { number: 12, title: 'feat(cli): host answers', headRef: 'feat/host' },
    failures: [{ job: 'Slow app scenarios (real apps on the packed packages)', test: TEST }],
    ...overrides,
  };
}

export interface Fake {
  io: Io;
  gh: string[][];
  git: string[][];
  logs: string[];
}

export interface FakeOptions {
  attempt: number;
  workflow?: string;
  runEvent?: 'push' | 'workflow_dispatch';
  runActor?: string;
  prCreate?: () => string;
  parentConclusion?: string;
  parentEvent?: 'push' | 'workflow_dispatch';
  parentActor?: string;
  existingPrs?: { number: number; state: string }[];
  remoteBranch?: boolean;
  push?: () => string;
}

function apiPathFrom(args: string[]): string {
  const matched = args.find((arg) => arg.startsWith('repos/owner/repo/'));
  const raw = matched ?? args[1] ?? '';
  if (raw.startsWith('repos/owner/repo/')) return raw.slice('repos/owner/repo/'.length);
  return raw;
}

export function createFake(options: FakeOptions): Fake {
  const gh: string[][] = [];
  const git: string[][] = [];
  const logs: string[] = [];
  const parentEvent = options.parentEvent ?? 'push';
  const parentRuns = [{
    status: 'completed',
    conclusion: options.parentConclusion ?? 'success',
    html_url: 'https://github.com/owner/repo/actions/runs/8',
    event: parentEvent,
    head_branch: 'main',
    actor: { login: options.parentActor ?? 'github-actions[bot]' },
  }];
  const pushParentRuns = parentEvent === 'push' ? parentRuns : [];
  const dispatchParentRuns = parentEvent === 'workflow_dispatch' ? parentRuns : [];
  const runEvent = options.runEvent ?? 'push';
  const responses: Record<string, unknown> = {
    [`actions/runs/9/attempts/${options.attempt}`]: {
      name: options.workflow ?? 'Slow app scenarios',
      event: runEvent,
      head_branch: 'main',
      head_sha: SHA,
      status: 'completed',
      conclusion: 'failure',
      workflow_id: 5,
      html_url: RUN_URL,
      actor: { login: options.runActor ?? 'github-actions[bot]' },
    },
    [`commits/${SHA}`]: { sha: SHA, parents: [{ sha: PARENT }, { sha: BRANCH_TIP }], commit: { message: failedRun().message } },
    [`commits/${SHA}/pulls`]: [{ number: 12, title: 'feat(cli): host answers', merge_commit_sha: SHA, head: { ref: 'feat/host' } }],
    [`actions/workflows/5/runs?branch=main&event=push&head_sha=${PARENT}&per_page=5`]: { workflow_runs: pushParentRuns },
    [`actions/workflows/5/runs?branch=main&event=workflow_dispatch&head_sha=${PARENT}&per_page=5`]: { workflow_runs: dispatchParentRuns },
    'branches/main': { commit: { sha: SHA } },
    'actions/workflows/5/runs?branch=main&event=push&per_page=10': { workflow_runs: [{ id: 9, status: 'completed' }] },
    'actions/workflows/5/runs?branch=main&event=workflow_dispatch&per_page=10': { workflow_runs: [] },
    'issues/50/labels': [{ name: 'merge-queue' }],
  };
  const io: Io = {
    repo: 'owner/repo',
    gh: (args) => {
      gh.push(args);
      if (args[0] === 'api') {
        const path = apiPathFrom(args);
        if (!(path in responses)) throw new Error(`unexpected api ${path}`);
        return JSON.stringify(responses[path]);
      }
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(options.existingPrs ?? []);
      if (args[0] === 'pr' && args[1] === 'create') return options.prCreate?.() ?? 'https://github.com/owner/repo/pull/50\n';
      return '';
    },
    git: (args) => {
      git.push(args);
      if (args[0] === 'ls-remote') {
        if (options.remoteBranch) return `${SHA}\trefs/heads/auto-revert/${SHA}\n`;
        return '';
      }
      if (args[0] === 'push') return options.push?.() ?? '';
      return '';
    },
    failures: () => failedRun().failures,
    log: (text) => logs.push(text),
    writeFile: (name) => `/tmp/${name}`,
  };
  return { io, gh, git, logs };
}

export type ProbeRun = { run_attempt: number; status: string; conclusion: string | null };

export interface BatchFake {
  io: Io;
  gh: string[][];
  git: string[][];
  logs: string[];
  bodies: string[];
}

export interface BatchFakeOptions {
  titles?: Record<number, string>;
  existingPrs?: { number: number; state: string }[];
  onRevert?: () => string;
}

export function memberSha(index: number): string {
  return String(index + 1).repeat(40);
}

function headShaFor(index: number): string {
  return String(index + 5).repeat(40);
}

export function probeBranchFor(index: number): string {
  return bisectBranch({ commit: BATCH, workflowId: 5, index });
}

export function createBatchFake(
  probes: Record<number, ProbeRun | undefined>,
  options: BatchFakeOptions = {},
): BatchFake {
  const gh: string[][] = [];
  const git: string[][] = [];
  const logs: string[] = [];
  const bodies: string[] = [];
  const pulls = [0, 1, 2].map((index) => ({ number: 21 + index, headSha: headShaFor(index) }));
  const mainRun = {
    id: 9,
    run_attempt: 2,
    name: 'Slow app scenarios',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: BATCH,
    status: 'completed',
    conclusion: 'failure',
    workflow_id: 5,
    html_url: RUN_URL,
    path: '.github/workflows/slow-scenarios.yml',
    actor: { login: 'github-actions[bot]' },
  };
  const responses: Record<string, unknown> = {
    'actions/runs/9/attempts/2': mainRun,
    [`commits/${BATCH}`]: {
      sha: BATCH,
      parents: [{ sha: PARENT }, { sha: memberSha(2) }],
      commit: { message: `Merge queue batch: #21, #22, #23\n\n${formatStagingTrailers({ baseSha: PARENT, pulls })}` },
    },
    [`actions/workflows/5/runs?branch=main&event=push&head_sha=${PARENT}&per_page=5`]: {
      workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/8', event: 'push', head_branch: 'main' }],
    },
    [`actions/workflows/5/runs?branch=main&head_sha=${BATCH}&per_page=10`]: { workflow_runs: [mainRun] },
    'issues/50/labels': [{ name: 'merge-queue' }],
  };
  for (const index of [0, 1, 2]) {
    let parent = PARENT;
    if (index > 0) parent = memberSha(index - 1);
    const prNumber = 21 + index;
    const head = headShaFor(index);
    const title = options.titles?.[prNumber] ?? `feat(cli): change ${prNumber}`;
    responses[`commits/${memberSha(index)}`] = {
      sha: memberSha(index),
      parents: [{ sha: parent }, { sha: head }],
      commit: { message: `Merge pull request #${prNumber} from feat/${index}\n\ntitle\n\nMerge-Queue-Pull: #${prNumber} ${head}` },
    };
    responses[`pulls/${prNumber}`] = { number: prNumber, title, head: { ref: `feat/${index}` } };
    const probeRuns: ProbeRun[] = [];
    const probe = probes[index];
    if (probe !== undefined) probeRuns.push(probe);
    responses[`actions/workflows/5/runs?branch=${encodeURIComponent(probeBranchFor(index))}&per_page=5`] = { workflow_runs: probeRuns };
  }
  const io: Io = {
    repo: 'owner/repo',
    gh: (args) => {
      gh.push(args);
      if (args[0] === 'api') {
        const path = apiPathFrom(args);
        if (!(path in responses)) throw new Error(`unexpected api ${path}`);
        return JSON.stringify(responses[path]);
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const headIdx = args.indexOf('--head');
        if (headIdx >= 0 && args[headIdx + 1] === `auto-revert/${BATCH}`) return '[]';
        return JSON.stringify(options.existingPrs ?? []);
      }
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/repo/pull/50\n';
      return '';
    },
    git: (args) => {
      git.push(args);
      if (args[0] === 'ls-remote' && args.at(-1)?.includes('merge-queue/bisect/')) {
        return Object.keys(probes).map((index) => `${PROBE}\trefs/heads/${probeBranchFor(Number(index))}\n`).join('');
      }
      if (args[0] === 'revert' && options.onRevert !== undefined) return options.onRevert();
      if (args[0] === 'rev-parse') return `tree-of-${args[1]}\n`;
      if (args[0] === 'commit-tree') return `${PROBE}\n`;
      return '';
    },
    failures: () => failedRun().failures,
    log: (text) => logs.push(text),
    writeFile: (name, text) => { bodies.push(text); return `/tmp/${name}`; },
  };
  return { io, gh, git, logs, bodies };
}
