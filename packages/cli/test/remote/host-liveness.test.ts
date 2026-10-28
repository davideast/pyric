/**
 * The Node remote client's heartbeat (ADR-0019, #973). Unit evidence with
 * faked timers; `reconnect.test.ts` drives the same watch over a real `ws`
 * server that stops answering without closing.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { HOSTED_CLIENT_LIVENESS_TIMEOUT_MS, HOSTED_HEARTBEAT_INTERVAL_MS, type BridgeMessage } from '../../src/bridge/protocol.js';
import { watchHostLiveness } from '../../src/remote/host-liveness.js';

function startWatch(send: (message: BridgeMessage) => void = () => {}) {
  const sent: BridgeMessage[] = [];
  let silences = 0;
  const liveness = watchHostLiveness({
    send: message => {
      sent.push(message);
      send(message);
    },
    onSilent: () => {
      silences += 1;
    },
  });
  return { liveness, sent, silences: () => silences };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('watchHostLiveness', () => {
  it('pings at start, then once per interval while the host answers', () => {
    const { liveness, sent } = startWatch();
    expect(sent).toEqual([{ type: 'ping', id: 'heartbeat-1' }]);
    for (let beat = 2; beat <= 6; beat += 1) {
      jest.advanceTimersByTime(HOSTED_HEARTBEAT_INTERVAL_MS - 1);
      expect(sent).toHaveLength(beat - 1);
      jest.advanceTimersByTime(1);
      expect(sent).toHaveLength(beat);
      liveness.heard();
    }
    expect(new Set(sent.map(message => message.type === 'ping' && message.id)).size).toBe(sent.length);
    liveness.stop();
  });

  it('reports silence once, at the first check after the timeout, instead of pinging', () => {
    const { sent, silences } = startWatch();
    jest.advanceTimersByTime(HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 1);
    expect(silences()).toBe(0);
    const pingsBeforeTimeout = sent.length;
    jest.advanceTimersByTime(1);
    expect(silences()).toBe(1);
    expect(sent).toHaveLength(pingsBeforeTimeout);
    jest.advanceTimersByTime(10 * HOSTED_CLIENT_LIVENESS_TIMEOUT_MS);
    expect(silences()).toBe(1);
    expect(sent).toHaveLength(pingsBeforeTimeout);
  });

  it('counts any frame from the host, so a host that keeps sending is never silent', () => {
    const { liveness, silences } = startWatch();
    for (let elapsed = 0; elapsed < 4 * HOSTED_CLIENT_LIVENESS_TIMEOUT_MS; elapsed += HOSTED_CLIENT_LIVENESS_TIMEOUT_MS / 3) {
      jest.advanceTimersByTime(HOSTED_CLIENT_LIVENESS_TIMEOUT_MS / 3);
      liveness.heard();
    }
    expect(silences()).toBe(0);
    liveness.stop();
  });

  it('measures silence from the last frame, not from the last ping', () => {
    const { liveness, silences } = startWatch();
    jest.advanceTimersByTime(HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 5_000);
    liveness.heard();
    jest.advanceTimersByTime(HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - 1);
    expect(silences()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(silences()).toBe(1);
  });

  it('sends nothing and reports nothing once stopped', () => {
    const { liveness, sent, silences } = startWatch();
    liveness.stop();
    jest.advanceTimersByTime(10 * HOSTED_CLIENT_LIVENESS_TIMEOUT_MS);
    expect(sent).toHaveLength(1);
    expect(silences()).toBe(0);
  });

  it('treats a ping the socket refuses as a drop', () => {
    let refuses = false;
    const { sent, silences } = startWatch(() => {
      if (refuses) throw new Error('socket closed');
    });
    refuses = true;
    jest.advanceTimersByTime(HOSTED_HEARTBEAT_INTERVAL_MS);
    expect(silences()).toBe(1);
    jest.advanceTimersByTime(10 * HOSTED_CLIENT_LIVENESS_TIMEOUT_MS);
    expect(sent).toHaveLength(2);
    expect(silences()).toBe(1);
  });
});
