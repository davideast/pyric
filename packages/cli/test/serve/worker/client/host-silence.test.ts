import { describe, expect, test } from 'bun:test';
import { HOSTED_CLIENT_LIVENESS_TIMEOUT_MS, HOSTED_HEARTBEAT_INTERVAL_MS } from '../../../../src/bridge/protocol.js';
import { watchHostSilence, type HostSilence } from '../../../../src/serve/worker/client/host-silence.js';

/**
 * Runs the client's heartbeat loop against `answers`, as websocket-connection.ts
 * does: each beat checks for silence, then pings and asks when to beat next.
 * `wakeAfter` is when a delay asked for actually fires, as a throttled tab
 * stretches it. Returns the time the client judged the host silent, if it did.
 */
function runHeartbeats(options: { untilMs: number; answers: (pingAt: number) => boolean; wakeAfter?: (delayMs: number) => number }): number | undefined {
  const silence: HostSilence = watchHostSilence();
  const wakeAfter = options.wakeAfter ?? ((delay: number) => delay);
  let now = wakeAfter(silence.nextBeatIn(0));
  while (now <= options.untilMs) {
    if (silence.hasGoneSilent(now)) return now;
    silence.pinged(now);
    const answered = options.answers(now);
    if (answered) silence.heard();
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

  test('a beat with nothing unanswered waits one interval; an unanswered ping shortens it to the end of its window', () => {
    const silence = watchHostSilence();
    expect(silence.nextBeatIn(0)).toBe(HOSTED_HEARTBEAT_INTERVAL_MS);

    silence.pinged(1_000);
    silence.pinged(16_000);
    expect(silence.nextBeatIn(40_000)).toBe(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 40_000);
    expect(silence.hasGoneSilent(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 1)).toBe(false);
    expect(silence.hasGoneSilent(1_000 + HOSTED_CLIENT_LIVENESS_TIMEOUT_MS)).toBe(true);

    silence.heard();
    expect(silence.hasGoneSilent(10 * HOSTED_CLIENT_LIVENESS_TIMEOUT_MS)).toBe(false);
  });
});
