import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const directory = process.argv[2];
const stateDirectory = join(directory, '.pyric/state');
mkdirSync(stateDirectory, { recursive: true });
const legacy = join(stateDirectory, 'state.json');
writeFileSync(legacy, 'Unrelated legacy state: must not be read or changed.');
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
let runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
async function request(message: InboundMessage) {
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
    reply = response => {
      const isEvent = response.t !== 'res';
      if (isEvent) return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({ type: 'worker-message', clientSessionId: 'test', message });
  });
}
try {
  const response = await request({ t: 'op', id: 'write', method: 'setDoc', path: 'shared/document', data: { answer: 42 }, actAs: { mode: 'admin' } });
  assert.equal(response.t === 'res' && response.ok, true);
} finally { await runtime.close(); }
assert.equal(existsSync(join(stateDirectory, 'hosted/state.sqlite')), true);
assert.equal(readFileSync(legacy, 'utf8'), 'Unrelated legacy state: must not be read or changed.');
runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
try {
  const response = await request({ t: 'op', id: 'read', method: 'getDoc', path: 'shared/document', actAs: { mode: 'admin' } });
  assert.equal(response.t === 'res' && response.ok, true);
  assert.ok(response.t === 'res' && response.ok);
  assert.deepEqual(response.value, { id: 'document', path: 'shared/document', exists: true,
    data: { valueEncoding: 'pyric/firestore-values/1', json: '{"answer":42}' } });
} finally { await runtime.close(); }
console.log('Hosted restart passed');
