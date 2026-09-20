import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';

const directory = realpathSync(process.argv[2]);
const payload = { rules: null, rulesHash: null, bridgeUrl: null, seed: null,
  capture: false, hosted: true, projectKey: directory };
const replies: BridgeMessage[] = [];
let runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', message => replies.push(message), directory);
const connection = {};
const methodWrite = runtime.runMethod({
  instanceId: runtime.instanceId, projectDir: directory, key: 'firestore.setDoc',
  args: { path: 'drain/method', data: { value: 'method' } }, allowProduction: false,
}, connection);
runtime.receive({ type: 'tool-call', id: 'tool-write', callerId: 'tools',
  name: 'firestore_create_document', args: { path: 'drain/tool', data: { value: 'tool' } },
  actAs: { mode: 'admin' } });
runtime.receive({ type: 'worker-message', clientSessionId: 'page', message: {
  t: 'op', id: 'page-write', method: 'setDoc', path: 'drain/page', data: { value: 'page' },
  actAs: { mode: 'admin' },
} });

// All three calls are accepted but still queued when close begins.
const closing = runtime.close();
assert.equal(runtime.close(), closing, 'repeated close shares the drain');
const refused = await runtime.runMethod({
  instanceId: runtime.instanceId, projectDir: directory, key: 'firestore.setDoc',
  args: { path: 'drain/late', data: {} }, allowProduction: false,
}, connection);
assert.equal(refused.ok, false, 'new work is refused during close');
const written = await methodWrite;
assert.equal(written.ok, true, JSON.stringify(written));
await closing;
const toolReply = replies.find(message => message.type === 'tool-result' && message.id === 'tool-write');
assert.ok(toolReply?.type === 'tool-result' && toolReply.ok);
const pageReply = replies.find(message => message.type === 'worker-message-result'
  && message.message.t === 'res' && message.message.id === 'page-write');
assert.ok(pageReply?.type === 'worker-message-result' && pageReply.message.t === 'res' && pageReply.message.ok);

// Read through the restarted host, proving close persisted all accepted work.
runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', () => {}, directory);
try {
  for (const owner of ['method', 'tool', 'page']) {
    const result = await runtime.runMethod({
      instanceId: runtime.instanceId, projectDir: directory, key: 'firestore.getDoc',
      args: { path: `drain/${owner}` }, allowProduction: false,
    }, connection);
    assert.equal(result.ok, true);
    assert.ok(JSON.stringify(result.data).includes(`"value":"${owner}"`), JSON.stringify(result));
  }
} finally {
  await runtime.close();
}
console.log('Hosted close drain passed');
