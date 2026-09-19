import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
const project = process.argv[2];
const persistence = await createHostedPersistence(project);
let reply: (message: OutboundMessage) => void = () => {};
const runtime = await createHostedRuntime({ rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, messaging: true, hosted: true, projectKey: project }, 'http://127.0.0.1:1', frame => {
  const isResult = frame.type === 'worker-message-result';
  if (isResult) reply(frame.message);
}, project, { persistence });
async function request(message: InboundMessage) {
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Service request timed out')), 2000);
    reply = response => {
      const isResponse = response.t === 'res';
      if (isResponse) { clearTimeout(timeout); resolve(response); }
    };
    runtime.receive({ type: 'worker-message', clientSessionId: 'history', message });
  });
}
try {
  const operations: InboundMessage[] = [
    { t: 'op', id: 'auth', method: 'auth.signInAnonymously' },
    { t: 'op', id: 'firestore', method: 'setDoc', path: 'history/document', data: { value: 1 }, actAs: { mode: 'admin' } },
    { t: 'op', id: 'rtdb', method: 'rtdb.set', path: '/history', value: { value: 1 }, actAs: { mode: 'admin' } },
    { t: 'op', id: 'storage', method: 'storage.putBytes', path: 'history/file', dataB64: 'eHl6', actAs: { mode: 'admin' } },
    { t: 'op', id: 'messaging', method: 'messaging.getToken', registrationId: 'history-test', recipientId: 'history-test' },
    { t: 'op', id: 'ai', method: 'ai.countTokens', model: 'synthetic', engine: { kind: 'scripted' }, request: { contents: [{ role: 'user', parts: [{ text: 'test' }] }] } },
  ];
  for (const operation of operations) {
    const result = await request(operation);
    assert.equal(result.t === 'res' && result.ok, true, JSON.stringify(result));
  }
  persistence.history.flush();
  const records = persistence.history.list({ limit: 1000 }).records;
  for (const service of ['auth', 'firestore', 'rtdb', 'storage', 'messaging', 'ai']) {
    assert.ok(records.some(record => record.kind === 'observation' && record.service === service), `Missing ${service} observation`);
  }
  assert.equal(persistence.history.status().healthy, true);
} finally { await runtime.close(); persistence.close(); }
console.log('All services recorded');
