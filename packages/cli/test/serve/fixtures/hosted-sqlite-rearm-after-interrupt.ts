// A client re-arms presence on the session its old socket just lost (#990).
// The host is told the session was interrupted, and the client re-attaches the
// same clientSessionId at once and registers `onDisconnect().set('offline')`
// again, then writes `online`, as the Firebase presence sample does on
// `.info/connected` turning true. The host chains the drain for the old socket
// ahead of every later frame for that session (`owned.pending` in
// runtime.ts), so the drain runs first and leaves the new registration in
// place: the status reads `online`, and a later interruption runs the new
// registration. Each case sends its frames in one synchronous turn, so the
// order is the one the host received, with no socket in between.
//
// It runs once for a native or remote client (`worker-op`) and once for a web
// page's worker port (`worker-message`).
import assert from 'node:assert/strict';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const CONTROL = 'rearm-control';
const directory = process.argv[2];
const payload = {
  rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory,
};

interface Reply { ok: boolean; value?: unknown; error?: unknown }
const replies = new Map<string, (reply: Reply) => void>();

function replyOf(frame: BridgeMessage): { id: string; reply: Reply } | undefined {
  const isRelayReply = frame.type === 'worker-res';
  if (isRelayReply) return { id: frame.id, reply: frame };
  const isPortReply = frame.type === 'worker-message-result' && frame.message.t === 'res';
  if (isPortReply) {
    const message = frame.message as Extract<OutboundMessage, { t: 'res' }>;
    return { id: message.id, reply: message };
  }
  return undefined;
}

const runtime = await createHostedRuntime(payload as never, 'http://127.0.0.1:1', (frame) => {
  const replied = replyOf(frame);
  if (replied !== undefined) replies.get(replied.id)?.(replied.reply);
}, directory);
await runtime.deployRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }));

let sequence = 0;

/** Hands one operation to the host now; the returned promise settles with its reply. */
function send(session: string, viaRelay: boolean, fields: Record<string, unknown>): Promise<unknown> {
  const id = `${session}-${++sequence}`;
  const reply = new Promise<Reply>((resolve) => replies.set(id, resolve));
  const op = { instance: undefined, ...fields };
  const frame = viaRelay
    ? { type: 'worker-op', id, clientSessionId: session, op }
    : { type: 'worker-message', clientSessionId: session, message: { t: 'op', id, ...op } };
  runtime.receive(frame as BridgeMessage);
  return reply.then((settled) => {
    assert.ok(settled.ok, JSON.stringify(settled));
    return settled.value;
  });
}

function interrupt(session: string): void {
  runtime.receive({ type: 'worker-client-interrupted', clientSessionId: session } as BridgeMessage);
}

async function readStatus(name: string): Promise<unknown> {
  const message = { method: 'rtdb.get', path: `status/${name}`, actAs: { mode: 'admin' } } as Partial<InboundMessage>;
  const value = await send(CONTROL, false, message as Record<string, unknown>);
  return (value as { value: unknown }).value;
}

/** Registers the disconnect write first, then marks the user online. */
function arm(session: string, viaRelay: boolean, name: string): Promise<unknown>[] {
  return [
    send(session, viaRelay, { method: 'rtdb.onDisconnectSet', path: `status/${name}`, value: 'offline' }),
    send(session, viaRelay, { method: 'rtdb.set', path: `status/${name}`, value: 'online' }),
  ];
}

async function rearmsAfterInterrupt(name: string, viaRelay: boolean): Promise<void> {
  await Promise.all(arm(name, viaRelay, name));
  assert.equal(await readStatus(name), 'online');

  // The interruption and the re-registration reach the host in one turn.
  interrupt(name);
  const rearmed = arm(name, viaRelay, name);
  await Promise.all(rearmed);
  assert.equal(await readStatus(name), 'online', `${name}: the drain for the old socket consumed the re-armed onDisconnect`);

  interrupt(name);
  await send(name, viaRelay, { method: 'rtdb.get', path: `status/${name}` });
  assert.equal(await readStatus(name), 'offline', `${name}: a later interruption did not run the re-armed onDisconnect`);
}

try {
  await rearmsAfterInterrupt('phone', true);
  await rearmsAfterInterrupt('page', false);
} finally {
  await runtime.close();
}
console.log('Re-arm after interrupt passed');
