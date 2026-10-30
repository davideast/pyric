import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gh } from '../../ci/github-issues.ts';
import { ATTEMPT_WAIT_MINUTES, collectAttempt, handleAttempt, waitForNextAttempt, type Context } from './github.ts';
import { FLAKE_PREFIX, RED_PREFIX, UNCONFIRMED_PREFIX } from './issue-text.ts';
import { HOOK_TIMEOUT_LOG, RUN, SHA, SPARSE, TESTS_JOB, hookTimeout } from './test-fixtures.ts';

const BUILD_PATH = '.github/workflows/build.yml';

interface FakeRepo {
  /** The conclusion of each attempt, by number. Attempt 2 appears after a rerun. */
  conclusions: Record<number, string>;
  latest: number;
  mainHead: string;
  /** Reads of main that still return `mainHead`; later reads return a newer commit. */
  headMovesAfter?: number;
  /** Other push runs of the workflow, newest first. */
  otherRuns: { id: number; status: string }[];
  issues: { number: number; title: string; body?: string }[];
  event: string;
  path: string;
  /** How many polls of the run fail after the rerun, to test the retry. */
  pollFailures: number;
  /** Thrown for a log read that passes --allow-escape-sequences. */
  escapeFlagError?: string;
}

function fakeRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    conclusions: { 1: 'failure', 2: 'success' },
    latest: 1,
    mainHead: SHA,
    otherRuns: [],
    issues: [],
    event: 'push',
    path: BUILD_PATH,
    pollFailures: 0,
    ...overrides,
  };
}

function runJson(repo: FakeRepo, attemptNumber: number) {
  return {
    id: 7, run_attempt: attemptNumber, status: 'completed', conclusion: repo.conclusions[attemptNumber] ?? null,
    head_sha: SHA, head_branch: 'main', event: repo.event, path: repo.path, workflow_id: 99,
    created_at: '2026-10-29T02:58:35Z', updated_at: '2026-10-29T03:09:52Z', html_url: RUN,
  };
}

function otherRunJson(other: { id: number; status: string }) {
  return { ...runJson(fakeRepo(), 1), id: other.id, status: other.status, head_sha: 'f'.repeat(40) };
}

const JOBS = [
  { id: 11, name: TESTS_JOB, fails: true },
  { id: 12, name: 'CI / required', fails: true },
  { id: 13, name: 'Packaging gate', fails: false },
];

function jobsJson(conclusion: string | undefined) {
  return { jobs: JOBS.map((job) => ({ id: job.id, name: job.name, conclusion: job.fails ? conclusion : 'success' })) };
}

interface Fake {
  context: Context;
  calls: string[][];
  logged: string[];
  sleeps: number;
}

function hasRerun(calls: string[][]): boolean {
  return calls.some((call) => call[0] === 'run' && call[1] === 'rerun');
}

function mainHeadNow(repo: FakeRepo): string {
  if (repo.headMovesAfter === undefined) return repo.mainHead;
  if (repo.headMovesAfter > 0) {
    repo.headMovesAfter -= 1;
    return repo.mainHead;
  }
  return 'e'.repeat(40);
}

function fakeApi(repo: FakeRepo, calls: string[][], path: string): unknown {
  const attemptJobs = /^actions\/runs\/7\/attempts\/(\d+)\/jobs/.exec(path);
  if (attemptJobs) return jobsJson(repo.conclusions[Number(attemptJobs[1])]);
  const attemptRun = /^actions\/runs\/7\/attempts\/(\d+)$/.exec(path);
  if (attemptRun) return runJson(repo, Number(attemptRun[1]));
  const pollFails = path === 'actions/runs/7' && repo.pollFailures > 0 && hasRerun(calls);
  if (pollFails) {
    repo.pollFailures -= 1;
    throw new Error('gh api failed: HTTP 502');
  }
  if (path === 'actions/runs/7') return runJson(repo, repo.latest);
  if (path === 'branches/main') return { commit: { sha: mainHeadNow(repo) } };
  if (path.startsWith('actions/workflows/99/runs')) return { workflow_runs: [...repo.otherRuns.map(otherRunJson), runJson(repo, 1)] };
  throw new Error(`unexpected api path ${path}`);
}

function fakeGh(repo: FakeRepo, calls: string[][]): Gh {
  return (args) => {
    calls.push(args);
    const [command, sub] = args;
    const path = args.at(-1) ?? '';
    const readsLog = command === 'api' && path.endsWith('/logs');
    if (readsLog && args.includes('--allow-escape-sequences') && repo.escapeFlagError) throw new Error(repo.escapeFlagError);
    if (readsLog) return HOOK_TIMEOUT_LOG;
    if (command === 'api') return JSON.stringify(fakeApi(repo, calls, path.replace(/^repos\/o\/r\//, '')));
    if (command === 'issue' && sub === 'list') return JSON.stringify(repo.issues);
    if (command === 'issue' && sub === 'create') return 'https://github.com/o/r/issues/900\n';
    if (command === 'issue' && sub === 'comment') return 'https://github.com/o/r/issues/1#issuecomment-1\n';
    if (command === 'run' && sub === 'rerun') repo.latest = 2;
    return '';
  };
}

/** A context whose clock moves `clockStep` milliseconds on every sleep. */
function fakeGitHub(repo: FakeRepo, clockStep = 0): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'main-failure-test-'));
  let clock = 0;
  const fake: Fake = {
    calls: [],
    logged: [],
    sleeps: 0,
    context: {
      gh: () => '',
      repo: 'o/r',
      log: (text) => fake.logged.push(text),
      sleep: async () => {
        fake.sleeps += 1;
        clock += clockStep;
      },
      now: () => clock,
      resolveFile: (file) => `packages/cli/${file}`,
      tempDir: () => dir,
    },
  };
  fake.context.gh = fakeGh(repo, fake.calls);
  return fake;
}

function issueCreates(calls: string[][]): string[] {
  return calls.filter((call) => call[0] === 'issue' && call[1] === 'create').map((call) => call[call.indexOf('--title') + 1] ?? '');
}

function logReads(calls: string[][]): string[][] {
  return calls.filter((call) => (call.at(-1) ?? '').endsWith('/logs'));
}

describe('collecting an attempt', () => {
  test('reads each failed job but the summary job, with the escape flag, and names the package', () => {
    const fake = fakeGitHub(fakeRepo());
    expect(collectAttempt(fake.context, 7, 1)).toEqual({
      runId: 7, attempt: 1, conclusion: 'failure', headSha: SHA, url: `${RUN}/attempts/1`,
      failures: [{ ...hookTimeout, test: `packages/cli/${SPARSE}` }],
    });
    expect(logReads(fake.calls)).toEqual([['api', '--allow-escape-sequences', 'repos/o/r/actions/jobs/11/logs']]);
  });

  test('retries a log read without the escape flag on a gh that does not know it', () => {
    const fake = fakeGitHub(fakeRepo({ escapeFlagError: 'gh api failed: unknown flag: --allow-escape-sequences' }));
    expect(collectAttempt(fake.context, 7, 1).failures).toHaveLength(1);
    expect(logReads(fake.calls).at(-1)).toEqual(['api', 'repos/o/r/actions/jobs/11/logs']);
  });

  test('a passing attempt reads no logs', () => {
    const fake = fakeGitHub(fakeRepo({ conclusions: { 1: 'success' } }));
    expect(collectAttempt(fake.context, 7, 1).failures).toEqual([]);
    expect(logReads(fake.calls)).toEqual([]);
  });

  test('a response without the expected fields is refused', () => {
    const fake = fakeGitHub(fakeRepo());
    const broken: Context = { ...fake.context, gh: () => '{"id": 7}' };
    expect(() => collectAttempt(broken, 7, 1)).toThrow('field run_attempt is not a number');
  });
});

describe('waiting for the rerun', () => {
  test('returns once the next attempt completes, retrying a failed poll', async () => {
    const fake = fakeGitHub(fakeRepo({ latest: 2, pollFailures: 1 }));
    fake.calls.push(['run', 'rerun']);
    await waitForNextAttempt(fake.context, 7, 1);
    expect(fake.sleeps).toBe(2);
  });

  test('gives up after the wait, naming it', async () => {
    const fake = fakeGitHub(fakeRepo({ latest: 1 }), 31 * 60 * 1000);
    await expect(waitForNextAttempt(fake.context, 7, 1)).rejects.toThrow(`within ${ATTEMPT_WAIT_MINUTES} minutes`);
    expect(fake.sleeps).toBe(3);
  });
});

describe('handling a completed attempt', () => {
  test('attempt 1 failed at the head of main: rerun, wait, then file the flake attempt 2 proves', async () => {
    const fake = fakeGitHub(fakeRepo());
    await handleAttempt(fake.context, 7, 1);
    expect(fake.calls).toContainEqual(['run', 'rerun', '7', '--failed', '--repo', 'o/r']);
    expect(issueCreates(fake.calls)).toEqual([`${FLAKE_PREFIX}\`packages/cli/${SPARSE}\``]);
    expect(fake.logged.map((text) => text.split('\n')[1])).toEqual([
      'attempt 1 failed: rerun its failed jobs once',
      'attempt 2 passed after attempt 1 failed: the failures were flakes',
    ]);
  });

  test('attempt 2 failing again files main is red', async () => {
    const fake = fakeGitHub(fakeRepo({ conclusions: { 1: 'failure', 2: 'failure' } }));
    await handleAttempt(fake.context, 7, 1);
    expect(issueCreates(fake.calls)).toEqual([`${RED_PREFIX}7b8dfc570 fails ${TESTS_JOB}`]);
  });

  test('a newer commit on main: no rerun, the failures are filed unconfirmed', async () => {
    const fake = fakeGitHub(fakeRepo({ mainHead: 'f'.repeat(40) }));
    await handleAttempt(fake.context, 7, 1);
    expect(hasRerun(fake.calls)).toBe(false);
    expect(issueCreates(fake.calls)).toEqual([`${UNCONFIRMED_PREFIX}7b8dfc570 failed ${TESTS_JOB}`]);
  });

  test('a newer push run in progress: no rerun', async () => {
    const fake = fakeGitHub(fakeRepo({ otherRuns: [{ id: 8, status: 'in_progress' }] }));
    await handleAttempt(fake.context, 7, 1);
    expect(hasRerun(fake.calls)).toBe(false);
    expect(issueCreates(fake.calls)).toEqual([`${UNCONFIRMED_PREFIX}7b8dfc570 failed ${TESTS_JOB}`]);
  });

  test('a flake whose test file a hand-filed issue names is commented there, not retitled', async () => {
    const issues = [{ number: 1593, title: 'Flaky worker client', body: `packages/cli/${SPARSE.split(' > ')[0]} times out at 5 s` }];
    const fake = fakeGitHub(fakeRepo({ issues }));
    await handleAttempt(fake.context, 7, 1);
    const writes = fake.calls.filter((call) => call[0] === 'issue' && call[1] !== 'list').map((call) => call.slice(0, 3));
    expect(writes).toEqual([['issue', 'comment', '1593']]);
  });

  test('a push that lands while the attempt is read: the check right before the rerun files it unconfirmed', async () => {
    const fake = fakeGitHub(fakeRepo({ headMovesAfter: 1 }));
    await handleAttempt(fake.context, 7, 1);
    expect(hasRerun(fake.calls)).toBe(false);
    expect(fake.calls.filter((call) => call.at(-1) === 'repos/o/r/branches/main')).toHaveLength(2);
    expect(issueCreates(fake.calls)).toEqual([`${UNCONFIRMED_PREFIX}7b8dfc570 failed ${TESTS_JOB}`]);
    expect(fake.logged.map((text) => text.split('\n')[1])).toEqual([
      'attempt 1 failed: rerun its failed jobs once',
      'attempt 1 failed, but rerunning it would share the concurrency group with a newer push run: filed unconfirmed',
    ]);
  });

  test('a green run closes the open red and unconfirmed issues', async () => {
    const issues = [
      { number: 50, title: `${RED_PREFIX}abc fails x` },
      { number: 60, title: `${UNCONFIRMED_PREFIX}abc failed x` },
    ];
    const fake = fakeGitHub(fakeRepo({ conclusions: { 1: 'success' }, issues }));
    await handleAttempt(fake.context, 7, 1);
    const closes = fake.calls.filter((call) => call[0] === 'issue' && call[1] === 'close').map((call) => call[2]);
    expect(closes).toEqual(['50', '60']);
  });

  test('anything but a push run of Build & Test on main is refused before it is rerun', async () => {
    for (const repo of [fakeRepo({ event: 'pull_request' }), fakeRepo({ path: '.github/workflows/other.yml' })]) {
      const fake = fakeGitHub(repo);
      await expect(handleAttempt(fake.context, 7, 1)).rejects.toThrow('only push runs of .github/workflows/build.yml on main');
      expect(hasRerun(fake.calls)).toBe(false);
    }
  });
});
