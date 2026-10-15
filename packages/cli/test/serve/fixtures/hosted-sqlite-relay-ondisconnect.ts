// A real `ws` server and client (#973). Each client attaches as a native or
// Node remote client does (no transport, its own clientSessionId) and
// registers an RTDB onDisconnect with `worker-op`. A clean close runs it; a
// client that pings once and goes silent is terminated after the liveness
// window, and its onDisconnect runs. Re-attaching with the same
// clientSessionId finds the same signed-in user, so running the onDisconnect
// kept the session. Real timers, with the window shortened through attachPeer.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type * as Ws from 'ws';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import { WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, type BridgeMessage, type WorkerResFrame } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// `ws` is a dependency of the CLI package, not of the workspace root this
// fixture's bundle runs from, so resolve it from beside the CLI's modules.
const requireFromCli = createRequire(new URL('../../../src/bridge/protocol.js', import.meta.url));
const { WebSocket, WebSocketServer } = requireFromCli('ws') as typeof Ws;

const WINDOW_MS = 400;
const CONTROL = 'relay-control';
const directory = process.argv[2];
const payload = {
  rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory,
};

const controlReplies = new Map<string, (message: OutboundMessage) => void>();
const bridge = createBridge({ version: 'test' });
const runtime = await createHostedRuntime(payload as never, 'http://127.0.0.1:1', (frame) => {
  const isControlReply = frame.type === 'worker-message-result' && frame.clientSessionId === CONTROL;
  if (isControlReply && frame.message.t === 'res') controlReplies.get(frame.message.id)?.(frame.message);
  bridge.handleSandboxMessage(frame);
}, directory);
bridge.registerSandboxPeer(runtime.receive, [...runtime.toolNames], runtime.instanceId, [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY]);
await runtime.deployRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }));

const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
server.on('connection', (socket) => attachPeer(bridge, socket, true, { livenessTimeoutMs: WINDOW_MS }));
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const clients: Ws.WebSocket[] = [];

/** Wait for `promise`, failing with `message` if it has not settled well past the window. */
async function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), WINDOW_MS + 10_000);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let sequence = 0;
async function readStatus(name: string): Promise<unknown> {
  const id = `control-${++sequence}`;
  const reply = new Promise<OutboundMessage>((resolve) => controlReplies.set(id, resolve));
  const message = { t: 'op', id, method: 'rtdb.get', instance: undefined, path: `status/${name}`, actAs: { mode: 'admin' } } as InboundMessage;
  runtime.receive({ type: 'worker-message', clientSessionId: CONTROL, message });
  const response = await reply;
  assert.ok(response.t === 'res' && response.ok, JSON.stringify(response));
  return (response.value as { value: unknown }).value;
}

async function waitForStatus(name: string, expected: unknown, reason: string): Promise<void> {
  const deadline = Date.now() + WINDOW_MS + 10_000;
  let status = await readStatus(name);
  while (status !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    status = await readStatus(name);
  }
  assert.equal(status, expected, reason);
}

/** Attach over a real socket as a native client does, and return its operation channel. */
async function attachRelayClient(clientSessionId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(socket);
  const replies = new Map<string, (frame: WorkerResFrame) => void>();
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as BridgeMessage;
    if (frame.type === 'worker-res') replies.get(frame.id)?.(frame);
  });
  await once(socket, 'open');
  const acknowledged = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId, clientInfo: { platform: 'kotlin' } } satisfies BridgeMessage));
  await acknowledged;
  async function op(fields: Record<string, unknown>): Promise<unknown> {
    const id = `${clientSessionId}-${++sequence}`;
    const reply = new Promise<WorkerResFrame>((resolve) => replies.set(id, resolve));
    socket.send(JSON.stringify({ type: 'worker-op', id, op: { instance: undefined, ...fields } } as BridgeMessage));
    const response = await reply;
    assert.ok(response.ok, JSON.stringify(response));
    return response.value;
  }
  return { socket, op };
}

/** Sign in, write `online`, and register `offline` as the onDisconnect value. Returns the uid. */
async function goOnline(name: string, op: (fields: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  const credential = await op({ method: 'auth.signInAnonymously' }) as { user: { uid: string } };
  await op({ method: 'rtdb.set', path: `status/${name}`, value: 'online' });
  await op({ method: 'rtdb.onDisconnectSet', path: `status/${name}`, value: 'offline' });
  assert.equal(await readStatus(name), 'online');
  return credential.user.uid;
}

try {
  // (a) A clean close runs the onDisconnect.
  const phone = await attachRelayClient('phone');
  const uid = await goOnline('phone', phone.op);
  phone.socket.close(1000);
  await once(phone.socket, 'close');
  await waitForStatus('phone', 'offline', 'onDisconnect did not run after a clean close');

  // (c) The session survived: re-attaching finds the same signed-in user.
  const reattached = await attachRelayClient('phone');
  const user = await reattached.op({ method: 'auth.getCurrentUser' }) as { uid: string } | null;
  assert.equal(user?.uid, uid, 'the re-attached session lost its signed-in user');
  reattached.socket.close(1000);

  // (b) A client that pings once and goes silent is terminated, and its onDisconnect runs.
  const silent = await attachRelayClient('silent');
  silent.socket.send(JSON.stringify({ type: 'ping', id: 'hb-1' } satisfies BridgeMessage));
  await goOnline('silent', silent.op);
  const [code] = await withDeadline(once(silent.socket, 'close') as Promise<[number]>, 'the silent client was not closed');
  assert.equal(code, 1006);
  await waitForStatus('silent', 'offline', 'onDisconnect did not run after the host closed a silent client');
} finally {
  for (const client of clients) client.terminate();
  server.close();
  await runtime.close();
}
console.log('Relay onDisconnect passed');
