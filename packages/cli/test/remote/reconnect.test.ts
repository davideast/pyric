/**
 * A host that restarts on the same URL (a hosted Vite dev server after a
 * config edit) looks like a dropped connection to `remoteSandbox()`, not a
 * stopped sandbox: later ops reconnect, and live listeners are resubscribed
 * once the host answers again (#949).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import {
  createLazyRemoteSandbox,
  createRemoteSandboxHandle,
  remoteSandbox,
  type RemoteRtdbSnapshot,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../../src/remote/index.js';

/**
 * A bridge host that acknowledges attach, answers every op with `generation`
 * (or none, with `answersOps: false`), and sends one snap per subscription.
 */
async function startFakeHost(
  port: number,
  generation: string,
  answersOps = true,
): Promise<{ port: number; stop: () => Promise<void>; subs: string[]; ops: string[] }> {
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/__pyric/sandbox' });
  http.listen(port, '127.0.0.1');
  await once(http, 'listening');
  const subs: string[] = [];
  const ops: string[] = [];
  server.on('connection', socket => {
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as BridgeMessage;
      const reply = (frame: BridgeMessage): void => socket.send(JSON.stringify(frame));
      if (msg.type === 'attach') {
        reply({ type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true, clientSessionId: generation });
      } else if (msg.type === 'worker-op') {
        ops.push(msg.id);
        if (answersOps) reply({ type: 'worker-res', id: msg.id, ok: true, value: { key: null, exists: true, value: generation, size: 1 } });
      } else if (msg.type === 'worker-sub') {
        subs.push(msg.subId);
        reply({ type: 'worker-snap', subId: msg.subId, value: { key: null, exists: true, value: generation, size: 1 } });
      }
    });
  });
  const stop = async (): Promise<void> => {
    for (const client of server.clients) client.terminate();
    server.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  };
  return { port: (http.address() as AddressInfo).port, stop, subs, ops };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(10);
  }
}

describe('remoteSandbox after its host restarts on the same url', () => {
  it('reconnects for later ops and resubscribes a live listener', async () => {
    const first = await startFakeHost(0, 'first');
    const url = `http://127.0.0.1:${first.port}`;
    const lazy = remoteSandbox({ url });
    cleanups.push(() => lazy.close());

    const values: unknown[] = [];
    const errors: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    expect(await lazy.rtdb.get('ticks/1')).toBe('first');
    await waitFor(() => values.length === 1);

    await first.stop();
    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);

    // The listener comes back on its own, without an op to trigger the connect.
    await waitFor(() => values.length === 2);
    expect(values).toEqual(['first', 'second']);
    expect(second.subs).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(await lazy.rtdb.get('ticks/2')).toBe('second');
  });

  it('fails an op issued while the host is down and runs a later one once it is back', async () => {
    const first = await startFakeHost(0, 'first');
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}` });
    cleanups.push(() => lazy.close());
    expect(await lazy.rtdb.get('a')).toBe('first');

    await first.stop();
    const whileDown = await lazy.rtdb.get('a').catch((error: { code?: string }) => error);
    expect((whileDown as { code?: string }).code).toBe('unavailable');

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    expect(await lazy.rtdb.get('a')).toBe('second');
  });

  it('fails an op in flight at the drop once, without replaying it on the new host', async () => {
    const first = await startFakeHost(0, 'first', false);
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}` });
    cleanups.push(() => lazy.close());
    const inFlight = lazy.rtdb.set('a', 1).catch((error: Error & { code?: string }) => error);
    await waitFor(() => first.ops.length === 1);

    await first.stop();
    const error = (await inFlight) as Error & { code?: string };
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('Requests already sent may have completed');

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    expect(await lazy.rtdb.get('a')).toBe('second');
    expect(second.ops).toHaveLength(1);
  });

  it('does not raise a resubscribed listener again when its value did not change', async () => {
    const first = await startFakeHost(0, 'same');
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}` });
    cleanups.push(() => lazy.close());
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value));
    await waitFor(() => values.length === 1);

    await first.stop();
    const second = await startFakeHost(first.port, 'same');
    cleanups.push(second.stop);
    await waitFor(() => second.subs.length === 1);
    await Bun.sleep(50);
    expect(values).toEqual(['same']);
  });
});

describe('createLazyRemoteSandbox when the connection is lost', () => {
  function fakeConnection(serveUrl = 'http://127.0.0.1:5000'): { handle: RemoteSandbox; subscriptions: () => number } {
    let subscriptions = 0;
    const channel: RemoteSandboxChannel = {
      op: () => Promise.resolve(null),
      subscribe: (_sub, onSnap) => {
        subscriptions += 1;
        onSnap({ key: null, exists: true, value: subscriptions, size: 1 } satisfies RemoteRtdbSnapshot);
        return () => {};
      },
    };
    return { handle: createRemoteSandboxHandle({ channel, serveUrl, close: () => {} }), subscriptions: () => subscriptions };
  }

  it('connects again on the next op', async () => {
    const lost: Array<(reason: string) => void> = [];
    let connects = 0;
    const lazy = createLazyRemoteSandbox(async onConnectionLost => {
      connects += 1;
      lost.push(onConnectionLost);
      return fakeConnection().handle;
    });
    await lazy.channel.op({ method: 'getSnapshot' });
    lost[0]!('connection lost');
    await lazy.channel.op({ method: 'getSnapshot' });
    expect(connects).toBe(2);
  });

  it('ignores a loss reported by a connection it already replaced', async () => {
    const lost: Array<(reason: string) => void> = [];
    let connects = 0;
    const lazy = createLazyRemoteSandbox(async onConnectionLost => {
      connects += 1;
      lost.push(onConnectionLost);
      return fakeConnection().handle;
    });
    await lazy.channel.op({ method: 'getSnapshot' });
    lost[0]!('connection lost');
    await lazy.channel.op({ method: 'getSnapshot' });
    lost[0]!('connection lost again');
    await lazy.channel.op({ method: 'getSnapshot' });
    expect(connects).toBe(2);
  });

  it('keeps retrying with backoff while a listener is live and stops once it unsubscribes', async () => {
    let connects = 0;
    let lose: (reason: string) => void = () => {};
    const connection = fakeConnection();
    const lazy = createLazyRemoteSandbox(async onConnectionLost => {
      connects += 1;
      lose = onConnectionLost;
      const hostIsDown = connects === 2 || connects === 3;
      if (hostIsDown) throw Object.assign(new Error('nothing answers'), { code: 'unavailable' });
      return connection.handle;
    });
    const values: unknown[] = [];
    const errors: unknown[] = [];
    const unsubscribe = lazy.channel.subscribe(
      { target: { service: 'rtdb', path: 'a' }, actAs: { mode: 'admin' } },
      value => values.push((value as RemoteRtdbSnapshot).value),
      error => errors.push(error),
    );
    await waitFor(() => values.length === 1);
    lose('connection lost');
    await waitFor(() => values.length === 2);
    expect(connects).toBe(4);
    expect(errors).toEqual([]);

    unsubscribe();
    lose('connection lost');
    await Bun.sleep(400);
    expect(connects).toBe(4);
    lazy.close();
  });
});
