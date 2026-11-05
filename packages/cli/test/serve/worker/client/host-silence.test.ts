import { describe, expect, test } from 'bun:test';
import { HOST_PEER_LIVENESS_TIMEOUT_MS, HOSTED_CLIENT_LIVENESS_TIMEOUT_MS, HOSTED_HEARTBEAT_INTERVAL_MS } from '../../../../src/bridge/protocol.js';
import { watchHostSilence, type HostSilence } from '../../../../src/serve/worker/client/host-silence.js';

/**
 * Runs the client's heartbeat loop against `answers`, as websocket-connection.ts
 * does: each beat checks for silence, then pings and asks when to beat next.
 * `wakeAfter` is when a delay asked for actually fires, as a throttled tab
 * stretches it. Returns the time the client judged the host silent, if it did.
 */
function runHeartbeats(options: { untilMs: number; answers: (pingAt: number) => boolean; wakeAfter?: (delayMs: number) => number }): number | undefined {
  const silence: HostSilence = watchHostSilence(0);
  const wakeAfter = options.wakeAfter ?? ((delay: number) => delay);
  let now = wakeAfter(silence.nextBeatIn(0));
  while (now <= options.untilMs) {
    if (silence.hasGoneSilent(now)) return now;
    silence.pinged(now);
    const answered = options.answers(now);
    if (answered) silence.heard(now);
    now += wakeAfter(silence.nextBeatIn(now));
  }
  return undefined;
}

/** After five minutes hidden, Chrome runs a tab's timer chains about once a minute. */
const throttledToOncePerMinute = (delayMs: number) => Math.max(delayMs, 60_000);

describe('the hosted client judges its host silent from unanswered pings (#2097)', () => {
  test('a host that answers every ping stays live when the tab beats once a minute', () => {
    const judgedSilentAt = runHeartbeats({ untilMs: 30 * 60_000, answers: () => true, wakeAfter: throttledToOncePerMinute });

    expect(judgedSilentAt).toBeUndefined();
  });

  test('a host that stops answering is judged silent one window after the first unanswered ping', () => {
    const judgedSilentAt = runHeartbeats({ untilMs: 10 * 60_000, answers: (pingAt) => pingAt < 60_000 });

    const firstUnansweredPing = 60_000;
    expect(judgedSilentAt).toBe(firstUnansweredPing + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS);
  });

  test('a throttled tab still notices a host that stopped answering, at its next wake-up', () => {
    const judgedSilentAt = runHeartbeats({ untilMs: 10 * 60_000, answers: (pingAt) => pingAt < 120_000, wakeAfter: throttledToOncePerMinute });

    expect(judgedSilentAt).toBe(180_000);
  });

  test('a client suspended past the host\'s window, whose last ping was answered, is judged silent on its first beat after it resumes', () => {
    const silence = watchHostSilence(0);
    silence.pinged(15_000);
    silence.heard(15_010);

    const resumedAt = 15_010 + 2 * HOST_PEER_LIVENESS_TIMEOUT_MS;
    expect(silence.hasGoneSilent(resumedAt)).toBe(true);
  });

  test('a beat once a minute after an answered ping stays inside the host\'s window', () => {
    const silence = watchHostSilence(0);
    silence.pinged(60_000);
    silence.heard(60_010);

    expect(silence.hasGoneSilent(120_000)).toBe(false);
    expect(silence.hasGoneSilent(60_010 + HOST_PEER_LIVENESS_TIMEOUT_MS)).toBe(true);
  });

  test('a beat with nothing unanswered waits one interval; an unanswered ping shortens it to the end of its window', () => {
    const silence = watchHostSilence(0);
    expect(silence.nextBeatIn(0)).toBe(HOSTED_HEARTBEAT_INTERVAL_MS);

    silence.pinged(1_000);
    silence.pinged(16_000);
    expect(silence.nextBeatIn(40_000)).toBe(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 40_000);
    expect(silence.hasGoneSilent(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 1)).toBe(false);
    expect(silence.hasGoneSilent(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS)).toBe(true);

    silence.heard(50_000);
    expect(silence.hasGoneSilent(50_000 + HOST_PEER_LIVENESS_TIMEOUT_MS - 1)).toBe(false);
  });
});
