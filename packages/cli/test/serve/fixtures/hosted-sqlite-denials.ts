import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { listDenials } from '../../../src/serve/repro/denials.js';
import { parseRepro } from '../../../src/serve/repro/format.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const rule = "auth != null && data.child('members').child(auth.uid).exists()";
const MEMBERS_ONLY = JSON.stringify({ rules: { rooms: { $roomId: { '.read': rule } } } });
type Res = Extract<OutboundMessage, { t: 'res' }>;

const directory = process.argv[2];
const payload: InitPayload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
const waiting = new Map<string, (response: Res) => void>();
const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', (frame: BridgeMessage) => {
  const isReply = frame.type === 'worker-message-result' && frame.message.t === 'res';
  if (isReply) waiting.get(`${frame.clientSessionId}:${(frame.message as Res).id}`)?.(frame.message as Res);
}, directory);
let sequence = 0;
function request(session: string, message: Record<string, unknown>): Promise<Res> {
  const id = `op-${++sequence}`;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
    waiting.set(`${session}:${id}`, response => { clearTimeout(deadline); resolve(response); });
    runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'op', id, ...message } as InboundMessage });
  });
}
function subscribe(session: string, subId: string, target: Record<string, unknown>): void {
  runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'sub', subId, target } as InboundMessage });
}

try {
  await runtime.deployRules('database', MEMBERS_ONLY, 'demo-app-shard-1');
  await runtime.deployRules('database', MEMBERS_ONLY);
  // The issue's reproduction, on two page loads: each lists r1 on the shard and r2 on the default instance.
  for (const load of ['load-1', 'load-2']) {
    const signedIn = await request(load, { method: 'auth.signInAnonymously' });
    assert.ok(signedIn.ok, JSON.stringify(signedIn));
    subscribe(load, 'r1', { service: 'rtdb', instance: 'demo-app-shard-1', path: '/rooms/r1' });
    const denied = await request(load, { method: 'rtdb.get', path: '/rooms/r2' });
    assert.equal(denied.ok, false);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  const repro = parseRepro(JSON.parse(JSON.stringify(await runtime.captureRepro())));
  const groups = listDenials(repro, {});
  assert.deepEqual(groups.map(({ service, instance, path, rule: matched, count, loads }) => ({ service, instance, path, rule: matched, count, loads })), [
    { service: 'rtdb', instance: 'demo-app-shard-1', path: '/rooms/$roomId', rule, count: 2, loads: 2 },
    { service: 'rtdb', instance: undefined, path: '/rooms/$roomId', rule, count: 2, loads: 2 },
  ]);
  assert.equal(groups.every(group => group.identities.length === 2 && group.instanceUnknown === undefined), true);
  console.log('Denials passed');
} finally { await runtime.close(); }
