import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN = JSON.stringify({ rules: { '.read': true, '.write': true } });
const SIGNED_IN = JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } });

const directory = process.argv[2];
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  const isReply = frame.type === 'worker-message-result';
  if (isReply) reply(frame.message);
}
let runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
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
async function read(instance: string | undefined, path: string): Promise<unknown> {
  const response = await request({ method: 'rtdb.get', path, actAs: { mode: 'admin' }, ...(instance ? { instance } : {}) });
  assert.ok(response.t === 'res' && response.ok, JSON.stringify(response));
  return (response.value as { value: unknown }).value;
}
const succeeded = (response: OutboundMessage): boolean => response.t === 'res' && response.ok;

try {
  await runtime.deployRules('database', OPEN, 'first');
  await runtime.deployRules('database', SIGNED_IN, 'second');
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'first', path: 'probe', value: 'first' })), true);
  // The second instance's rules require a signed-in user; the first's do not reach it.
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'second', path: 'probe', value: 'second' })), false);
  const signedIn = await request({ method: 'auth.signInAnonymously' });
  assert.equal(succeeded(signedIn), true);
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'second', path: 'probe', value: 'second' })), true);
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'first', path: 'signed', value: true })), true);
  assert.equal(await read(undefined, 'probe'), null);
} finally { await runtime.close(); }

runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory);
try {
  // Each instance's data is saved and restored on its own.
  assert.equal(await read('first', 'probe'), 'first');
  assert.equal(await read('second', 'probe'), 'second');
  assert.equal(await read(undefined, 'probe'), null);
  runtime.databaseRules.declareInstances(new Set(['first']));
  const undeclared = await request({ method: 'rtdb.get', instance: 'second', path: 'probe' });
  assert.equal(undeclared.t === 'res' && !undeclared.ok && undeclared.error.code, 'database/unknown-instance');
  assert.equal(await read('first', 'probe'), 'first');
} finally { await runtime.close(); }
console.log('Hosted RTDB instances passed');
