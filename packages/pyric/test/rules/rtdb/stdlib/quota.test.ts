import { describe, expect, test } from 'bun:test';
import { all, authenticated, ownPath, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { timing, lifecycle } = rtdbStdlib;

// Stored window starts far in the past and far in the future decide each
// case whatever the clock reads when the test runs.
const PAST = 1_000_000_000_000;
const FUTURE = 99_999_999_999_999;
const SV = { '.sv': 'timestamp' };

const scenario: StdlibScenario = {
  paths: {
    '/posts/$postId': {
      write: all(authenticated(), lifecycle.createOnly()),
      validate: timing.countedInSameWrite(2, ['quota', { $: 'auth.uid' }]),
    },
    // At most 2 posts per minute per user. A deleted quota would reset it.
    '/quota/$uid': {
      write: all(ownPath('$uid'), lifecycle.noDelete()),
      validate: timing.windowedQuota(2, 60_000),
    },
  },
  cases: [],
};

const quota = (windowStart: number, count: number) => ({ quota: { alice: { windowStart, count } } });

scenario.cases.push(
  { description: 'a first post opens the window', expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p1': 'x', 'quota/alice': { windowStart: SV, count: 1 } } },
  { description: 'a second post inside the window', expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', data: quota(FUTURE, 1), newData: { 'posts/p2': 'x', 'quota/alice/count': 2 } },
  { description: 'a third post inside the window', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', data: quota(FUTURE, 2), newData: { 'posts/p3': 'x', 'quota/alice/count': 3 } },
  { description: 'a post after the window opens a new one', expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', data: quota(PAST, 2), newData: { 'posts/p4': 'x', 'quota/alice': { windowStart: SV, count: 1 } } },
  { description: 'a new window opened before the old one ends', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', data: quota(FUTURE, 2), newData: { 'posts/p5': 'x', 'quota/alice': { windowStart: SV, count: 1 } } },
  { description: 'a window opened with a client clock time', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p6': 'x', 'quota/alice': { windowStart: PAST, count: 1 } } },
  { description: 'a count that skips a step', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', data: quota(FUTURE, 0), newData: { 'posts/p7': 'x', 'quota/alice/count': 2 } },
  { description: 'a post that leaves the quota unchanged', expectation: 'DENY', operation: 'write', path: '/posts/p8', auth: 'alice', data: quota(FUTURE, 1), newData: 'x' },
  { description: 'a post counted on another user quota', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p9': 'x', 'quota/bob': { windowStart: SV, count: 1 } } },
  { description: 'a user deletes their quota', expectation: 'DENY', operation: 'write', path: '/quota/alice', auth: 'alice', data: quota(FUTURE, 2), newData: null },
);

describe('rtdbStdlib.timing windowed quota', () => {
  test('windowedQuota checks the stored window before computing with it', () => {
    const rule = timing.windowedQuota(2, 60_000);
    expect(rule).toContain("data.child('windowStart').isNumber() && now >= data.child('windowStart').val() + 60000");
    expect(rule).toContain("newData.child('count').val() <= 2");
  });

  test('builders refuse arguments they cannot compile', () => {
    expect(() => timing.windowedQuota(0, 1000)).toThrow();
    expect(() => timing.windowedQuota(2, Number.NaN)).toThrow();
    expect(() => timing.countedInSameWrite(-1, ['quota'])).toThrow();
  });

  runScenario(scenario);
});
