import { describe, expect, test } from 'bun:test';
import { MAX_FLAKE_ISSUES, decide, type IssueAction } from './decide.ts';
import { FLAKE_PREFIX, RED_PREFIX, UNCONFIRMED_PREFIX, describePlan, flakePrefix, testFileStem } from './issue-text.ts';
import { RUN, SHA, SPARSE, TESTS_JOB, attempt, hookTimeout, packaging } from './test-fixtures.ts';

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
