import { afterEach, expect, test } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import type { HostedConnectionState } from '../../../../src/serve/worker/client/websocket-connection.js';

// ADR-0019, amended for #990: the web hosted client serves `.info/connected`
// locally and raises `true` only after the whole restore and the held flush.
// An onDisconnect the app registers from that callback, as the Firebase
// presence sample does, is therefore the first frame after them on the new
// socket. The client runs against a real WebSocket server on a loopback port.
// Stopping it drops the client's socket; starting another on the same port
// lets the client re-attach, as a host restarted in place would.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface WorkerFrame { t: string; id?: string; subId?: string; method?: string; path?: string; target?: { path?: string } }
/** A frame the host received, with the 1-based number of the socket it arrived on. */
interface Received { socket: number; frame: WorkerFrame }

class Host {
  readonly received: Received[] = [];
  readonly port: number;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private sockets = 0;

  /** `unanswered` picks the operations the host receives and never replies to. */
  constructor(private readonly unanswered: (frame: WorkerFrame) => boolean = () => false) {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    this.port = probe.port as number;
    void probe.stop(true);
    cleanups.push(() => this.stop());
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/__pyric/sandbox`;
  }

  start(): void {
    const received = this.received;
    const unanswered = this.unanswered;
    const nextSocket = (): number => { this.sockets += 1; return this.sockets; };
    this.server = Bun.serve<{ socket: number }, undefined>({
      port: this.port,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request, { data: { socket: nextSocket() } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(socket, data) {
          const message = JSON.parse(String(data)) as BridgeMessage;
          if (message.type === 'attach') {
            socket.send(JSON.stringify({
              type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true,
              clientSessionId: 'client', projectKey: 'orbit', hostInstanceId: 'host-1',
              capabilities: ['worker-port'],
            } satisfies BridgeMessage));
            return;
          }
          if (message.type !== 'worker-message') return;
          const frame = message.message as WorkerFrame;
          received.push({ socket: socket.data.socket, frame });
          const awaitsReply = frame.t === 'op' || frame.t === 'disconnect';
          if (!awaitsReply || unanswered(frame)) return;
          socket.send(JSON.stringify({ type: 'worker-message-result', message: { t: 'res', id: frame.id, ok: true, value: null } }));
        },
      },
    });
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
  }

  framesOn(socket: number): WorkerFrame[] {
    return this.received.filter(entry => entry.socket === socket).map(entry => entry.frame);
  }
}

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function open(host: Host) {
  const states: HostedConnectionState[] = [];
  const db = client.getHostedFirestore({
    url: host.url,
    projectKey: 'orbit',
    retryInitialConnection: true,
    onConnection: state => states.push(state),
  });
  cleanups.push(() => db.port.close());
  const attaches = () => states.filter(state => state === 'attached').length;
  return { db, database: client.rtdbGetDatabase(db), states, attaches };
}

/**
 * The presence sample from the Firebase docs: on each `true`, queue the disconnect write.
 * A re-arm in flight when the socket drops never settles, as in production (#1088), so
 * the sample's bare call is safe here too.
 */
function rearmPresence(database: client.ClientRtdb): boolean[] {
  const seen: boolean[] = [];
  const status = client.rtdbRef(database, 'status/alice');
  client.rtdbOnValue(client.rtdbRef(database, '.info/connected'), (snapshot) => {
    const connected = snapshot.val() as boolean;
    seen.push(connected);
    if (connected) void client.rtdbOnDisconnect(status).set('offline');
  });
  return seen;
}

const isRearm = (frame: WorkerFrame): boolean => frame.method === 'rtdb.onDisconnectSet' && frame.path === '/status/alice';

/** Whether `promise` is still unsettled once the timers queued now have run. */
async function staysPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const settle = (): void => { settled = true; };
  promise.then(settle, settle);
  await new Promise(resolve => setTimeout(resolve, 50));
  return !settled;
}

/** An onDisconnect the host took and has not answered, as the presence sample issues it. */
async function sentOnDisconnect(host: Host, database: client.ClientRtdb): Promise<{ rearm: Promise<void> }> {
  const rearm = client.rtdbOnDisconnect(client.rtdbRef(database, 'status/alice')).set('offline');
  await until(() => host.framesOn(1).some(isRearm));
  return { rearm };
}

test('.info/connected turns true after the restore and the held flush, so a re-armed onDisconnect follows them', async () => {
  const host = new Host();
  host.start();
  const { database, states, attaches } = open(host);
  const seen = rearmPresence(database);
  client.rtdbOnValue(client.rtdbRef(database, 'rooms'), () => {});
  await until(() => host.framesOn(1).some(isRearm));
  const restoredSub = host.framesOn(1).find(frame => frame.t === 'sub')!;

  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  const held = client.rtdbSet(client.rtdbRef(database, 'rooms/r1'), 'held during the gap');
  host.start();
  await until(() => attaches() === 2);
  await held;
  await until(() => host.framesOn(2).some(isRearm));

  expect(seen).toEqual([false, true, false, true]);
  const second = host.framesOn(2);
  const resubscribed = second.findIndex(frame => frame.t === 'sub' && frame.subId === restoredSub.subId);
  const flushed = second.findIndex(frame => frame.method === 'rtdb.set');
  const rearmed = second.findIndex(isRearm);
  expect(resubscribed).toBeGreaterThanOrEqual(0);
  expect(flushed).toBeGreaterThan(resubscribed);
  expect(rearmed).toBe(flushed + 1);
});

test('.info/connected is never sent to the host or replayed on re-attach', async () => {
  const host = new Host();
  host.start();
  const { database, states, attaches } = open(host);
  rearmPresence(database);
  client.rtdbOnValue(client.rtdbRef(database, '.info'), () => {});
  await until(() => attaches() === 1);
  host.stop();
  await until(() => states.at(-1) === 'interrupted');
  host.start();
  await until(() => host.framesOn(2).some(isRearm));

  const infoFrames = host.received.filter(({ frame }) => JSON.stringify(frame).includes('.info'));
  expect(infoFrames).toEqual([]);
});

// #1215: @firebase/database 1.1.3 ends a deleted app's connection through
// repoInterrupt, which clears its request callbacks, so a sent onDisconnect
// never settles. Rejecting it left the presence sample's bare call unhandled.

test('closing the connection leaves an onDisconnect the host has not answered unsettled', async () => {
  const host = new Host(isRearm);
  host.start();
  const { db, database, attaches } = open(host);
  await until(() => attaches() === 1);
  const { rearm } = await sentOnDisconnect(host, database);

  db.port.close();

  expect(await staysPending(rearm)).toBe(true);
});

test('deleting the app leaves an onDisconnect the host has not answered unsettled', async () => {
  const host = new Host(isRearm);
  host.start();
  const { db, database, attaches } = open(host);
  await until(() => attaches() === 1);
  const { rearm } = await sentOnDisconnect(host, database);

  await client.disconnectClient(db);

  expect(await staysPending(rearm)).toBe(true);
});
