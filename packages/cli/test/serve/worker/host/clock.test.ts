/** The host's clock stream, and the push key it mints for a caller that waits. */
import { describe, expect, it } from 'bun:test';
import { getClock } from 'pyric/sandbox';
import { handleMessage, type PortLike } from '../../../../src/serve/worker/host.js';
import type { OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { makeHostCtx, sleep } from '../integration-support.js';

/** The alphabet a push key's timestamp prefix is written in. */
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** The instant a push key's first eight characters encode. */
function instantOf(key: string): number {
  let instant = 0;
  for (const character of key.slice(0, 8)) {
    instant = instant * 64 + PUSH_CHARS.indexOf(character);
  }
  return instant;
}

/** A port that records everything the host sends it. */
function recordingPort(): { port: PortLike; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return { port: { postMessage: (message: OutboundMessage) => void sent.push(message) }, sent };
}

describe('the host streams the sandbox clock', () => {
  it('answers a subscribing port with the state as it stands', async () => {
    const ctx = await makeHostCtx();
    const { port, sent } = recordingPort();
    const pinned = Date.UTC(2031, 0, 1);
    getClock(ctx.sandbox).set(pinned);

    await handleMessage(ctx, port, { t: 'clock-subscribe' });

    expect(sent).toEqual([{ t: 'clock', state: { mode: 'fixed', fixedAt: pinned, offsetMs: 0 } }]);
  });

  it('sends every later move to the ports that subscribed', async () => {
    const ctx = await makeHostCtx();
    const first = recordingPort();
    const second = recordingPort();
    await handleMessage(ctx, first.port, { t: 'clock-subscribe' });
    await handleMessage(ctx, second.port, { t: 'clock-subscribe' });

    const pinned = Date.UTC(2031, 0, 1);
    getClock(ctx.sandbox).set(pinned);

    const moved = { t: 'clock', state: { mode: 'fixed', fixedAt: pinned, offsetMs: 0 } };
    expect(first.sent[1]).toEqual(moved);
    expect(second.sent[1]).toEqual(moved);
  });
});

describe('reading the clock over the port', () => {
  it('reports the pinned instant to a caller that waits', async () => {
    const ctx = await makeHostCtx();
    const { port, sent } = recordingPort();
    const pinned = Date.UTC(2031, 0, 1);
    getClock(ctx.sandbox).set(pinned);

    await handleMessage(ctx, port, { t: 'op', id: 'clock-1', method: 'sandbox.clock' });

    expect(sent).toEqual([
      {
        t: 'res',
        id: 'clock-1',
        ok: true,
        value: { state: { mode: 'fixed', fixedAt: pinned, offsetMs: 0 }, now: pinned },
      },
    ]);
  });
});

describe('a push with no key', () => {
  it('mints one from the sandbox clock', async () => {
    const ctx = await makeHostCtx();
    const { port, sent } = recordingPort();
    const pinned = Date.UTC(2031, 0, 1);
    getClock(ctx.sandbox).set(pinned);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'push-1',
      method: 'rtdb.push',
      path: 'scores',
      value: { points: 7 },
      actAs: { mode: 'admin' },
    });
    await sleep();

    const reply = sent.find((message) => message.t === 'res');
    expect(reply).toBeDefined();
    const value = (reply as { ok: boolean; value: { key: string; path: string } }).value;
    expect(instantOf(value.key)).toBe(pinned);
    expect(value.path).toBe(`/scores/${value.key}`);
  });
});
