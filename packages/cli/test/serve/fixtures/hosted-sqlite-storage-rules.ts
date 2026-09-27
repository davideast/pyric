import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } }
}`;

const directory = process.argv[2];
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
// A client list is evaluated against the read rules on the prefix.
async function list(id: string): Promise<OutboundMessage> {
  const message: InboundMessage = { t: 'op', id, method: 'storage.listAll', path: 'uploads' };
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
const errorCode = (response: OutboundMessage): string | undefined =>
  response.t === 'res' && !response.ok ? response.error.code : undefined;
try {
  assert.equal(errorCode(await list('without-rules')), 'storage/unauthorized');
  await runtime.deployRules('storage', OPEN_RULES);
  const allowed = await list('with-rules');
  assert.equal(allowed.t === 'res' && allowed.ok, true);
  await runtime.deployRules('storage', null);
  assert.equal(errorCode(await list('rules-removed')), 'storage/unauthorized');
} finally { await runtime.close(); }
console.log('Hosted Storage rules reload passed');
