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
  connectRemoteSandbox,
  createLazyRemoteSandbox,
  createRemoteSandboxHandle,
  remoteSandbox,
  type RemoteRtdbSnapshot,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../../src/remote/index.js';

/**
 * A bridge host that acknowledges attach, answers every op with `generation`
 * (or none, with `answersOps: false`), sends one snap per subscription, and
 * answers `ping` with `pong`, as the bridge does. With `refusesAttach`, it
 * refuses every attach with a policy close (1008), as the bridge does when it
 * declines a hosted session. `muteClients` makes the sockets open now go
 * silent without closing, as a paused host does; later sockets answer
 * `generation`, which `setGeneration` changes.
 */
async function startFakeHost(
  port: number,
  generation: string,
  answersOps = true,
  refusesAttach = false,
): Promise<{
  port: number;
  stop: () => Promise<void>;
  closeClients: (code: number, reason: string) => void;
  muteClients: () => void;
  setGeneration: (next: string) => void;
  subs: string[];
  ops: string[];
  attaches: () => number;
}> {
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/__pyric/sandbox' });
  http.listen(port, '127.0.0.1');
  await once(http, 'listening');
  const subs: string[] = [];
  const ops: string[] = [];
  let attaches = 0;
  const muted = new WeakSet<object>();
  server.on('connection', socket => {
    socket.on('message', raw => {
      if (muted.has(socket)) return;
      const msg = JSON.parse(raw.toString()) as BridgeMessage;
      const reply = (frame: BridgeMessage): void => socket.send(JSON.stringify(frame));
      if (msg.type === 'attach') {
        attaches += 1;
        if (refusesAttach) {
          socket.close(1008, 'Hosted session admission failed.');
          return;
        }
        reply({ type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true, clientSessionId: generation });
      } else if (msg.type === 'worker-op') {
        ops.push(msg.id);
        if (answersOps) reply({ type: 'worker-res', id: msg.id, ok: true, value: { key: null, exists: true, value: generation, size: 1 } });
      } else if (msg.type === 'ping') {
        reply({ type: 'pong', id: msg.id });
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
  const closeClients = (code: number, reason: string): void => {
    for (const client of server.clients) client.close(code, reason);
  };
  const muteClients = (): void => {
    for (const client of server.clients) muted.add(client);
  };
  const setGeneration = (next: string): void => {
    generation = next;
  };
  return {
    port: (http.address() as AddressInfo).port,
    stop,
    closeClients,
    muteClients,
    setGeneration,
    subs,
    ops,
    attaches: () => attaches,
  };
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

  it('warns once per drop while its listeners wait for the host, not once per retry', async () => {
    const first = await startFakeHost(0, 'first');
    const url = `http://127.0.0.1:${first.port}`;
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url, warn: message => warnings.push(message) });
    cleanups.push(() => lazy.close());
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value));
    await waitFor(() => values.length === 1);
    expect(warnings).toEqual([]);

    await first.stop();
    // Long enough for the 250 ms and 500 ms retries to fail against nothing.
    await Bun.sleep(1_200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(url);

    const second = await startFakeHost(first.port, 'second');
    await waitFor(() => values.length === 2);
    expect(warnings).toHaveLength(1);

    await second.stop();
    await waitFor(() => warnings.length === 2);
    const third = await startFakeHost(first.port, 'third');
    cleanups.push(third.stop);
    await waitFor(() => values.length === 3);
    expect(warnings).toHaveLength(2);
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

  it('ends its listeners and does not reconnect when the host closes the connection for a policy violation', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: () => {} });
    cleanups.push(() => lazy.close());
    const errors: Array<{ code?: string }> = [];
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    await waitFor(() => values.length === 1);

    host.closeClients(1008, 'policy');
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.code).toBe('permission-denied');
    // Long enough for the first two retries a recoverable drop would make.
    await Bun.sleep(900);
    expect(host.attaches()).toBe(1);
  });

  it('ends its listeners and stops retrying when the returning host refuses the attach for a policy violation', async () => {
    const first = await startFakeHost(0, 'first');
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}`, warn: () => {} });
    cleanups.push(() => lazy.close());
    const errors: Array<{ code?: string }> = [];
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    await waitFor(() => values.length === 1);

    await first.stop();
    const second = await startFakeHost(first.port, 'second', true, true);
    cleanups.push(second.stop);
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.code).toBe('permission-denied');
    const refusals = second.attaches();
    // Long enough for the next two retries a recoverable failure would make.
    await Bun.sleep(1_500);
    expect(second.attaches()).toBe(refusals);
    expect(values).toEqual(['first']);
  });
});

/** A heartbeat short enough for a test: ping every 50 ms, 300 ms of silence is a drop. */
const fastHeartbeat = { heartbeatIntervalMs: 50, hostSilenceTimeoutMs: 300 };

describe('remoteSandbox when its host stops answering without closing the socket (#973)', () => {
  it('stays attached past the silence timeout while the host answers its pings', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message), ...fastHeartbeat });
    cleanups.push(() => lazy.close());
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value));
    await waitFor(() => values.length === 1);

    await Bun.sleep(3 * fastHeartbeat.hostSilenceTimeoutMs);
    expect(warnings).toEqual([]);
    expect(host.attaches()).toBe(1);
  });

  it('reports one loss, reconnects, and resubscribes a live listener', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message), ...fastHeartbeat });
    cleanups.push(() => lazy.close());
    const values: unknown[] = [];
    const errors: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    await waitFor(() => values.length === 1);

    host.setGeneration('second');
    host.muteClients();
    await waitFor(() => values.length === 2);
    expect(values).toEqual(['first', 'second']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the remote sandbox sent nothing for 0.3s');
    expect(host.attaches()).toBe(2);
    expect(host.subs).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('fails an op sent on the silent socket once and runs an op issued while reconnecting once', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message), ...fastHeartbeat });
    cleanups.push(() => lazy.close());
    expect(await lazy.rtdb.get('a')).toBe('first');

    host.muteClients();
    const unanswered = await lazy.rtdb.set('a', 1).catch((error: Error & { code?: string }) => error);
    expect((unanswered as Error & { code?: string }).code).toBe('unavailable');
    expect(warnings).toHaveLength(1);

    host.setGeneration('second');
    const opsBefore = host.ops.length;
    expect(await lazy.rtdb.get('a')).toBe('second');
    expect(host.ops.length - opsBefore).toBe(1);
    expect(host.attaches()).toBe(2);
  });

  it('ends the eager handle\'s listeners with unavailable', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${host.port}`, ...fastHeartbeat });
    cleanups.push(() => remote.close());
    const values: unknown[] = [];
    const errors: Array<{ code?: string }> = [];
    remote.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    await waitFor(() => values.length === 1);

    host.muteClients();
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.code).toBe('unavailable');
    expect(host.attaches()).toBe(1);
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

  it('ends a listener whose subscribe a live connection refuses', async () => {
    const channel: RemoteSandboxChannel = {
      op: () => Promise.resolve(null),
      subscribe: () => {
        throw Object.assign(new Error('refused'), { code: 'invalid-argument' });
      },
    };
    const handle = createRemoteSandboxHandle({ channel, serveUrl: 'http://127.0.0.1:5000', close: () => {} });
    const lazy = createLazyRemoteSandbox(async () => handle);
    const error = await new Promise<Error & { code: string }>(resolve => {
      lazy.channel.subscribe({ target: { service: 'rtdb', path: 'a' }, actAs: { mode: 'admin' } }, () => {}, resolve);
    });
    expect(error.code).toBe('invalid-argument');
    lazy.close();
  });

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
