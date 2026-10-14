import { afterEach, expect, test } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import { setHoldDeadlineForTesting } from '../../../src/serve/worker/client/held-messages.js';
import { nextId, nextSubId, openSnapshotSubscription, rawRpc } from '../../../src/serve/worker/client/core.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// ADR-0019 decision 7, as amended 2026-10-14: the web hosted client holds an
// operation issued while it is not attached, and sends it once after the whole
// restore. The client runs against a real WebSocket server on a loopback port.
// Stopping that server drops the client's socket; starting another on the same
// port lets the client re-attach, as a host restarted in place would.

const NOT_RESTORED = 'The hosted sandbox connection was not restored within 10 seconds. The request was not sent.';
const CONNECTION_LOST = 'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';
const CONNECTION_CLOSED = 'The hosted sandbox connection is closed.';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setHoldDeadlineForTesting(undefined);
});

type WorkerFrame = { t: string; id?: string; subId?: string; method?: string };
type Reply = (value: unknown, error?: { code: string; message: string }) => void;

interface HostOptions {
  hostInstanceId?: string;
  /** Answers an operation; the default replies 'done'. Not calling `reply` leaves it in flight. */
  answer?: (frame: WorkerFrame, reply: Reply) => void;
}

/** Every worker frame each host received, in arrival order, across restarts. */
class Host {
  readonly frames: WorkerFrame[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;
  readonly port: number;

  constructor() {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    this.port = probe.port as number;
    void probe.stop(true);
    cleanups.push(() => this.stop());
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/__pyric/sandbox`;
  }

  start(options: HostOptions = {}): void {
    const frames = this.frames;
    this.server = Bun.serve({
      port: this.port,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return undefined;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(socket, data) {
          const message = JSON.parse(String(data)) as BridgeMessage;
          if (message.type === 'attach') {
            socket.send(JSON.stringify({
              type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true,
              clientSessionId: 'client', projectKey: 'orbit', hostInstanceId: options.hostInstanceId ?? 'host-1',
              capabilities: ['worker-port'],
            } satisfies BridgeMessage));
            return;
          }
          if (message.type !== 'worker-message') return;
          const frame = message.message as WorkerFrame;
          frames.push(frame);
          if (frame.t !== 'op') return;
          const reply: Reply = (value, error) => {
            const outcome = error === undefined ? { ok: true, value } : { ok: false, error };
            socket.send(JSON.stringify({ type: 'worker-message-result', message: { t: 'res', id: frame.id, ...outcome } }));
          };
          const answer = options.answer ?? ((_frame, send) => send('done'));
          answer(frame, reply);
        },
      },
    });
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
  }

  sent(id: string): WorkerFrame[] {
    return this.frames.filter(frame => frame.id === id);
  }
}

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function open(host: Host): { db: ClientDb; states: HostedConnectionState[] } {
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: host.url,
    projectKey: 'orbit',
    retryInitialConnection: true,
    onConnection: state => states.push(state),
  });
  cleanups.push(() => db.port.close());
  return { db, states };
}

function op(db: ClientDb, method: string): { id: string; outcome: Promise<unknown> } {
  const id = nextId();
  const outcome = rawRpc(db.port, { t: 'op', id, method } as unknown as InboundMessage);
  return { id, outcome };
}

/** Settles to the value, or to the error's code and message. */
function settle(outcome: Promise<unknown>): Promise<unknown> {
  return outcome.then(value => ({ value }), (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));
}

/** Attached, then dropped: the client is `interrupted` and the host is down. */
async function attachedThenDropped(host: Host, whileAttached: (db: ClientDb) => void = () => {}) {
  host.start();
  const client = open(host);
  await until(() => client.states.includes('attached'));
  whileAttached(client.db);
  const attaches = client.states.filter(state => state === 'attached').length;
  host.stop();
  await until(() => client.states.at(-1) === 'interrupted');
  const reattached = () => client.states.filter(state => state === 'attached').length > attaches;
  return { ...client, reattached };
}

/** A listener the client restores after re-attach (a Firestore observation). */
function listen(db: ClientDb): string {
  const subId = nextSubId();
  openSnapshotSubscription(db.port, subId, { port: db.port, next: () => {}, service: 'firestore' },
    { t: 'sub', subId, target: { kind: 'doc', path: 'rooms/r1' } } as unknown as InboundMessage);
  return subId;
}

test('an operation issued while interrupted reaches the host exactly once after re-attach', async () => {
  const host = new Host();
  const { db, reattached } = await attachedThenDropped(host);
  const write = op(db, 'write');
  host.start();
  await until(reattached);
  expect(await settle(write.outcome)).toEqual({ value: 'done' });
  expect(host.sent(write.id)).toHaveLength(1);
});

test('an operation issued while restoring on a replaced host is sent after the Auth restore and the listener replay', async () => {
  const host = new Host();
  let subId = '';
  const { db, states, reattached } = await attachedThenDropped(host, attached => { subId = listen(attached); });
  db.port.restoreAuth = async (request) => {
    await request({ t: 'op', id: nextId(), method: 'auth.restorePortSession', uid: 'u1', tenantId: null } as never);
  };
  let issuedWhileRestoring: { id: string; outcome: Promise<unknown> } | undefined;
  host.start({
    hostInstanceId: 'host-2',
    answer(frame, reply) {
      const restoresAuth = frame.method === 'auth.restorePortSession';
      if (!restoresAuth) { reply('done'); return; }
      // The client is restoring until this reply arrives.
      issuedWhileRestoring = op(db, 'write');
      setTimeout(() => reply(null), 50);
    },
  });
  await until(reattached);
  expect(states).toContain('restoring');
  expect(await settle(issuedWhileRestoring!.outcome)).toEqual({ value: 'done' });
  const order = host.frames.map(frame => frame.method ?? `${frame.t}:${frame.subId ?? ''}`);
  const restoredAuth = order.lastIndexOf('auth.restorePortSession');
  const resubscribed = order.lastIndexOf(`sub:${subId}`);
  const held = host.frames.findIndex(frame => frame.id === issuedWhileRestoring!.id);
  expect(restoredAuth).toBeGreaterThanOrEqual(0);
  expect(resubscribed).toBeGreaterThan(restoredAuth);
  expect(held).toBeGreaterThan(resubscribed);
  expect(host.sent(issuedWhileRestoring!.id)).toHaveLength(1);
});

test('an operation held past the deadline fails once, saying it was not sent, and a later attach never sends it', async () => {
  setHoldDeadlineForTesting(200);
  const host = new Host();
  const { db, reattached } = await attachedThenDropped(host);
  const write = op(db, 'write');
  let rejections = 0;
  const outcome = settle(write.outcome.catch((error: unknown) => { rejections += 1; throw error; }));
  expect(await outcome).toEqual({ code: 'unavailable', message: NOT_RESTORED });
  host.start();
  await until(reattached);
  expect(await rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage)).toBe('done');
  expect(host.sent(write.id)).toEqual([]);
  expect(rejections).toBe(1);
});

test('a failed Auth restore fails held operations without sending them', async () => {
  const host = new Host();
  const { db, states } = await attachedThenDropped(host);
  db.port.restoreAuth = async (request) => {
    await request({ t: 'op', id: nextId(), method: 'auth.restorePortSession', uid: 'u1', tenantId: null } as never);
  };
  const write = op(db, 'write');
  host.start({
    hostInstanceId: 'host-2',
    answer(frame, reply) {
      const restoresAuth = frame.method === 'auth.restorePortSession';
      if (restoresAuth) reply(undefined, { code: 'internal', message: 'restore failed' });
      else reply('done');
    },
  });
  expect(await settle(write.outcome)).toEqual({ code: 'unavailable', message: 'Could not restore the hosted app session.' });
  expect(states.at(-1)).toBe('closed');
  expect(host.sent(write.id)).toEqual([]);
});

test('close() while holding fails held operations once and sends none', async () => {
  const host = new Host();
  const { db } = await attachedThenDropped(host);
  const first = op(db, 'write');
  const second = op(db, 'write');
  const settled: string[] = [];
  for (const { id, outcome } of [first, second]) outcome.catch(() => {}).finally(() => settled.push(id));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(settled).toEqual([]);
  db.port.close();
  expect(await settle(first.outcome)).toEqual({ code: 'unavailable', message: CONNECTION_CLOSED });
  expect(await settle(second.outcome)).toEqual({ code: 'unavailable', message: CONNECTION_CLOSED });
  host.start();
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(host.sent(first.id)).toEqual([]);
  expect(host.sent(second.id)).toEqual([]);
});

test('an operation in flight at the drop fails once and is not re-sent', async () => {
  const host = new Host();
  const answer = (frame: WorkerFrame, reply: Reply) => { if (frame.method !== 'slow') reply('done'); };
  host.start({ answer });
  const { db, states } = open(host);
  await until(() => states.includes('attached'));
  const slow = op(db, 'slow');
  await until(() => host.sent(slow.id).length === 1);
  host.stop();
  expect(await settle(slow.outcome)).toEqual({ code: 'unavailable', message: CONNECTION_LOST });
  host.start({ answer });
  await until(() => states.filter(state => state === 'attached').length === 2);
  expect(await rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage)).toBe('done');
  expect(host.sent(slow.id)).toHaveLength(1);
});

test('a listener opened while interrupted is subscribed exactly once after re-attach', async () => {
  const host = new Host();
  const { db, reattached } = await attachedThenDropped(host);
  const restored = listen(db);
  const before = host.frames.length;
  host.start();
  await until(reattached);
  // The socket is ordered: once a later op is answered, every earlier frame has arrived.
  expect(await rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage)).toBe('done');
  const afterAttach = host.frames.slice(before);
  expect(afterAttach.filter(frame => frame.t === 'sub' && frame.subId === restored)).toHaveLength(1);
  expect(afterAttach.filter(frame => frame.t === 'unsub' && frame.subId === restored)).toEqual([]);
});
