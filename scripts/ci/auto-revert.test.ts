import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handle, handleProbe, reportFailure, type Io } from './auto-revert-github.ts';
import { decide, decideBatch, isRevert, quarantinedFailures, revertBody, revertCommands, type FailedRun, type Facts, type ProbeResult } from './auto-revert.ts';
import { bisectBranch, parseBisectBranch } from './auto-revert-batch.ts';
import { formatStagingTrailers } from './merge-queue.ts';

const SHA = 'b'.repeat(40);
const PARENT = 'a'.repeat(40);
const BRANCH_TIP = 'c'.repeat(40);
const RUN_URL = 'https://github.com/owner/repo/actions/runs/9';
const TEST = 'packages/cli/test/serve/host.test.ts > host > answers';

function run(overrides: Partial<FailedRun> = {}): FailedRun {
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

function facts(overrides: Partial<Facts> = {}): Facts {
  return { run: run(), parentConclusion: 'success', superseded: false, quarantine: [], today: '2026-11-06', ...overrides };
}

describe('culprit selection', () => {
  test('a second failed attempt whose parent passed reverts the merge with mainline 1', () => {
    expect(decide(facts())).toEqual({ kind: 'revert', title: 'revert: feat(cli): host answers', branch: `auto-revert/${SHA}`, mainline: true });
  });

  test('a commit with one parent is reverted without a mainline', () => {
    const verdict = decide(facts({ run: run({ parents: [PARENT], pull: undefined, message: 'fix: one commit' }) }));
    expect(verdict).toEqual({ kind: 'revert', title: 'revert: fix: one commit', branch: `auto-revert/${SHA}`, mainline: false });
    if (verdict.kind !== 'revert') throw new Error('expected a revert');
    expect(revertCommands(run({ parents: [PARENT] }), verdict)[1]).toEqual(['revert', '--no-edit', SHA]);
  });

  test('the merge revert names mainline 1 and branches from main', () => {
    const verdict = decide(facts());
    if (verdict.kind !== 'revert') throw new Error('expected a revert');
    expect(revertCommands(run(), verdict)).toEqual([
      ['switch', '-c', `auto-revert/${SHA}`, 'origin/main'],
      ['revert', '--no-edit', '-m', '1', SHA],
    ]);
  });

  test('a parent with no finished run leaves the culprit unknown', () => {
    expect(decide(facts({ parentConclusion: undefined })).kind).toBe('skip');
    expect(decide(facts({ parentConclusion: 'cancelled' })).kind).toBe('skip');
  });

  test('an open revert pull request for the commit is not opened twice', () => {
    expect(decide(facts({ existingRevert: { number: 40, state: 'OPEN' } }))).toEqual({ kind: 'skip', reason: 'revert pull request #40 already exists (open)' });
  });

  test('a revert pull request someone closed is not opened again', () => {
    expect(decide(facts({ existingRevert: { number: 41, state: 'CLOSED' } }))).toEqual({ kind: 'skip', reason: 'revert pull request #41 already exists (closed)' });
  });

  test('an unwatched workflow and a third attempt do nothing', () => {
    expect(decide(facts({ run: run({ workflow: 'Fresh install' }) })).kind).toBe('skip');
    expect(decide(facts({ run: run({ attempt: 3 }) })).kind).toBe('skip');
  });
});

describe('already red', () => {
  test('a failed parent run means main was red before this commit', () => {
    const verdict = decide(facts({ parentConclusion: 'failure' }));
    expect(verdict).toEqual({ kind: 'skip', reason: `the run on the parent ${PARENT} failed too, so main was already red` });
    expect(decide(facts({ parentConclusion: 'timed_out', run: run({ attempt: 1 }) })).kind).toBe('skip');
  });
});

describe('the first attempt', () => {
  test('a slow scenario failure is rerun once', () => {
    expect(decide(facts({ run: run({ attempt: 1 }) }))).toEqual({ kind: 'rerun' });
  });

  test('Build & Test is left to the main failure lane, which reruns it', () => {
    expect(decide(facts({ run: run({ attempt: 1, workflow: 'Build & Test' }) })).kind).toBe('skip');
    expect(decide(facts({ run: run({ attempt: 2, workflow: 'Build & Test' }) })).kind).toBe('revert');
  });

  test('a superseded run is not rerun, since the rerun would cancel the newer run', () => {
    expect(decide(facts({ run: run({ attempt: 1 }), superseded: true })).kind).toBe('skip');
  });

  test('an already red first attempt is not rerun', () => {
    expect(decide(facts({ run: run({ attempt: 1 }), parentConclusion: 'failure' })).kind).toBe('skip');
  });
});

describe('revert of a revert', () => {
  test.each([
    ['a revert pull request title', run({ pull: { number: 13, title: 'revert: feat(cli): host answers', headRef: 'fix/undo' } })],
    ['a git revert title', run({ pull: { number: 13, title: 'Revert "feat(cli): host answers"', headRef: 'fix/undo' } })],
    ['this lane\'s own branch', run({ pull: { number: 13, title: 'undo the host', headRef: `auto-revert/${PARENT}` } })],
    ['a direct revert commit', run({ pull: undefined, parents: [PARENT], message: `Revert "feat: x"\n\nThis reverts commit ${PARENT}.` })],
  ])('%s is never reverted', (_name, revertRun) => {
    expect(isRevert(revertRun)).toBe(true);
    expect(decide(facts({ run: revertRun })).kind).toBe('skip');
  });

  test('a title that only mentions a revert is not a revert', () => {
    expect(isRevert(run({ pull: { number: 14, title: 'feat: show reverted rules', headRef: 'feat/reverted' } }))).toBe(false);
  });
});

describe('quarantine', () => {
  const entry = { test: TEST, expires: '2026-11-20' };

  test('a failure an active entry names is not reverted', () => {
    expect(quarantinedFailures(run().failures, [entry], '2026-11-06')).toEqual([TEST]);
    expect(decide(facts({ quarantine: [entry] }))).toEqual({ kind: 'skip', reason: `quarantined tests failed: ${TEST}` });
  });

  test('an expired entry no longer holds the revert back', () => {
    expect(decide(facts({ quarantine: [entry], today: '2026-11-20' })).kind).toBe('revert');
  });

  test('an unnamed hook entry and an app entry cover the tests under them', () => {
    const hook = { test: 'packages/cli/test/serve/host.test.ts > (unnamed)', expires: '2026-11-20' };
    const app = { test: 'test/apps/todo', expires: '2026-11-20' };
    const failures = [{ job: 'j', test: 'test/apps/todo/scenario.ts > loads' }];
    expect(quarantinedFailures(run().failures, [hook], '2026-11-06')).toEqual([TEST]);
    expect(quarantinedFailures(failures, [app], '2026-11-06')).toEqual(['test/apps/todo/scenario.ts > loads']);
    expect(quarantinedFailures(failures, [{ test: 'test/apps/to', expires: '2026-11-20' }], '2026-11-06')).toEqual([]);
  });

  test('a job failure with no test is never quarantined', () => {
    expect(quarantinedFailures([{ job: 'Packaging gate' }], [entry], '2026-11-06')).toEqual([]);
  });
});

describe('the revert pull request body', () => {
  test('it names the original pull request, the failing run, jobs and tests, and the passing parent run', () => {
    const body = revertBody({ run: run(), failedJobs: ['Slow app scenarios (real apps on the packed packages)'], parentRunUrl: 'https://github.com/owner/repo/actions/runs/8' });
    expect(body).toContain(`Reverts #12 (${SHA})`);
    expect(body).toContain(`${RUN_URL} (attempt 2)`);
    expect(body).toContain('`Slow app scenarios (real apps on the packed packages)`');
    expect(body).toContain(`\`${TEST}\``);
    expect(body).toContain('actions/runs/8');
  });
});

describe('carrying out the verdict', () => {
  interface Fake { io: Io; gh: string[][]; git: string[][]; logs: string[] }

  interface FakeOptions {
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

  function fake(options: FakeOptions): Fake {
    const calls: Fake = { gh: [], git: [], logs: [], io: undefined as unknown as Io };
    const parentEvent = options.parentEvent ?? 'push';
    const parentRuns = [{
      status: 'completed',
      conclusion: options.parentConclusion ?? 'success',
      html_url: 'https://github.com/owner/repo/actions/runs/8',
      event: parentEvent,
      head_branch: 'main',
      actor: { login: options.parentActor ?? 'github-actions[bot]' },
    }];
    const runEvent = options.runEvent ?? 'push';
    const responses: Record<string, unknown> = {
      [`actions/runs/9/attempts/${options.attempt}`]: {
        name: options.workflow ?? 'Slow app scenarios', event: runEvent, head_branch: 'main', head_sha: SHA,
        status: 'completed', conclusion: 'failure', workflow_id: 5, html_url: RUN_URL,
        actor: { login: options.runActor ?? 'github-actions[bot]' },
      },
      [`commits/${SHA}`]: { sha: SHA, parents: [{ sha: PARENT }, { sha: BRANCH_TIP }], commit: { message: run().message } },
      [`commits/${SHA}/pulls`]: [{ number: 12, title: 'feat(cli): host answers', merge_commit_sha: SHA, head: { ref: 'feat/host' } }],
      [`actions/workflows/5/runs?branch=main&event=push&head_sha=${PARENT}&per_page=5`]: {
        workflow_runs: parentEvent === 'push' ? parentRuns : [],
      },
      [`actions/workflows/5/runs?branch=main&event=workflow_dispatch&head_sha=${PARENT}&per_page=5`]: {
        workflow_runs: parentEvent === 'workflow_dispatch' ? parentRuns : [],
      },
      'branches/main': { commit: { sha: SHA } },
      'actions/workflows/5/runs?branch=main&event=push&per_page=10': { workflow_runs: [{ id: 9, status: 'completed' }] },
      'actions/workflows/5/runs?branch=main&event=workflow_dispatch&per_page=10': { workflow_runs: [] },
      'issues/50/labels': [{ name: 'merge-queue' }],
    };
    calls.io = {
      repo: 'owner/repo',
      gh: (args) => {
        calls.gh.push(args);
        if (args[0] === 'api') {
          const pathArg = args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? args[1] ?? '';
          const path = pathArg.replace('repos/owner/repo/', '');
          if (!(path in responses)) throw new Error(`unexpected api ${path}`);
          return JSON.stringify(responses[path]);
        }
        if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(options.existingPrs ?? []);
        if (args[0] === 'pr' && args[1] === 'create') return options.prCreate?.() ?? 'https://github.com/owner/repo/pull/50\n';
        return '';
      },
      git: (args) => {
        calls.git.push(args);
        if (args[0] === 'ls-remote') return options.remoteBranch ? `${SHA}\trefs/heads/auto-revert/${SHA}\n` : '';
        if (args[0] === 'push') return options.push?.() ?? '';
        return '';
      },
      failures: () => run().failures,
      log: (text) => calls.logs.push(text),
      writeFile: (name) => `/tmp/${name}`,
    };
    return calls;
  }

  test('attempt 1 of a slow scenario run reruns its failed jobs and nothing else', () => {
    const calls = fake({ attempt: 1 });
    expect(handle(calls.io, 9, 1, false, [], '2026-11-06')).toEqual({ kind: 'rerun' });
    expect(calls.gh).toContainEqual(['run', 'rerun', '9', '--failed', '--repo', 'owner/repo']);
    expect(calls.git).toEqual([]);
  });

  test('attempt 2 pushes a revert branch, opens the pull request and enables auto-merge, never touching main', () => {
    const calls = fake({ attempt: 2 });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('revert');
    expect(calls.git).toContainEqual(['revert', '--no-edit', '-m', '1', SHA]);
    expect(calls.git).toContainEqual(['push', 'origin', `HEAD:refs/heads/auto-revert/${SHA}`]);
    expect(calls.git.some((args) => args.some((arg) => arg.endsWith(':refs/heads/main') || arg === 'main'))).toBe(false);
    const create = calls.gh.find((args) => args[0] === 'pr' && args[1] === 'create');
    expect(create).toEqual(['pr', 'create', '--repo', 'owner/repo', '--base', 'main', '--head', `auto-revert/${SHA}`, '--title', 'revert: feat(cli): host answers', '--body-file', '/tmp/revert-body.md']);
    expect(calls.gh).toContainEqual(['pr', 'merge', 'https://github.com/owner/repo/pull/50', '--repo', 'owner/repo', '--auto', '--merge']);
  });

  test('the revert branch gets Build & Test by dispatch, since a workflow token pull request starts no workflows', () => {
    const calls = fake({ attempt: 2 });
    handle(calls.io, 9, 2, false, [], '2026-11-06');
    const dispatch = ['workflow', 'run', 'build.yml', '--repo', 'owner/repo', '--ref', `auto-revert/${SHA}`];
    expect(calls.gh).toContainEqual(dispatch);
    const index = (match: (args: string[]) => boolean) => calls.gh.findIndex(match);
    const created = index((args) => args[1] === 'create');
    const dispatched = index((args) => args.join(' ') === dispatch.join(' '));
    const autoMerge = index((args) => args[1] === 'merge');
    expect(created).toBeLessThan(dispatched);
    expect(dispatched).toBeLessThan(autoMerge);
  });

  test('closed pull requests count too: the lookup asks for every state', () => {
    const calls = fake({ attempt: 2, existingPrs: [{ number: 41, state: 'CLOSED' }] });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
    expect(calls.gh.find((args) => args[1] === 'list')).toContain('all');
    expect(calls.git).toEqual([]);
  });

  test('an existing revert branch ends quietly without pushing', () => {
    const calls = fake({ attempt: 2, remoteBranch: true });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
    expect(calls.git.some((args) => args[0] === 'push' || args[0] === 'revert')).toBe(false);
    expect(calls.gh.some((args) => args[1] === 'create')).toBe(false);
  });

  test('a second job that loses the push race ends quietly', () => {
    const calls = fake({ attempt: 2, push: () => { throw new Error('git push failed: ! [rejected] HEAD -> auto-revert/x (fetch first)'); } });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
    expect(calls.gh.some((args) => args[1] === 'create')).toBe(false);
  });

  test('a second job that loses the pull request race ends quietly', () => {
    const calls = fake({ attempt: 2, prCreate: () => { throw new Error('gh pr create failed: a pull request for branch "auto-revert/x" into branch "main" already exists'); } });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
    expect(calls.gh.some((args) => args[1] === 'merge' || args[0] === 'workflow')).toBe(false);
  });

  test('a dry run decides and changes nothing', () => {
    const calls = fake({ attempt: 2 });
    expect(handle(calls.io, 9, 2, true, [], '2026-11-06').kind).toBe('revert');
    expect(calls.git).toEqual([]);
    expect(calls.gh.filter((args) => (args[0] !== 'api' || args.includes('-X')) && args[1] !== 'list')).toEqual([]);
  });

  test('an already red main is left alone in both stages', () => {
    for (const attempt of [1, 2]) {
      const calls = fake({ attempt, parentConclusion: 'failure' });
      expect(handle(calls.io, 9, attempt, false, [], '2026-11-06').kind).toBe('skip');
      expect(calls.gh.filter((args) => args[0] === 'run' || args[1] === 'create')).toEqual([]);
    }
  });

  test('a repository that refuses workflow pull requests gets the compare link to open by hand', () => {
    const calls = fake({ attempt: 2, prCreate: () => { throw new Error('gh pr create failed: GitHub Actions is not permitted to create or approve pull requests'); } });
    expect(() => handle(calls.io, 9, 2, false, [], '2026-11-06')).toThrow(`compare/main...auto-revert/${SHA}?expand=1`);
  });

  test('a parent merged by the workflow token whose main run was dispatched still counts, and a bot-dispatched main run reverts on attempt 2 and enters merge-queue', () => {
    const calls = fake({ attempt: 2, runEvent: 'workflow_dispatch', runActor: 'github-actions[bot]', parentEvent: 'workflow_dispatch', parentActor: 'github-actions[bot]' });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06').kind).toBe('revert');
    expect(calls.gh).toContainEqual(['api', '-X', 'POST', 'repos/owner/repo/issues/50/labels', '-f', 'labels[]=merge-queue']);
    const humanDispatch = fake({ attempt: 2, runEvent: 'workflow_dispatch', runActor: 'someone-else' });
    expect(handle(humanDispatch.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
  });
});

describe('a failed merge queue batch', () => {
  const BATCH = 'd'.repeat(40);
  const BASE = 'a'.repeat(40);
  const PROBE = 'e'.repeat(40);
  const member = (index: number): string => String(index + 1).repeat(40);
  const head = (index: number): string => String(index + 5).repeat(40);
  const probeBranch = (index: number): string => bisectBranch({ commit: BATCH, workflowId: 5, index });
  type ProbeRun = { run_attempt: number; status: string; conclusion: string | null };
  const passed: ProbeRun = { run_attempt: 1, status: 'completed', conclusion: 'success' };
  const failedTwice: ProbeRun = { run_attempt: 2, status: 'completed', conclusion: 'failure' };
  interface BatchFake { io: Io; gh: string[][]; git: string[][]; logs: string[]; bodies: string[] }

  function batchFake(probes: Record<number, ProbeRun | undefined>, options: { titles?: Record<number, string>; existingPrs?: { number: number; state: string }[] } = {}): BatchFake {
    const calls: BatchFake = { gh: [], git: [], logs: [], bodies: [], io: undefined as unknown as Io };
    const pulls = [0, 1, 2].map((index) => ({ number: 21 + index, headSha: head(index) }));
    const mainRun = {
      id: 9, run_attempt: 2, name: 'Slow app scenarios', event: 'workflow_dispatch', head_branch: 'main', head_sha: BATCH, status: 'completed',
      conclusion: 'failure', workflow_id: 5, html_url: RUN_URL, path: '.github/workflows/slow-scenarios.yml', actor: { login: 'github-actions[bot]' },
    };
    const responses: Record<string, unknown> = {
      'actions/runs/9/attempts/2': mainRun,
      [`commits/${BATCH}`]: { sha: BATCH, parents: [{ sha: BASE }, { sha: member(2) }], commit: { message: `Merge queue batch: #21, #22, #23\n\n${formatStagingTrailers({ baseSha: BASE, pulls })}` } },
      [`actions/workflows/5/runs?branch=main&event=push&head_sha=${BASE}&per_page=5`]: { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/8', event: 'push', head_branch: 'main' }] },
      [`actions/workflows/5/runs?branch=main&head_sha=${BATCH}&per_page=10`]: { workflow_runs: [mainRun] },
      'issues/50/labels': [{ name: 'merge-queue' }],
    };
    for (const index of [0, 1, 2]) {
      const parent = index === 0 ? BASE : member(index - 1);
      responses[`commits/${member(index)}`] = { sha: member(index), parents: [{ sha: parent }, { sha: head(index) }], commit: { message: `Merge pull request #${21 + index} from feat/${index}\n\ntitle\n\nMerge-Queue-Pull: #${21 + index} ${head(index)}` } };
      responses[`pulls/${21 + index}`] = { number: 21 + index, title: options.titles?.[21 + index] ?? `feat(cli): change ${21 + index}`, head: { ref: `feat/${index}` } };
      responses[`actions/workflows/5/runs?branch=${encodeURIComponent(probeBranch(index))}&per_page=5`] = { workflow_runs: probes[index] === undefined ? [] : [probes[index]] };
    }
    calls.io = {
      repo: 'owner/repo',
      gh: (args) => {
        calls.gh.push(args);
        if (args[0] === 'api') {
          const path = (args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? '').replace('repos/owner/repo/', '');
          if (!(path in responses)) throw new Error(`unexpected api ${path}`);
          return JSON.stringify(responses[path]);
        }
        if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(options.existingPrs ?? []);
        if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/repo/pull/50\n';
        return '';
      },
      git: (args) => {
        calls.git.push(args);
        if (args[0] === 'ls-remote' && args.at(-1)?.includes('merge-queue/bisect/')) {
          return Object.keys(probes).map((index) => `${PROBE}\trefs/heads/${probeBranch(Number(index))}\n`).join('');
        }
        if (args[0] === 'rev-parse') return `tree-of-${args[1]}\n`;
        if (args[0] === 'commit-tree') return `${PROBE}\n`;
        return '';
      },
      failures: () => run().failures,
      log: (text) => calls.logs.push(text),
      writeFile: (name, text) => { calls.bodies.push(text); return `/tmp/${name}`; },
    };
    return calls;
  }

  const reverts = (calls: BatchFake): string[][] => calls.git.filter((args) => args[0] === 'revert');

  test('bisecting names the first pull request whose prefix fails, for every batch size and culprit, within ceil(log2(n)) probes', () => {
    for (let size = 2; size <= 16; size++) {
      for (let culprit = 0; culprit < size; culprit++) {
        const results = new Map<number, ProbeResult>();
        let verdict = decideBatch(size, results);
        while (verdict.kind === 'probe') {
          results.set(verdict.index, verdict.index < culprit ? 'passed' : 'failed');
          verdict = decideBatch(size, results);
        }
        expect(verdict).toEqual({ kind: 'culprit', index: culprit });
        expect(results.size).toBeLessThanOrEqual(Math.ceil(Math.log2(size)));
        expect(results.has(size - 1)).toBe(false);
      }
    }
    expect(decideBatch(4, new Map([[1, 'pending']]))).toEqual({ kind: 'wait', index: 1 });
    expect(parseBisectBranch(probeBranch(2))).toEqual({ commit: BATCH, workflowId: 5, index: 2 });
    expect(parseBisectBranch('merge-queue/staging')).toBeUndefined();
  });

  test('the first step pushes a probe of the first pull request on top of the commit before the batch and reverts nothing', () => {
    const calls = batchFake({});
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06')).toEqual({ kind: 'bisect', step: 'probe', index: 0 });
    expect(calls.git).toContainEqual(['rev-parse', `${member(0)}^{tree}`]);
    expect(calls.git.find((args) => args[0] === 'commit-tree')?.slice(0, 4)).toEqual(['commit-tree', `tree-of-${member(0)}^{tree}`, '-p', BASE]);
    expect(calls.git).toContainEqual(['push', 'origin', `${PROBE}:refs/heads/${probeBranch(0)}`]);
    expect(calls.gh).toContainEqual(['workflow', 'run', 'slow-scenarios.yml', '--repo', 'owner/repo', '--ref', probeBranch(0)]);
    expect(reverts(calls)).toEqual([]);
    expect(calls.gh.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  test('a probe in flight, or failed only once, is waited for', () => {
    for (const pending of [undefined, { run_attempt: 1, status: 'in_progress', conclusion: null }, { run_attempt: 1, status: 'completed', conclusion: 'failure' }, { run_attempt: 1, status: 'completed', conclusion: 'cancelled' }]) {
      const calls = batchFake({ 0: pending });
      expect(handle(calls.io, 9, 2, false, [], '2026-11-06')).toEqual({ kind: 'bisect', step: 'wait', index: 0 });
      expect(calls.git.filter((args) => args[0] !== 'ls-remote')).toEqual([]);
    }
  });

  test('once the probes single out one pull request, only its merge commit is reverted, never the batch', () => {
    const calls = batchFake({ 0: passed, 1: failedTwice });
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06')).toEqual({ kind: 'revert', title: 'revert: feat(cli): change 22', branch: `auto-revert/${member(1)}`, mainline: true });
    expect(reverts(calls)).toEqual([['revert', '--no-edit', '-m', '1', member(1)]]);
    expect(calls.git).toContainEqual(['switch', '-c', `auto-revert/${member(1)}`, 'origin/main']);
    expect(calls.gh.find((args) => args[1] === 'create')).toContain('revert: feat(cli): change 22');
    expect(calls.bodies[0]).toContain(`Reverts #22 (${member(1)})`);
    expect(calls.bodies[0]).toContain(`Landed in ${BATCH} with 2 other pull requests`);
    expect(calls.git).toContainEqual(['push', 'origin', '--delete', `refs/heads/${probeBranch(0)}`]);
    expect(calls.gh).toContainEqual(['api', '-X', 'POST', 'repos/owner/repo/issues/50/labels', '-f', 'labels[]=merge-queue']);

    const last = batchFake({ 0: passed, 1: passed });
    handle(last.io, 9, 2, false, [], '2026-11-06');
    expect(reverts(last)).toEqual([['revert', '--no-edit', '-m', '1', member(2)]]);
    const first = batchFake({ 0: failedTwice });
    handle(first.io, 9, 2, false, [], '2026-11-06');
    expect(reverts(first)).toEqual([['revert', '--no-edit', '-m', '1', member(0)]]);
  });

  test('a culprit that is itself a revert, or already has a revert pull request, is left to a person', () => {
    const isARevert = batchFake({ 0: failedTwice }, { titles: { 21: 'revert: feat(cli): earlier' } });
    expect(handle(isARevert.io, 9, 2, false, [], '2026-11-06').kind).toBe('skip');
    const closedByHand = batchFake({ 0: failedTwice }, { existingPrs: [{ number: 41, state: 'CLOSED' }] });
    expect(handle(closedByHand.io, 9, 2, false, [], '2026-11-06')).toEqual({ kind: 'skip', reason: 'revert pull request #41 already exists (closed)' });
    expect(reverts(isARevert)).toEqual([]);
    expect(reverts(closedByHand)).toEqual([]);
  });

  test('a dry run prints the bisect step or the revert and changes nothing', () => {
    for (const probes of [{}, { 0: passed, 1: failedTwice }]) {
      const calls = batchFake(probes);
      handle(calls.io, 9, 2, true, [], '2026-11-06');
      expect(calls.git.filter((args) => args[0] !== 'ls-remote')).toEqual([]);
      expect(calls.gh.filter((args) => args[0] !== 'api' && args[1] !== 'list')).toEqual([]);
      expect(calls.logs.join('\n')).toContain('Dry run, would');
    }
  });

  test('a finished probe reruns its first failure, and otherwise takes the next step for its batch', () => {
    const probeRun = (conclusion: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      name: 'Slow app scenarios', event: 'workflow_dispatch', head_branch: probeBranch(0), head_sha: PROBE, status: 'completed',
      conclusion, workflow_id: 5, html_url: RUN_URL, actor: { login: 'github-actions[bot]' }, ...extra,
    });
    const withProbe = (probes: Record<number, ProbeRun | undefined>, attempt: number, json: Record<string, unknown>): BatchFake => {
      const calls = batchFake(probes);
      const gh = calls.io.gh;
      calls.io.gh = (args) => (args[1] === `repos/owner/repo/actions/runs/70/attempts/${attempt}` ? JSON.stringify(json) : gh(args));
      return calls;
    };
    const firstFailure = withProbe({ 0: { run_attempt: 1, status: 'completed', conclusion: 'failure' } }, 1, probeRun('failure'));
    expect(handleProbe(firstFailure.io, 70, 1, false, [], '2026-11-06')).toEqual({ kind: 'rerun' });
    expect(firstFailure.gh).toContainEqual(['run', 'rerun', '70', '--failed', '--repo', 'owner/repo']);
    expect(firstFailure.git).toEqual([]);

    const passedProbe = withProbe({ 0: passed }, 1, probeRun('success'));
    expect(handleProbe(passedProbe.io, 70, 1, false, [], '2026-11-06')).toEqual({ kind: 'bisect', step: 'probe', index: 1 });
    expect(passedProbe.git).toContainEqual(['push', 'origin', `${PROBE}:refs/heads/${probeBranch(1)}`]);

    const secondFailure = withProbe({ 0: failedTwice }, 2, probeRun('failure'));
    expect(handleProbe(secondFailure.io, 70, 2, false, [], '2026-11-06').kind).toBe('revert');
    expect(reverts(secondFailure)).toEqual([['revert', '--no-edit', '-m', '1', member(0)]]);

    for (const stranger of [probeRun('success', { head_branch: 'merge-queue/staging' }), probeRun('success', { actor: { login: 'someone-else' } }), probeRun('cancelled')]) {
      const calls = withProbe({ 0: passed }, 1, stranger);
      expect(handleProbe(calls.io, 70, 1, false, [], '2026-11-06').kind).toBe('skip');
      expect(calls.git).toEqual([]);
    }
  });

  test('a single pull request landed by the merge queue is found through its trailer and reverted whole', () => {
    const message = `Merge pull request #12 from feat/host\n\nfeat(cli): host answers\n\n${formatStagingTrailers({ baseSha: PARENT, pulls: [{ number: 12, headSha: BRANCH_TIP }] })}`;
    const calls = batchFake({});
    const gh = calls.io.gh;
    const single: Record<string, unknown> = {
      'actions/runs/9/attempts/2': { name: 'Slow app scenarios', event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure', workflow_id: 5, html_url: RUN_URL, actor: { login: 'github-actions[bot]' } },
      [`commits/${SHA}`]: { sha: SHA, parents: [{ sha: PARENT }, { sha: BRANCH_TIP }], commit: { message } },
      'pulls/12': { number: 12, title: 'feat(cli): host answers', head: { ref: 'feat/host' } },
      [`actions/workflows/5/runs?branch=main&event=push&head_sha=${PARENT}&per_page=5`]: { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: RUN_URL, event: 'push', head_branch: 'main' }] },
    };
    calls.io.gh = (args) => {
      const path = (args.find((arg) => arg.startsWith('repos/owner/repo/')) ?? '').replace('repos/owner/repo/', '');
      if (args[0] === 'api' && path in single) { calls.gh.push(args); return JSON.stringify(single[path]); }
      return gh(args);
    };
    expect(handle(calls.io, 9, 2, false, [], '2026-11-06')).toEqual({ kind: 'revert', title: 'revert: feat(cli): host answers', branch: `auto-revert/${SHA}`, mainline: true });
    expect(reverts(calls)).toEqual([['revert', '--no-edit', '-m', '1', SHA]]);
    expect(calls.gh.some((args) => args.includes(`repos/owner/repo/commits/${SHA}/pulls`))).toBe(false);
  });
});

describe('a failed revert job', () => {
  test('files a Red on main flake issue naming both runs, or comments on the open one', () => {
    const gh: string[][] = [];
    const bodies: string[] = [];
    const io = {
      repo: 'owner/repo',
      gh: (args: string[]) => {
        gh.push(args);
        if (args[0] === 'issue' && args[1] === 'list') return '[]';
        return 'https://github.com/owner/repo/issues/77\n';
      },
      writeFile: (name: string, text: string) => {
        bodies.push(text);
        return `/tmp/${name}`;
      },
    };
    reportFailure(io, { laneRunUrl: 'https://github.com/owner/repo/actions/runs/3', failedRunUrl: RUN_URL, workflow: 'Slow app scenarios', headSha: SHA });
    expect(gh).toContainEqual(['issue', 'create', '--title', 'Red on main: Auto revert', '--label', 'flake', '--body-file', '/tmp/failure-body.md']);
    expect(bodies[0]).toContain('actions/runs/3');
    expect(bodies[0]).toContain(RUN_URL);
    expect(bodies[0]).toContain(SHA);
  });
});

describe('the auto revert workflow', () => {
  const workflowDir = resolve(import.meta.dir, '../../.github/workflows');
  const read = (file: string) => Bun.YAML.parse(readFileSync(resolve(workflowDir, file), 'utf8')) as {
    name: string;
    on: Record<string, Record<string, unknown> | null>;
    permissions: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      needs?: string | string[];
      concurrency?: Record<string, unknown>;
      permissions?: Record<string, string>;
      steps: { run?: string; env?: Record<string, string> }[];
    }>;
  };
  const lane = read('auto-revert.yml');

  test('it follows completed runs of the watched workflows on main', () => {
    expect(lane.on.workflow_run).toEqual({
      workflows: [read('build.yml').name, read('slow-scenarios.yml').name],
      types: ['completed'],
      branches: ['main', 'merge-queue/bisect/**'],
    });
    for (const name of ['confirm', 'revert']) expect(lane.jobs[name]?.if).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  test('a finished bisect probe, and nothing else, starts the bisect job with the permissions to push a probe or a revert', () => {
    const bisect = lane.jobs.bisect;
    expect(bisect?.if).toContain("startsWith(github.event.workflow_run.head_branch, 'merge-queue/bisect/')");
    expect(bisect?.if).toContain("github.event.workflow_run.actor.login == 'github-actions[bot]'");
    expect(bisect?.permissions).toEqual(lane.jobs.revert?.permissions);
    expect(bisect?.steps.at(-1)?.run).toBe('bun scripts/ci/auto-revert-github.ts bisect');
    expect(bisect?.steps.at(-1)?.env?.RUN_ATTEMPT).toBe('${{ github.event.workflow_run.run_attempt }}');
  });

  test('each job holds only the permissions its stage needs', () => {
    expect(lane.permissions).toEqual({ contents: 'read' });
    expect(lane.jobs.confirm?.permissions).toEqual({ actions: 'write', contents: 'read' });
    expect(lane.jobs.revert?.permissions).toEqual({ actions: 'write', contents: 'write', issues: 'write', 'pull-requests': 'write' });
    expect(lane.jobs.report?.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(lane.jobs.preview?.steps.at(-1)?.env?.DRY_RUN).toBe('true');
  });

  test('the revert job starts only from the attempt the workflow token reran', () => {
    expect(lane.jobs.confirm?.if).toContain('run_attempt == 1');
    expect(lane.jobs.revert?.if).toContain('run_attempt == 2');
    expect(lane.jobs.revert?.if).toContain("triggering_actor.login == 'github-actions[bot]'");
    for (const name of ['confirm', 'revert', 'preview']) expect(lane.jobs[name]?.steps.at(-1)?.run).toBe('bun scripts/ci/auto-revert-github.ts');
  });

  test('a failed revert job is reported, and two revert jobs for one commit run one at a time', () => {
    expect(lane.jobs.report?.needs).toEqual(['revert', 'bisect']);
    expect(lane.jobs.report?.if).toContain("needs.revert.result == 'failure'");
    expect(lane.jobs.report?.if).toContain("needs.bisect.result == 'failure'");
    expect(lane.jobs.report?.steps.at(-1)?.run).toBe('bun scripts/ci/auto-revert-github.ts report');
    expect(lane.jobs.revert?.concurrency).toEqual({ group: 'auto-revert-commit-${{ github.event.workflow_run.head_sha }}', 'cancel-in-progress': false });
  });

  test('Build & Test can be dispatched on a revert branch', () => {
    expect(Object.keys(read('build.yml').on)).toContain('workflow_dispatch');
  });
});
