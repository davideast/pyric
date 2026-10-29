import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FLAKE_PREFIX,
  MAX_FLAKE_ISSUES,
  RED_PREFIX,
  decide,
  describePlan,
  flakePrefix,
  namedFailedJobs,
  parseFailures,
  type AttemptReport,
  type Failure,
  type IssueAction,
} from './main-failure.ts';

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
  return actions.filter((action): action is IssueAction => action.kind === 'file-flake' || action.kind === 'file-red');
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

  test('attempt 3 does nothing, whatever it concluded', () => {
    for (const conclusion of ['failure', 'success']) {
      const plan = decide({
        current: attempt(3, conclusion),
        previous: attempt(2, 'failure'),
        openIssues: [{ number: 50, title: `${RED_PREFIX}abc fails x` }],
      });
      expect(plan.actions).toEqual([]);
    }
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
    jobs: Record<string, { permissions?: Record<string, string>; steps: { run?: string }[] }>;
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
});
