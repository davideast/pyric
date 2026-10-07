import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// A permissive Node host with no RTDB rules: every instance, named or not, opens as the default does.
const directory = process.argv[2];
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, permissive: true };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
const notices: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('pyric: RTDB')) notices.push(line);
  else warn(...args);
};
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
const succeeded = (response: OutboundMessage): boolean => response.t === 'res' && response.ok;

try {
  assert.equal(succeeded(await request({ method: 'rtdb.set', path: 'a', value: 1 })), true);
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'other', path: 'a', value: 2 })), true);
  assert.equal(succeeded(await request({ method: 'rtdb.get', instance: 'other', path: 'a' })), true);
  assert.deepEqual(notices, [
    'pyric: RTDB instance "other" has no rules in firebase.json; permissive mode allows all reads and writes. Add {"instance": "other", "rules": "<file>"} to the database array.',
  ]);
} finally {
  console.warn = warn;
  await runtime.close();
}
console.log('Hosted RTDB permissive instances passed');
