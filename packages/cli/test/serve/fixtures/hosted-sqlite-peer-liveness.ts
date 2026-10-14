// A heartbeating page that goes silent without closing its socket (#965): the
// host closes it after the liveness window, so its RTDB onDisconnect runs at
// once and its listener is released when the resume retention lapses, as
// after a real close. A page that keeps heartbeating is never closed.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import {
  HOST_PEER_LIVENESS_TIMEOUT_MS,
  HOSTED_HEARTBEAT_INTERVAL_MS,
  WORKER_PORT_CAPABILITY,
  WORKER_SESSION_RETENTION_MS,
  type BridgeMessage,
} from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

const OPEN_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });
const CONTROL = 'liveness-control';
const directory = process.argv[2];
const payload = {
  rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory,
};

const hostFrames: BridgeMessage[] = [];
const bridge = createBridge({ version: 'test' });
const runtime = await createHostedRuntime(payload as never, 'http://127.0.0.1:1', (frame) => {
  hostFrames.push(JSON.parse(JSON.stringify(frame)) as BridgeMessage);
  bridge.handleSandboxMessage(frame);
}, directory);
bridge.registerSandboxPeer(runtime.receive, [...runtime.toolNames], runtime.instanceId, [WORKER_PORT_CAPABILITY]);

/** Let the host's promise chains and SQLite work settle without moving the mocked clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await settle();
}

/** The `ws` surface `attachPeer` consumes. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: BridgeMessage[] = [];
  const self = {
    OPEN: 1,
    readyState: 1,
    sent,
    terminated: false,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return self;
    },
    send(data: string) {
      sent.push(JSON.parse(data) as BridgeMessage);
    },
    close() {
      self.end();
    },
    terminate() {
      self.terminated = true;
      self.end();
    },
    end() {
      const isClosed = self.readyState !== self.OPEN;
      if (isClosed) return;
      self.readyState = 3;
      handlers.get('close')?.();
    },
    receive(message: BridgeMessage) {
      handlers.get('message')?.(Buffer.from(JSON.stringify(message)));
    },
  };
  return self;
}

let sequence = 0;

/** Attach a page over the worker-port transport, register presence, and listen to a room. */
async function openPresencePage() {
  const socket = fakeSocket();
  attachPeer(bridge, socket as never);
  socket.receive({ type: 'attach', protocol: 1, transport: 'worker-port', clientInfo: { platform: 'browser' } });
  const ack = socket.sent.find(frame => frame.type === 'attach-ack');
  assert.ok(ack?.type === 'attach-ack');
  const post = (message: InboundMessage) => socket.receive({ type: 'worker-message', message });
  socket.receive({ type: 'ping', id: `hb-${++sequence}` });
  post({ t: 'op', id: `page-${++sequence}`, method: 'rtdb.set', instance: undefined, path: 'status/u1', value: 'online' });
  post({ t: 'op', id: `page-${++sequence}`, method: 'rtdb.onDisconnectSet', instance: undefined, path: 'status/u1', value: 'offline' });
  post({ t: 'sub', subId: 'room', target: { service: 'rtdb', instance: undefined, path: 'room' } });
  await settle();
  return { socket, clientSessionId: ack.clientSessionId };
}

function controlOp(fields: Record<string, unknown>): string {
  const id = `control-${++sequence}`;
  const message = { t: 'op', id, instance: undefined, actAs: { mode: 'admin' }, ...fields } as InboundMessage;
  runtime.receive({ type: 'worker-message', clientSessionId: CONTROL, message });
  return id;
}

async function readStatus(): Promise<unknown> {
  const id = controlOp({ method: 'rtdb.get', path: 'status/u1' });
  await settle();
  const reply = hostFrames
    .filter(frame => frame.type === 'worker-message-result' && frame.clientSessionId === CONTROL)
    .map(frame => (frame as { message: OutboundMessage }).message)
    .find(message => message.t === 'res' && message.id === id);
  assert.ok(reply?.t === 'res' && reply.ok, JSON.stringify(reply));
  return (reply.value as { value: unknown }).value;
}

async function writeRoom(value: string): Promise<void> {
  controlOp({ method: 'rtdb.set', path: 'room', value });
  await settle();
}

function roomSnaps(clientSessionId: string): number {
  return hostFrames.filter(frame => {
    const isPageResult = frame.type === 'worker-message-result' && frame.clientSessionId === clientSessionId;
    if (!isPageResult) return false;
    const message = frame.message;
    return message.t === 'snap' && message.subId === 'room';
  }).length;
}

try {
  await runtime.deployRules('database', OPEN_RULES);

  // A page that keeps heartbeating outlives the window several times over.
  const live = await openPresencePage();
  const beats = Math.ceil((3 * HOST_PEER_LIVENESS_TIMEOUT_MS) / HOSTED_HEARTBEAT_INTERVAL_MS);
  for (let beat = 0; beat < beats; beat += 1) {
    await advance(HOSTED_HEARTBEAT_INTERVAL_MS);
    live.socket.receive({ type: 'ping', id: `hb-${++sequence}` });
  }
  assert.equal(live.socket.terminated, false, 'a heartbeating page was closed');
  assert.equal(await readStatus(), 'online');
  live.socket.close();
  await settle();
  assert.equal(await readStatus(), 'offline');

  // A page frozen in the back-forward cache: no ping, no close frame.
  const frozen = await openPresencePage();
  assert.equal(await readStatus(), 'online');
  await advance(HOST_PEER_LIVENESS_TIMEOUT_MS - 1);
  assert.equal(frozen.socket.terminated, false, 'the page was closed before the window');
  assert.equal(await readStatus(), 'online');
  await advance(1);
  assert.equal(frozen.socket.terminated, true, 'the host did not close a silent page');
  assert.equal(await readStatus(), 'offline', 'onDisconnect did not run');

  // As after a real close, the session is held for resume and its listener is live.
  const heldSnaps = roomSnaps(frozen.clientSessionId);
  await writeRoom('held');
  assert.ok(roomSnaps(frozen.clientSessionId) > heldSnaps, 'the listener was released before the retention lapsed');

  await advance(WORKER_SESSION_RETENTION_MS);
  const releasedSnaps = roomSnaps(frozen.clientSessionId);
  await writeRoom('released');
  assert.equal(roomSnaps(frozen.clientSessionId), releasedSnaps, 'the listener outlived the retention');
} finally {
  mock.timers.reset();
  await runtime.close();
}
console.log('Peer liveness passed');
