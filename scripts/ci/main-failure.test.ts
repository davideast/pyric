import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Gh } from './github-issues.ts';
import {
  FLAKE_PREFIX,
  MAX_FLAKE_ISSUES,
  RED_PREFIX,
  UNCONFIRMED_PREFIX,
  decide,
  describePlan,
  flakePrefix,
  namedFailedJobs,
  parseFailures,
  testFileStem,
  ATTEMPT_WAIT_MINUTES,
  checkoutResolver,
  collectAttempt,
  handleAttempt,
  waitForNextAttempt,
  type AttemptReport,
  type Context,
  type Failure,
  type IssueAction,
} from './main-failure.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RUN = 'https://github.com/davideast/pyric/actions/runs/7';
const SHA = '7b8dfc5701234567890abcdef1234567890abcd';
const TESTS_JOB = 'Build all packages + run tests (2/2)';
const SPARSE = 'test/serve/worker/client/rtdb-sparse-array-holes.test.ts > (unnamed)';

function attempt(attemptNumber: number, conclusion: string, failures: Failure[] = []): AttemptReport {
  return { runId: 7, attempt: attemptNumber, conclusion, headSha: SHA, url: `${RUN}/attempts/${attemptNumber}`, failures };
}

const hookTimeout: Failure = { job: TESTS_JOB, test: SPARSE, assertion: 'a beforeEach/afterEach hook timed out for this test.' };
const packaging: Failure = { job: 'Packaging gate', assertion: 'Error: packed @pyric/cli Firebase SDK import edges drifted' };

function issueActions(actions: ReturnType<typeof decide>['actions']): IssueAction[] {
  return actions.filter((action): action is IssueAction => action.kind.startsWith('file-'));
}

describe('deciding what a completed main run needs', () => {
  test('attempt 1 failed: rerun its failed jobs', () => {
    const plan = decide({ current: attempt(1, 'failure', [hookTimeout]), openIssues: [] });
    expect(plan.actions).toEqual([{ kind: 'rerun', runId: 7 }]);
  });

  test('attempt 1 timed out: rerun it too', () => {
    expect(decide({ current: attempt(1, 'timed_out'), openIssues: [] }).actions).toEqual([{ kind: 'rerun', runId: 7 }]);
  });

  test('attempt 2 passed: file one flake per test that failed in attempt 1', () => {
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout, packaging]),
      openIssues: [],
    });
    const filed = issueActions(plan.actions);
    expect(filed.map((action) => [action.kind, action.title])).toEqual([
      ['file-flake', `${FLAKE_PREFIX}\`${SPARSE}\``],
      ['file-flake', `${FLAKE_PREFIX}\`Packaging gate\``],
    ]);
    const body = filed[0]?.body ?? '';
    expect(body).toContain(`${RUN}/attempts/1`);
    expect(body).toContain(`${RUN}/attempts/2`);
    expect(body).toContain(SHA);
    expect(body).toContain('a beforeEach/afterEach hook timed out for this test.');
  });

  test('attempt 2 passed: a flake already open is commented on, and one test files once', () => {
    const prefix = flakePrefix(hookTimeout);
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout, { ...hookTimeout, job: 'other shard' }]),
      openIssues: [{ number: 41, title: prefix }],
    });
    expect(issueActions(plan.actions).map((action) => action.existing)).toEqual([41]);
  });

  test('a flake prefix does not match a longer test name that starts with it', () => {
    const longer = flakePrefix({ job: TESTS_JOB, test: `${SPARSE} and more` });
    expect(longer.startsWith(flakePrefix(hookTimeout))).toBe(false);
  });

  test('attempt 2 passed: at most MAX_FLAKE_ISSUES flakes are filed', () => {
    const many = Array.from({ length: MAX_FLAKE_ISSUES + 5 }, (_, index) => ({ job: TESTS_JOB, test: `t${index}` }));
    const plan = decide({ current: attempt(2, 'success'), previous: attempt(1, 'failure', many), openIssues: [] });
    expect(issueActions(plan.actions)).toHaveLength(MAX_FLAKE_ISSUES);
  });

  test('attempt 2 failed: file main is red with the commit, the failures and both attempts', () => {
    const plan = decide({
      current: attempt(2, 'failure', [hookTimeout]),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [],
    });
    const [red] = issueActions(plan.actions);
    expect(plan.actions).toHaveLength(1);
    expect(red?.kind).toBe('file-red');
    expect(red?.prefix).toBe(RED_PREFIX);
    expect(red?.title).toBe(`${RED_PREFIX}7b8dfc570 fails ${TESTS_JOB}`);
    expect(red?.existing).toBeUndefined();
    for (const text of [SHA, SPARSE, TESTS_JOB, `${RUN}/attempts/1`, `${RUN}/attempts/2`]) expect(red?.body).toContain(text);
  });

  test('attempt 2 failed while main is already red: comment on the open issue', () => {
    const plan = decide({
      current: attempt(2, 'failure', [packaging]),
      previous: attempt(1, 'failure', [packaging]),
      openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
    });
    expect(issueActions(plan.actions)[0]?.existing).toBe(50);
  });

  test('attempt 3 failing does nothing, so nothing is rerun twice', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
      const plan = decide({
        current: attempt(3, conclusion, [hookTimeout]),
        previous: attempt(2, 'failure', [hookTimeout]),
        openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
      });
      expect(plan.actions).toEqual([]);
    }
  });

  test('attempt 3 passing after main went red closes the red issue', () => {
    const plan = decide({
      current: attempt(3, 'success'),
      previous: attempt(2, 'failure'),
      openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
    });
    expect(plan.actions.map((action) => action.kind)).toEqual(['close-red']);
  });

  test('attempt 1 failed after a newer push: file it unconfirmed instead of rerunning', () => {
    const plan = decide({ current: attempt(1, 'failure', [hookTimeout]), openIssues: [], superseded: true });
    const [unconfirmed] = issueActions(plan.actions);
    expect(plan.actions).toHaveLength(1);
    expect(unconfirmed?.kind).toBe('file-unconfirmed');
    expect(unconfirmed?.title).toBe(`${UNCONFIRMED_PREFIX}7b8dfc570 failed ${TESTS_JOB}`);
    expect(unconfirmed?.body).toStartWith('Unconfirmed: ');
    expect(unconfirmed?.body).toContain('a newer push to main superseded it');
    for (const text of [SHA, SPARSE, `${RUN}/attempts/1`]) expect(unconfirmed?.body).toContain(text);
  });

  test('attempt 2 cancelled after attempt 1 failed: file attempt 1 unconfirmed', () => {
    const plan = decide({
      current: attempt(2, 'cancelled'),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [{ number: 60, title: `${UNCONFIRMED_PREFIX}abc failed x` }],
    });
    const [unconfirmed] = issueActions(plan.actions);
    expect(unconfirmed?.kind).toBe('file-unconfirmed');
    expect(unconfirmed?.existing).toBe(60);
    expect(unconfirmed?.body).toContain('the rerun of its failed jobs was cancelled');
    expect(unconfirmed?.body).toContain(SPARSE);
  });

  test('a flake comments on an open issue filed by hand that names its test file', () => {
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [
        { number: 50, title: `${RED_PREFIX}abc fails x`, body: `- \`${SPARSE}\`` },
        { number: 1593, title: 'rtdb-sparse-array-holes setup hook times out at 5 s on CI (flake)', body: '' },
      ],
    });
    expect(issueActions(plan.actions).map((action) => action.existing)).toEqual([1593]);
  });

  test('a flake finds a hand-filed issue that names its test file only in the body', () => {
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [{ number: 1263, title: 'Flaky CLI test: worker client', body: 'see rtdb-sparse-array-holes.test.ts' }],
    });
    expect(issueActions(plan.actions)[0]?.existing).toBe(1263);
  });

  test('the lane\'s own flake issue wins over a hand-filed one', () => {
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [
        { number: 1593, title: 'rtdb-sparse-array-holes flake' },
        { number: 1700, title: flakePrefix(hookTimeout) },
      ],
    });
    expect(issueActions(plan.actions)[0]?.existing).toBe(1700);
  });

  test('the test file stem drops the directory and the test extension', () => {
    expect(testFileStem(hookTimeout)).toBe('rtdb-sparse-array-holes');
    expect(testFileStem(packaging)).toBeUndefined();
  });

  test('a green run closes the open main is red issue, naming the run', () => {
    const plan = decide({ current: attempt(1, 'success'), openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }] });
    expect(plan.actions).toEqual([
      { kind: 'close-red', number: 50, body: `Build & Test passed on main at ${SHA}: ${RUN}/attempts/1\n` },
    ]);
  });

  test('a green rerun files its flakes and closes main is red', () => {
    const plan = decide({
      current: attempt(2, 'success'),
      previous: attempt(1, 'failure', [hookTimeout]),
      openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
    });
    expect(plan.actions.map((action) => action.kind)).toEqual(['file-flake', 'close-red']);
  });

  test('a green run with nothing open does nothing', () => {
    expect(decide({ current: attempt(1, 'success'), openIssues: [] }).actions).toEqual([]);
  });

  test('a cancelled run does nothing', () => {
    for (const attemptNumber of [1, 2]) {
      const plan = decide({
        current: attempt(attemptNumber, 'cancelled'),
        openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
      });
      expect(plan.actions).toEqual([]);
    }
  });

  test('attempt 2 passing after a cancelled attempt 1 files no flakes', () => {
    const plan = decide({ current: attempt(2, 'success'), previous: attempt(1, 'cancelled'), openIssues: [] });
    expect(plan.actions).toEqual([]);
  });

  test('the printed plan names the attempt, the reason and each action', () => {
    const current = attempt(1, 'failure');
    const printed = describePlan(current, decide({ current, openIssues: [] }));
    expect(printed).toBe([
      `Run 7 attempt 1 (failure, 7b8dfc570): ${RUN}/attempts/1`,
      'attempt 1 failed: rerun its failed jobs once',
      '- Rerun the failed jobs of run 7',
    ].join('\n'));
  });
});

// Excerpts of real Build & Test job logs from main.
const HOOK_TIMEOUT_LOG = [
  '2026-10-29T03:03:58.7850000Z ##[group]test/serve/worker/client/rtdb-references.test.ts:',
  '2026-10-29T03:03:58.7851000Z (pass) RTDB worker references > validates ref and child paths [4.00ms]',
  '2026-10-29T03:03:58.7852000Z ##[endgroup]',
  '2026-10-29T03:03:58.7853000Z ##[group]test/serve/worker/client/rtdb-sparse-array-holes.test.ts:',
  '2026-10-29T03:03:58.7854827Z (fail) (unnamed) [5001.01ms]',
  '2026-10-29T03:03:58.7855000Z   ^ a beforeEach/afterEach hook timed out for this test.',
  '2026-10-29T03:03:58.7856000Z ##[endgroup]',
  '2026-10-29T03:04:19.1320000Z 1 tests failed:',
  '2026-10-29T03:04:19.1328008Z (fail) (unnamed) [5001.01ms]',
  '2026-10-29T03:04:19.2645009Z ##[error]Process completed with exit code 1.',
].join('\n');

const ASSERTION_LOG = [
  '2026-10-27T07:55:11.8897130Z ##[group]test/apps/unreaped-exit.test.ts:',
  '2026-10-27T07:55:11.8917476Z (pass) reading an unreaped exit from /proc > the fields come from their places',
  '2026-10-27T07:55:12.9082460Z Error: noise a passing test logged',
  '2026-10-27T07:55:12.9082461Z (pass) reading an unreaped exit from /proc > a waitpid status gives an exit code',
  '2026-10-27T07:55:12.9084602Z 57 |     expect(unreapedExit(await zombie(3))).toEqual({ code: 3, signal: null });',
  '2026-10-27T07:55:12.9084884Z                                                ^',
  '2026-10-27T07:55:12.9085101Z error: expect(received).toEqual(expected)',
  '2026-10-27T07:55:12.9086389Z + undefined',
  '2026-10-27T07:55:12.9087182Z       at <anonymous> (/home/runner/work/pyric/pyric/test/apps/unreaped-exit.test.ts:57:43)',
  '2026-10-27T07:55:12.9102860Z ##[error]- {',
  '      at <anonymous> (/home/runner/work/pyric/pyric/test/apps/unreaped-exit.test.ts:57:43)',
  '2026-10-27T07:55:12.9108250Z (fail) reading an unreaped exit from /proc > a running process has no exit, and a zombie has its own [1017.02ms]',
  '2026-10-27T07:55:12.9108941Z (pass) reading an unreaped exit from /proc > a zombie leader thread has not exited',
  '2026-10-27T07:55:52.7358899Z 1 tests failed:',
].join('\n');

const PACKAGING_LOG = [
  '2026-10-28T17:58:39.3585106Z   ✓ packed CLI dependency closure installs without firebase or firebase-admin',
  '2026-10-28T17:58:41.8636408Z         ^',
  '2026-10-28T17:58:41.8637150Z Error: packed @pyric/cli Firebase SDK import edges drifted',
  '2026-10-28T17:58:41.8642343Z     at fail (file:///home/runner/work/pyric/pyric/scripts/audit-packed-cli.mjs:118:9)',
  '2026-10-28T17:58:41.8910668Z ✗ packaging gate FAILED — work dir preserved for debugging:',
  '2026-10-28T17:58:41.8920000Z error: script "test:packaging" exited with code 1',
  '2026-10-28T17:58:41.8929866Z ##[error]Process completed with exit code 1.',
].join('\n');

describe('reading the failures from a job log', () => {
  test('a hook timeout names the file and the note bun printed after it', () => {
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG)).toEqual([hookTimeout]);
  });

  test('a failed assertion names the file, the test, the error line and where it was thrown', () => {
    expect(parseFailures('App scenarios', ASSERTION_LOG)).toEqual([{
      job: 'App scenarios',
      test: 'test/apps/unreaped-exit.test.ts > reading an unreaped exit from /proc > a running process has no exit, and a zombie has its own',
      assertion: 'error: expect(received).toEqual(expected) (at test/apps/unreaped-exit.test.ts:57:43)',
    }]);
  });

  test('a log that names no test falls back to the job and its last error', () => {
    expect(parseFailures('Packaging gate', PACKAGING_LOG)).toEqual([{
      job: 'Packaging gate',
      assertion: 'Error: packed @pyric/cli Firebase SDK import edges drifted (at scripts/audit-packed-cli.mjs:118:9)',
    }]);
  });

  test('a log with no error at all falls back to the Actions annotation', () => {
    expect(parseFailures('Lint', '##[error]Process completed with exit code 2.')).toEqual([
      { job: 'Lint', assertion: 'Process completed with exit code 2.' },
    ]);
  });

  test('colour codes do not hide a failure', () => {
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG.replace('(fail)', '\u001b[31m(fail)\u001b[0m'))).toEqual([hookTimeout]);
  });

  test('an error a passing test printed is not the assertion of the next failure', () => {
    const log = [
      '##[group]test/a.test.ts:',
      'Error: noise a passing test logged',
      '(pass) a > logs noise',
      '(fail) a > times out in a hook [5000.00ms]',
      '  ^ a beforeEach/afterEach hook timed out for this test.',
      '##[endgroup]',
    ].join('\n');
    expect(parseFailures('job', log)).toEqual([
      { job: 'job', test: 'test/a.test.ts > a > times out in a hook', assertion: 'a beforeEach/afterEach hook timed out for this test.' },
    ]);
  });

  test('a failure after a group closes is not credited to that group\'s file', () => {
    const log = ['##[group]test/a.test.ts:', '(pass) a > passes', '##[endgroup]', '(fail) loose > fails'].join('\n');
    expect(parseFailures('job', log)).toEqual([{ job: 'job', test: 'loose > fails' }]);
  });

  test('a test that fails twice in one log keeps its first failure', () => {
    const log = [
      '##[group]test/a.test.ts:',
      'error: first',
      '(fail) a > fails',
      '##[endgroup]',
      '##[group]test/a.test.ts:',
      'error: second',
      '(fail) a > fails',
      '##[endgroup]',
    ].join('\n');
    expect(parseFailures('job', log)).toEqual([{ job: 'job', test: 'test/a.test.ts > a > fails', assertion: 'error: first' }]);
  });

  test('a test path is placed in the package directory that holds it', () => {
    const resolveFile = (file: string) => `packages/cli/${file}`;
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG, resolveFile)).toEqual([{ ...hookTimeout, test: `packages/cli/${SPARSE}` }]);
  });

  test('the checkout resolver finds the one directory that holds a path, and leaves the rest alone', () => {
    const resolveFile = checkoutResolver(ROOT);
    expect(resolveFile('test/serve/worker/client/rtdb-sparse-array-holes.test.ts'))
      .toBe('packages/cli/test/serve/worker/client/rtdb-sparse-array-holes.test.ts');
    expect(resolveFile('test/apps/unreaped-exit.test.ts')).toBe('test/apps/unreaped-exit.test.ts');
    expect(resolveFile('test/no-such-file.test.ts')).toBe('test/no-such-file.test.ts');
  });

  test('the summary job drops out when another job failed, and stays when it is the only one', () => {
    expect(namedFailedJobs([TESTS_JOB, 'CI / required'])).toEqual([TESTS_JOB]);
    expect(namedFailedJobs(['CI / required'])).toEqual(['CI / required']);
  });
});

describe('the main failure workflow', () => {
  const workflowDir = resolve(import.meta.dir, '../../.github/workflows');
  const read = (file: string) => Bun.YAML.parse(readFileSync(resolve(workflowDir, file), 'utf8')) as {
    name: string;
    on: Record<string, Record<string, unknown> | null>;
    permissions: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      permissions?: Record<string, string>;
      steps: { run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
    }>;
  };
  const lane = read('main-failure.yml');

  test('it follows completed Build & Test runs on main, and a dispatch, never a pull request', () => {
    expect(Object.keys(lane.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(lane.on.workflow_run).toEqual({ workflows: [read('build.yml').name], types: ['completed'], branches: ['main'] });
  });

  test('a dispatch defaults to a dry run', () => {
    const inputs = lane.on.workflow_dispatch?.inputs as Record<string, { default?: unknown; required?: boolean }>;
    expect(inputs.dry_run?.default).toBe(true);
    expect(inputs.run_id?.required).toBe(true);
  });

  test('it holds only the permissions it needs', () => {
    expect(lane.permissions).toEqual({ contents: 'read' });
    expect(lane.jobs.classify?.permissions).toEqual({ actions: 'write', contents: 'read', issues: 'write' });
  });

  test('it runs this script', () => {
    expect(lane.jobs.classify?.steps.some((step) => step.run === 'bun scripts/ci/main-failure.ts')).toBe(true);
  });

  test('it handles only push runs, and skips an attempt this lane reran itself', () => {
    const guard = (lane.jobs.classify?.if ?? '').replace(/\s+/g, ' ').trim();
    expect(guard).toBe([
      "github.event_name == 'workflow_dispatch' ||",
      "(github.event.workflow_run.event == 'push' &&",
      '(github.event.workflow_run.run_attempt == 1 ||',
      "github.event.workflow_run.triggering_actor.login != 'github-actions[bot]'))",
    ].join(' '));
  });

  test('only a dispatch can ask for a dry run, and the checkout keeps no token', () => {
    const step = lane.jobs.classify?.steps.find((candidate) => candidate.run === 'bun scripts/ci/main-failure.ts');
    expect(step?.env?.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}");
    const checkout = lane.jobs.classify?.steps.find((candidate) => candidate.uses === 'actions/checkout@v4');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The GitHub side, against a fake gh

const BUILD_PATH = '.github/workflows/build.yml';

interface FakeRepo {
  /** The conclusion of each attempt, by number. Attempt 2 appears after a rerun. */
  conclusions: Record<number, string>;
  latest: number;
  mainHead: string;
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
  if (path === 'branches/main') return { commit: { sha: repo.mainHead } };
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
    const issues = [{ number: 1593, title: 'rtdb-sparse-array-holes setup hook times out at 5 s on CI (flake)', body: '' }];
    const fake = fakeGitHub(fakeRepo({ issues }));
    await handleAttempt(fake.context, 7, 1);
    const writes = fake.calls.filter((call) => call[0] === 'issue' && call[1] !== 'list').map((call) => call.slice(0, 3));
    expect(writes).toEqual([['issue', 'comment', '1593']]);
  });

  test('anything but a push run of Build & Test on main is refused before it is rerun', async () => {
    for (const repo of [fakeRepo({ event: 'pull_request' }), fakeRepo({ path: '.github/workflows/other.yml' })]) {
      const fake = fakeGitHub(repo);
      await expect(handleAttempt(fake.context, 7, 1)).rejects.toThrow('only push runs of .github/workflows/build.yml on main');
      expect(hasRerun(fake.calls)).toBe(false);
    }
  });
});
