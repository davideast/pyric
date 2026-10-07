import { describe, expect, test } from 'bun:test';
import { all, authenticated, ownPath, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { timing, lifecycle } = rtdbStdlib;

// Stored times far in the past and far in the future decide the cooldown
// whatever the clock reads when the test runs.
const PAST = 1_000_000_000_000;
const FUTURE = 99_999_999_999_999;

const scenario: StdlibScenario = {
  paths: {
    '/posts/$postId': {
      read: authenticated(),
      write: authenticated(),
      validate: timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }]),
    },
    '/lastPost/$uid': {
      // A deleted stamp would reset the cooldown, so the owner may not delete it.
      write: all(ownPath('$uid'), lifecycle.noDelete()),
      validate: timing.throttled(60_000),
    },
    '/events/$id': {
      write: authenticated(),
      children: {
        '/at': { validate: timing.notInFuture() },
        '/createdAt': { validate: timing.isServerTimestamp() },
      },
    },
    '/rooms/$id': {
      write: all(authenticated(), timing.cooldownElapsed(60_000, 'lastMoveAt'), timing.isServerTimestamp('lastMoveAt')),
    },
  },
  cases: [],
};

scenario.cases.push(
  { description: 'a first post with its stamp in the same write', expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p1': 'hello', 'lastPost/alice': 0 }, serverTime: ['lastPost/alice'] },
  { description: 'a post once the cooldown has passed', expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', data: { lastPost: { alice: PAST } }, newData: { 'posts/p2': 'hello', 'lastPost/alice': 0 }, serverTime: ['lastPost/alice'] },
  { description: 'a post inside the cooldown', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', data: { lastPost: { alice: FUTURE } }, newData: { 'posts/p2': 'hello', 'lastPost/alice': 0 }, serverTime: ['lastPost/alice'] },
  { description: 'a post without a stamp', expectation: 'DENY', operation: 'write', path: '/posts/p3', auth: 'alice', newData: 'hello' },
  { description: 'a post stamped with a client clock time', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p4': 'hello', 'lastPost/alice': 5 } },
  { description: 'a post stamped under another user', expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', newData: { 'posts/p5': 'hello', 'lastPost/bob': 0 }, serverTime: ['lastPost/bob'] },
  { description: 'a user deletes their stamp to reset the cooldown', expectation: 'DENY', operation: 'write', path: '/lastPost/alice', auth: 'alice', data: { lastPost: { alice: FUTURE } }, newData: null },
  { description: 'an event time in the past', expectation: 'ALLOW', operation: 'write', path: '/events/e1/at', auth: 'alice', newData: PAST },
  { description: 'an event time in the future', expectation: 'DENY', operation: 'write', path: '/events/e1/at', auth: 'alice', newData: FUTURE },
  { description: 'an event time written as a string', expectation: 'DENY', operation: 'write', path: '/events/e1/at', auth: 'alice', newData: 'now' },
  { description: 'a creation time from the server', expectation: 'ALLOW', operation: 'write', path: '/events/e1/createdAt', auth: 'alice', newData: 0, serverTime: [''] },
  { description: 'a creation time from the client', expectation: 'DENY', operation: 'write', path: '/events/e1/createdAt', auth: 'alice', newData: PAST },
  { description: 'a room move once its cooldown has passed', expectation: 'ALLOW', operation: 'update', path: '/rooms/r1', auth: 'alice', data: { rooms: { r1: { lastMoveAt: PAST } } }, newData: { lastMoveAt: 0 }, serverTime: ['lastMoveAt'] },
  { description: 'a room move inside its cooldown', expectation: 'DENY', operation: 'update', path: '/rooms/r1', auth: 'alice', data: { rooms: { r1: { lastMoveAt: FUTURE } } }, newData: { lastMoveAt: 0 }, serverTime: ['lastMoveAt'] },
  { description: 'a first room move', expectation: 'ALLOW', operation: 'write', path: '/rooms/r1', auth: 'alice', newData: { lastMoveAt: 0 }, serverTime: ['lastMoveAt'] },
);

describe('rtdbStdlib.timing', () => {
  test('builders compile against the node or a child', () => {
    expect(timing.isServerTimestamp()).toBe('newData.val() == now');
    expect(timing.isServerTimestamp('at')).toBe("newData.child('at').val() == now");
    expect(timing.notInFuture()).toBe('newData.isNumber() && newData.val() <= now');
    expect(timing.cooldownElapsed(500, 'at')).toBe("!data.child('at').exists() || now > data.child('at').val() + 500");
    expect(timing.throttled(500)).toBe('newData.val() == now && (!data.exists() || now > data.val() + 500)');
    expect(timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }])).toBe(
      "newData.parent().parent().child('lastPost').child(auth.uid).val() == now",
    );
  });

  test('builders refuse arguments they cannot compile', () => {
    expect(() => timing.cooldownElapsed(Number.NaN)).toThrow();
    expect(() => timing.stampedInSameWrite(-1, ['a'])).toThrow();
    expect(() => timing.stampedInSameWrite(1, [])).toThrow();
  });

  runScenario(scenario);
});
