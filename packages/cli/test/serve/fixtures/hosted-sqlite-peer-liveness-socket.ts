// A real `ws` server and client (#965). The client attaches as the web hosted
// client does, registers an RTDB onDisconnect, then sends nothing. The host
// terminates the socket after the liveness window; `ws` emits `close`
// asynchronously after `terminate()`, and the close handler still runs the
// onDisconnect. Real timers, with the window shortened through attachPeer.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type * as Ws from 'ws';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import { WORKER_PORT_CAPABILITY, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// `ws` is a dependency of the CLI package, not of the workspace root this
// fixture's bundle runs from, so resolve it from beside the CLI's modules.
const requireFromCli = createRequire(new URL('../../../src/bridge/protocol.js', import.meta.url));
const { WebSocket, WebSocketServer } = requireFromCli('ws') as typeof Ws;

const WINDOW_MS = 400;
const CONTROL = 'liveness-control';
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
bridge.registerSandboxPeer(runtime.receive, [...runtime.toolNames], runtime.instanceId, [WORKER_PORT_CAPABILITY]);
await runtime.deployRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }));

let serverClosedAt = 0;
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
server.on('connection', (socket) => {
  socket.on('close', () => { serverClosedAt = Date.now(); });
  attachPeer(bridge, socket, true, { livenessTimeoutMs: WINDOW_MS });
});
await once(server, 'listening');
const { port } = server.address() as AddressInfo;

let sequence = 0;
async function readStatus(): Promise<unknown> {
  const id = `control-${++sequence}`;
  const reply = new Promise<OutboundMessage>((resolve) => controlReplies.set(id, resolve));
  const message = { t: 'op', id, method: 'rtdb.get', instance: undefined, path: 'status/u1', actAs: { mode: 'admin' } } as InboundMessage;
  runtime.receive({ type: 'worker-message', clientSessionId: CONTROL, message });
  const response = await reply;
  assert.ok(response.t === 'res' && response.ok, JSON.stringify(response));
  return (response.value as { value: unknown }).value;
}

const client = new WebSocket(`ws://127.0.0.1:${port}`);
const replies = new Map<string, (message: OutboundMessage) => void>();
client.on('message', (raw) => {
  const frame = JSON.parse(String(raw)) as BridgeMessage;
  if (frame.type === 'worker-message-result' && frame.message.t === 'res') replies.get(frame.message.id)?.(frame.message);
});
function op(fields: Record<string, unknown>): Promise<OutboundMessage> {
  const id = `page-${++sequence}`;
  const reply = new Promise<OutboundMessage>((resolve) => replies.set(id, resolve));
  const message = { t: 'op', id, instance: undefined, ...fields } as InboundMessage;
  client.send(JSON.stringify({ type: 'worker-message', message } satisfies BridgeMessage));
  return reply;
}

try {
  await once(client, 'open');
  const acknowledged = once(client, 'message');
  client.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port', clientInfo: { platform: 'browser' } } satisfies BridgeMessage));
  await acknowledged;
  client.send(JSON.stringify({ type: 'ping', id: 'hb-1' } satisfies BridgeMessage));
  assert.ok((await op({ method: 'rtdb.set', path: 'status/u1', value: 'online' })).t === 'res');
  assert.ok((await op({ method: 'rtdb.onDisconnectSet', path: 'status/u1', value: 'offline' })).t === 'res');
  const lastSentAt = Date.now();
  assert.equal(await readStatus(), 'online');

  // The client goes silent. The host terminates it; the client sees an abnormal close.
  const [code] = await once(client, 'close') as [number];
  assert.equal(code, 1006);
  const silentForMs = serverClosedAt - lastSentAt;
  assert.ok(serverClosedAt > 0, 'the server socket did not close');
  assert.ok(silentForMs >= WINDOW_MS - 50, `the host closed the socket after ${silentForMs}ms, before the window`);

  let status = await readStatus();
  for (let attempt = 0; attempt < 40 && status !== 'offline'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    status = await readStatus();
  }
  assert.equal(status, 'offline', 'onDisconnect did not run after the host terminated the socket');
} finally {
  client.terminate();
  server.close();
  await runtime.close();
}
console.log('Peer liveness socket passed');
