/**
 * A host that restarts on the same URL (a hosted Vite dev server after a
 * config edit) looks like a dropped connection to `remoteSandbox()`, not a
 * stopped sandbox: later ops reconnect, and live listeners are resubscribed
 * once the host answers again (#949).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
import { setHeartbeatForTesting } from '../../src/remote/host-liveness.js';
import { setHoldDeadlineForTesting } from '../../src/remote/held-calls.js';

/**
 * A bridge host that acknowledges attach, answers every op with `generation`
 * (or none, with `answersOps: false`, or only the methods `answersOps`
 * accepts), records each op's method and each sub and op in frame order,
 * sends one snap per subscription, and
 * answers `ping` with `pong`, as the bridge does. With `refusesAttach`, it
 * refuses every attach with a policy close (1008), as the bridge does when it
 * declines a hosted session. `muteClients` makes the sockets open now go
 * silent without closing, as a paused host does; later sockets answer
 * `generation`, which `setGeneration` changes.
 */
async function startFakeHost(
  port: number,
  generation: string,
  answersOps: boolean | ((method: string) => boolean) = true,
  refusesAttach = false,
): Promise<{
  port: number;
  stop: () => Promise<void>;
  closeClients: (code: number, reason: string) => void;
  muteClients: () => void;
  setGeneration: (next: string) => void;
  subs: string[];
  ops: string[];
  methods: string[];
  frames: string[];
  attaches: () => number;
}> {
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/__pyric/sandbox' });
  http.listen(port, '127.0.0.1');
  await once(http, 'listening');
  const subs: string[] = [];
  const ops: string[] = [];
  const methods: string[] = [];
  const frames: string[] = [];
  const answers = (method: string): boolean => {
    const answersSome = typeof answersOps === 'function';
    if (answersSome) return answersOps(method);
    return answersOps;
  };
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
        methods.push(msg.op.method);
        frames.push(`op ${msg.op.method}`);
        if (answers(msg.op.method)) reply({ type: 'worker-res', id: msg.id, ok: true, value: { key: null, exists: true, value: generation, size: 1 } });
      } else if (msg.type === 'ping') {
        reply({ type: 'pong', id: msg.id });
      } else if (msg.type === 'worker-sub') {
        subs.push(msg.subId);
        frames.push('sub');
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
    methods,
    frames,
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

  it('holds an op issued while the host is down and sends it once it is back', async () => {
    const first = await startFakeHost(0, 'first');
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}`, warn: message => warnings.push(message) });
    cleanups.push(() => lazy.close());
    expect(await lazy.rtdb.get('a')).toBe('first');

    await first.stop();
    await waitFor(() => warnings.length === 1);
    expect(warnings[0]).toContain('calls wait up to 10 seconds for it, and live listeners reconnect');
    expect(warnings[0]).not.toContain('sent again');
    const whileDown = lazy.rtdb.get('a');
    // Long enough for the 250 ms and 500 ms retries to fail against nothing.
    await Bun.sleep(900);

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    expect(await whileDown).toBe('second');
    expect(second.methods).toEqual(['rtdb.get']);
  });

  it('sends an rtdb.set in flight at the drop again on the restarted host, under a new id, and resolves on its reply', async () => {
    const first = await startFakeHost(0, 'first', method => method !== 'rtdb.set');
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}`, warn: message => warnings.push(message) });
    cleanups.push(() => lazy.close());
    expect(await lazy.rtdb.get('a')).toBe('first');
    let settled = false;
    const inFlight = lazy.rtdb.set('a', 1).finally(() => (settled = true));
    await waitFor(() => first.ops.length === 2);

    await first.stop();
    await waitFor(() => warnings.length === 1);
    expect(warnings[0]).toContain('calls in flight are sent again');
    expect(warnings[0]).toContain('1 call in flight waits to be sent again.');
    expect(settled).toBe(false);

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await inFlight;
    expect(second.methods).toEqual(['rtdb.set']);
    expect(second.ops).not.toContain(first.ops[1]);
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

type Outcome = { settled: false } | { settled: true; value?: unknown; error?: Error & { code?: string } };

/** Records how `call` settles, without awaiting it. */
function track(call: Promise<unknown>): Outcome {
  const outcome: { settled: boolean; value?: unknown; error?: Error & { code?: string } } = { settled: false };
  call.then(
    value => Object.assign(outcome, { settled: true, value }),
    (error: Error & { code?: string }) => Object.assign(outcome, { settled: true, error }),
  );
  return outcome as Outcome;
}

function errorOf(outcome: Outcome): (Error & { code?: string }) | undefined {
  if (!outcome.settled) return undefined;
  return outcome.error;
}

/** A lazy handle on a host that answers the methods `answers` accepts, and the warnings it logs. */
async function lazyOnHost(answers: (method: string) => boolean = () => true) {
  const first = await startFakeHost(0, 'first', answers);
  const warnings: string[] = [];
  const lazy = remoteSandbox({ url: `http://127.0.0.1:${first.port}`, warn: message => warnings.push(message) });
  cleanups.push(() => lazy.close());
  expect(await lazy.rtdb.get('a')).toBe('first');
  const drop = async (): Promise<void> => {
    await first.stop();
    await waitFor(() => warnings.length === 1);
  };
  return { first, lazy, warnings, drop };
}

const instance = undefined;

describe('remoteSandbox calls across a host restart (#1107)', () => {
  afterEach(() => setHoldDeadlineForTesting(undefined));

  it('settles each RTDB call in flight at the drop by its fate, and sends again only writes and reads', async () => {
    let answered = 0;
    const answersFirstOnly = (): boolean => ++answered === 1;
    const { first, lazy, drop } = await lazyOnHost(answersFirstOnly);
    const onDisconnect = track(lazy.channel.op({ method: 'rtdb.onDisconnectSet', instance, path: 'a', value: 0 }));
    const commit = track(lazy.channel.op({ method: 'rtdb.transactionCommit', instance, path: 'a', expected: 1, value: 2 }));
    const keylessPush = track(lazy.rtdb.push('list', 1));
    const metadata = track(lazy.storage.getMetadata('x'));
    const get = track(lazy.rtdb.get('b'));
    await waitFor(() => first.ops.length === 6);

    await drop();
    await waitFor(() => [commit, keylessPush, metadata].every(outcome => outcome.settled));
    const disconnect = errorOf(commit);
    expect(disconnect).toBeInstanceOf(Error);
    expect(disconnect?.message).toBe('disconnect');
    expect(disconnect?.code).toBeUndefined();
    expect(errorOf(keylessPush)?.code).toBe('unavailable');
    expect(errorOf(metadata)?.code).toBe('unavailable');
    expect(errorOf(metadata)?.message).toContain('Requests already sent may have completed');

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await waitFor(() => get.settled);
    expect(get).toEqual({ settled: true, value: 'second' });
    await Bun.sleep(50);
    expect(onDisconnect.settled).toBe(false);
    expect(second.methods).toEqual(['rtdb.get']);
  });

  it('sends a keyed push in flight at the drop again', async () => {
    const { first, lazy, drop } = await lazyOnHost(method => method !== 'rtdb.push');
    const push = lazy.channel.op({ method: 'rtdb.push', instance, path: 'list', key: 'k1', value: 1 });
    await waitFor(() => first.ops.length === 2);
    await drop();
    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await push;
    expect(second.methods).toEqual(['rtdb.push']);
  });

  it('restores listeners first, then calls in flight at the drop, then calls issued while down, in issue order', async () => {
    const { first, lazy, drop } = await lazyOnHost(method => method !== 'rtdb.set');
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value));
    await waitFor(() => values.length === 1);
    const inFlight = [lazy.rtdb.set('a', 1), lazy.rtdb.set('b', 2)];
    await waitFor(() => first.ops.length === 3);

    await drop();
    const whileDown = [lazy.rtdb.get('c'), lazy.rtdb.update('d', { x: 1 })];
    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await Promise.all([...inFlight, ...whileDown]);
    expect(second.frames).toEqual(['sub', 'op rtdb.set', 'op rtdb.set', 'op rtdb.get', 'op rtdb.update']);
  });

  it('fails a call held past its deadline unsent, while a call in flight at the drop outlives it', async () => {
    setHoldDeadlineForTesting(600);
    const { first, lazy, drop } = await lazyOnHost(method => method !== 'rtdb.set');
    const inFlight = track(lazy.rtdb.set('a', 1));
    await waitFor(() => first.ops.length === 2);

    await drop();
    const held = track(lazy.rtdb.get('b'));
    await waitFor(() => held.settled, 2_000);
    const expired = errorOf(held);
    expect(expired?.code).toBe('unavailable');
    expect(expired?.message).toStartWith(
      'The remote sandbox connection was not restored within 10 seconds. The request was not sent. Last attempt: ',
    );
    await Bun.sleep(300);
    expect(inFlight.settled).toBe(false);

    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await waitFor(() => inFlight.settled);
    expect(errorOf(inFlight)).toBeUndefined();
    expect(second.methods).toEqual(['rtdb.set']);
  });

  it('fails held and re-held calls with permission-denied, unsent, when the returning host refuses the attach', async () => {
    const { first, lazy, drop } = await lazyOnHost(method => method !== 'rtdb.set');
    const inFlight = lazy.rtdb.set('a', 1).catch((error: Error & { code?: string }) => error);
    await waitFor(() => first.ops.length === 2);
    await drop();
    const held = lazy.rtdb.get('b').catch((error: Error & { code?: string }) => error);

    const second = await startFakeHost(first.port, 'second', true, true);
    cleanups.push(second.stop);
    expect(((await inFlight) as Error & { code?: string }).code).toBe('permission-denied');
    expect(((await held) as Error & { code?: string }).code).toBe('permission-denied');
    expect(second.ops).toEqual([]);
  });

  it('fails held and re-held calls once on close() and sends none of them', async () => {
    const { first, lazy, drop } = await lazyOnHost(method => method !== 'rtdb.set');
    const inFlight = lazy.rtdb.set('a', 1).catch((error: Error) => error);
    await waitFor(() => first.ops.length === 2);
    await drop();
    const held = lazy.rtdb.get('b').catch((error: Error) => error);

    lazy.close();
    expect(((await inFlight) as Error).message).toContain('closed by the client');
    expect(((await held) as Error).message).toContain('closed by the client');
    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    // Long enough for the first two retries a held call would trigger.
    await Bun.sleep(900);
    expect(second.attaches()).toBe(0);
  });

  it('attaches a listener opened while the host is down once it is back, with no deadline', async () => {
    setHoldDeadlineForTesting(200);
    const { first, lazy, drop } = await lazyOnHost();
    await drop();
    const values: unknown[] = [];
    const errors: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value), error => errors.push(error));
    await Bun.sleep(500);
    const second = await startFakeHost(first.port, 'second');
    cleanups.push(second.stop);
    await waitFor(() => values.length === 1);
    expect(values).toEqual(['second']);
    expect(errors).toEqual([]);
  });
});

/** A heartbeat short enough for a test: ping every 50 ms, 300 ms of silence is a drop. */
const fastHeartbeat = { intervalMs: 50, timeoutMs: 300 };

// #1723: @firebase/database 1.1.3 ends a closed connection through
// repoInterrupt, which clears its request callbacks, so a sent onDisconnect
// never settles. The presence sample leaves that promise without a handler,
// so rejecting it on close ended a Node process on an unhandled rejection.
describe('close() with an onDisconnect the host has not answered (#1723)', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', record);
  });
  afterEach(() => { process.off('unhandledRejection', record); });

  const answersReadsOnly = (method: string): boolean => method === 'rtdb.get';

  /** Issues a bare onDisconnect, as the presence sample does, and a write; the host answers neither. */
  async function unansweredCalls(remote: RemoteSandbox, host: { ops: string[] }, opsBefore: number) {
    const onDisconnect = track(remote.channel.op({ method: 'rtdb.onDisconnectSet', instance, path: 'status/alice', value: 'offline' }));
    const write = track(remote.rtdb.set('status/alice', 'online'));
    await waitFor(() => host.ops.length === opsBefore + 2);
    return { onDisconnect, write };
  }

  it('leaves the onDisconnect unsettled on the eager handle and still rejects the write', async () => {
    const host = await startFakeHost(0, 'first', answersReadsOnly);
    cleanups.push(host.stop);
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${host.port}` });
    const { onDisconnect, write } = await unansweredCalls(remote, host, 0);

    remote.close();
    await waitFor(() => write.settled);
    await Bun.sleep(50);

    expect(errorOf(write)?.message).toContain('closed by the client');
    expect(onDisconnect.settled).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('leaves the onDisconnect unsettled on the lazy handle and still rejects the write', async () => {
    const { first, lazy } = await lazyOnHost(answersReadsOnly);
    cleanups.push(first.stop);
    const { onDisconnect, write } = await unansweredCalls(lazy, first, 1);

    lazy.close();
    await waitFor(() => write.settled);
    await Bun.sleep(50);

    expect(errorOf(write)?.message).toContain('closed by the client');
    expect(onDisconnect.settled).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('leaves an onDisconnect held while the lazy handle reconnects unsettled, and still rejects a held write', async () => {
    const { lazy, drop } = await lazyOnHost();
    await drop();
    void lazy.channel.op({ method: 'rtdb.onDisconnectSet', instance, path: 'status/alice', value: 'offline' });
    const onDisconnect = track(lazy.channel.op({ method: 'rtdb.onDisconnectRemove', instance, path: 'status/bob' }));
    const write = track(lazy.rtdb.set('status/alice', 'online'));

    lazy.close();
    await waitFor(() => write.settled);
    await Bun.sleep(50);

    expect(errorOf(write)?.message).toContain('closed by the client');
    expect(onDisconnect.settled).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('leaves a bare onDisconnect without an unhandled rejection', async () => {
    const host = await startFakeHost(0, 'first', answersReadsOnly);
    cleanups.push(host.stop);
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${host.port}` });
    void remote.channel.op({ method: 'rtdb.onDisconnectSet', instance, path: 'status/alice', value: 'offline' });
    await waitFor(() => host.ops.length === 1);

    remote.close();
    await Bun.sleep(50);

    expect(unhandled).toEqual([]);
  });
});

describe('remoteSandbox when its host stops answering without closing the socket (#973)', () => {
  beforeEach(() => setHeartbeatForTesting(fastHeartbeat));
  afterEach(() => setHeartbeatForTesting(undefined));

  it('stays attached past the silence timeout while the host answers its pings', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message) });
    cleanups.push(() => lazy.close());
    const values: unknown[] = [];
    lazy.rtdb.onValue('ticks', snapshot => values.push(snapshot.value));
    await waitFor(() => values.length === 1);

    await Bun.sleep(3 * fastHeartbeat.timeoutMs);
    expect(warnings).toEqual([]);
    expect(host.attaches()).toBe(1);
  });

  it('reports one loss, reconnects, and resubscribes a live listener', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message) });
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

  it('sends an rtdb.set sent on the silent socket again, and fails a Storage call sent there once', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const warnings: string[] = [];
    const lazy = remoteSandbox({ url: `http://127.0.0.1:${host.port}`, warn: message => warnings.push(message) });
    cleanups.push(() => lazy.close());
    expect(await lazy.rtdb.get('a')).toBe('first');

    host.muteClients();
    const unanswered = lazy.rtdb.set('a', 1);
    const metadata = await lazy.storage.getMetadata('x').catch((error: Error & { code?: string }) => error);
    expect((metadata as Error & { code?: string }).code).toBe('unavailable');
    expect((metadata as Error).message).toContain('Requests already sent may have completed');
    await unanswered;
    expect(warnings).toHaveLength(1);
    expect(host.attaches()).toBe(2);
    // The muted socket recorded nothing; the new one took the set once.
    expect(host.methods).toEqual(['rtdb.get', 'rtdb.set']);

    host.setGeneration('second');
    expect(await lazy.rtdb.get('a')).toBe('second');
    expect(host.methods).toEqual(['rtdb.get', 'rtdb.set', 'rtdb.get']);
  });

  it('ends the eager handle\'s listeners with unavailable', async () => {
    const host = await startFakeHost(0, 'first');
    cleanups.push(host.stop);
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${host.port}` });
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

  it('retries a reconnect that fails with not-found, failed-precondition, or deadline-exceeded while it holds a call', async () => {
    const failures = ['not-found', 'failed-precondition', 'deadline-exceeded'];
    let connects = 0;
    let lose: (reason: string) => void = () => {};
    const lazy = createLazyRemoteSandbox(async onConnectionLost => {
      connects += 1;
      lose = onConnectionLost;
      const failure = failures[connects - 2];
      const hostIsRestarting = failure !== undefined;
      if (hostIsRestarting) throw Object.assign(new Error(`host restarting (${failure})`), { code: failure });
      return fakeConnection().handle;
    }, { warn: () => {} });
    cleanups.push(() => lazy.close());
    await lazy.channel.op({ method: 'getSnapshot' });

    lose('connection lost');
    await lazy.channel.op({ method: 'getSnapshot' });
    expect(connects).toBe(5);
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
