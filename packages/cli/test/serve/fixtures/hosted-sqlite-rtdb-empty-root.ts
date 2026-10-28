import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// A permissive Node host: the root of an empty database reads as a missing snapshot.
const directory = process.argv[2];
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, permissive: true };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
let sequence = 0;
async function request(message: Record<string, unknown>): Promise<OutboundMessage> {
  const id = `op-${++sequence}`;
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
    reply = response => {
      const isOwnReply = response.t === 'res' && response.id === id;
      if (!isOwnReply) return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({ type: 'worker-message', clientSessionId: 'test', message: { t: 'op', id, ...message } as InboundMessage });
  });
}
function rootSnapshot(response: OutboundMessage): { exists: unknown; value: unknown } {
  assert.ok(response.t === 'res' && response.ok, 'root read failed');
  const { exists, value } = response.value as { exists: unknown; value: unknown };
  return { exists, value };
}

try {
  assert.deepEqual(rootSnapshot(await request({ method: 'rtdb.get', path: '/' })), { exists: false, value: null });
  await request({ method: 'rtdb.set', path: 'a', value: 1 });
  assert.deepEqual(rootSnapshot(await request({ method: 'rtdb.get', path: '/' })), { exists: true, value: { a: 1 } });
  await request({ method: 'rtdb.remove', path: 'a' });
  assert.deepEqual(rootSnapshot(await request({ method: 'rtdb.get', path: '/' })), { exists: false, value: null });
} finally {
  await runtime.close();
}
console.log('Hosted RTDB empty root passed');
