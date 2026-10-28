/**
 * The web hosted client resumes its host session after a drop, so the host
 * keeps the same client session, and its one port for that session, across
 * the reconnect. A reply the host sends late, to a call the dropped socket
 * took, reaches the new socket. The real client runs against the real bridge
 * consumer session over loopback `ws` sockets; the host peer is recorded in
 * process and answers by hand, so the test controls when each reply is sent.
 */
import { afterEach, expect, test } from 'bun:test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import { DEFAULT_SANDBOX_PATH, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import { nextId, rawRpc } from '../../../src/serve/worker/client/core.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type ForwardedOp = { clientSessionId: string; id: string; method: string };

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function forwardedOp(message: BridgeMessage): ForwardedOp | undefined {
  const isForwardedOp = message.type === 'worker-message' && message.message.t === 'op';
  if (!isForwardedOp) return undefined;
  const op = message.message as { id: string; method: string };
  return { clientSessionId: message.clientSessionId, id: op.id, method: op.method };
}

/** A bridge whose host peer records every operation the bridge forwards to it. */
async function hostedBridge() {
  const bridge = createBridge({ version: 'test', projectKey: 'orbit' });
  const forwarded: ForwardedOp[] = [];
  bridge.registerSandboxPeer((message) => {
    const op = forwardedOp(message);
    if (op !== undefined) forwarded.push(op);
  }, [], 'host', [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY]);
  const sockets: ServerSocket[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', path: DEFAULT_SANDBOX_PATH });
  server.on('connection', (socket) => {
    sockets.push(socket);
    attachPeer(bridge, socket);
  });
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  const port = typeof address === 'object' ? address.port : 0;
  const reply = (op: ForwardedOp, value: unknown) => {
    bridge.handleSandboxMessage({
      type: 'worker-message-result',
      clientSessionId: op.clientSessionId,
      message: { t: 'res', id: op.id, ok: true, value },
    });
  };
  /** Drops the newest client socket from the host side. */
  const drop = () => { sockets.at(-1)?.terminate(); };
  return { url: `ws://127.0.0.1:${port}${DEFAULT_SANDBOX_PATH}`, forwarded, reply, drop };
}

test('a resumed web hosted client keeps its session, and a late reply to the dropped copy of an RTDB read settles nothing', async () => {
  const host = await hostedBridge();
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({ url: host.url, projectKey: 'orbit', onConnection: state => states.push(state) });
  cleanups.push(() => db.port.close());
  await until(() => states.includes('attached'));
  const read = rawRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.get', path: 'rooms/r1' } as unknown as InboundMessage);
  await until(() => host.forwarded.length === 1);
  const [beforeDrop] = host.forwarded;
  host.drop();
  await until(() => host.forwarded.length === 2);
  const [, sentAgain] = host.forwarded;
  // The premise: the resumed client is the same host session, so the host's port for it is the same.
  expect(sentAgain!.clientSessionId).toBe(beforeDrop!.clientSessionId);
  expect(sentAgain!.method).toBe('rtdb.get');
  expect(sentAgain!.id).not.toBe(beforeDrop!.id);
  host.reply(beforeDrop!, 'before the drop');
  host.reply(sentAgain!, 'after the drop');
  expect(await read).toBe('after the drop');
});
