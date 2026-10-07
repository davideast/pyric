import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { loadProjectDatabaseRules } from '../../../src/serve/rules.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// A project whose firebase.json declares two instances, each with its own rules file.
const directory = process.argv[2];
writeFileSync(join(directory, 'default.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
writeFileSync(join(directory, 'second.rules.json'), JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }));
const loaded = await loadProjectDatabaseRules(directory, {
  database: [
    { instance: 'demo-default-rtdb', rules: 'default.rules.json' },
    { instance: 'second', rules: 'second.rules.json' },
  ],
}, { projectId: 'demo' });
const databaseInstances = {
  defaultInstance: loaded.defaultInstance,
  rules: Object.fromEntries([...loaded.declared].map((instance) => [instance, loaded.instances.get(instance)?.rules ?? null])),
};
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory,
  databaseRules: databaseInstances.rules[loaded.defaultInstance] ?? null, databaseInstances };
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
const succeeded = (response: OutboundMessage): boolean => response.t === 'res' && response.ok;
const code = (response: OutboundMessage): string | undefined =>
  response.t === 'res' && !response.ok ? response.error.code : undefined;

try {
  // The default instance, by no name and by its firebase.json name, runs default.rules.json.
  assert.equal(succeeded(await request({ method: 'rtdb.set', path: 'a', value: 1 })), true);
  const byName = await request({ method: 'rtdb.get', instance: 'demo-default-rtdb', path: 'a' });
  assert.ok(byName.t === 'res' && byName.ok);
  assert.equal((byName.value as { value: unknown }).value, 1);
  // The second instance runs second.rules.json and keeps its own data.
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'second', path: 'a', value: 2 })), false);
  // An instance firebase.json does not declare is not served.
  assert.equal(code(await request({ method: 'rtdb.get', instance: 'third', path: 'a' })), 'database/unknown-instance');
  // A reload of one instance's rules file reaches only that instance.
  await runtime.deployRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }), 'second');
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'second', path: 'a', value: 2 })), true);
  const second = await request({ method: 'rtdb.get', instance: 'second', path: 'a' });
  assert.ok(second.t === 'res' && second.ok);
  assert.equal((second.value as { value: unknown }).value, 2);
  await runtime.deployRules('database', JSON.stringify({ rules: { '.read': false, '.write': false } }));
  assert.equal(succeeded(await request({ method: 'rtdb.set', path: 'a', value: 3 })), false);
  assert.equal(succeeded(await request({ method: 'rtdb.set', instance: 'second', path: 'b', value: 3 })), true);
} finally { await runtime.close(); }
console.log('Hosted RTDB firebase.json instances passed');
