import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { loadProjectDatabaseRules } from '../../../src/serve/rules.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { OperationResult } from '../../../src/bridge/surface/types.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// The `database` tool's `instance` argument on the Node host: a firebase.json
// that declares the default instance and a shard, each with its own rules.
const directory = process.argv[2];
writeFileSync(join(directory, 'default.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
writeFileSync(join(directory, 'shard.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': "auth.uid == 'bob'" } }));
const loaded = await loadProjectDatabaseRules(directory, {
  database: [
    { instance: 'demo-default-rtdb', rules: 'default.rules.json' },
    { instance: 'shard-00', rules: 'shard.rules.json' },
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
/** What a client port reads at `path` on `instance`; `undefined` is the default instance. */
async function clientRead(instance: string | undefined, path: string): Promise<unknown> {
  const response = await request({ method: 'rtdb.get', path, actAs: { mode: 'admin' }, ...(instance ? { instance } : {}) });
  assert.ok(response.t === 'res' && response.ok, JSON.stringify(response));
  return (response.value as { value: unknown }).value;
}
const connection = {};
function method(key: string, args: Record<string, unknown>): Promise<OperationResult> {
  return runtime.runMethod({ instanceId: runtime.instanceId, projectDir: directory, key, args, allowProduction: false }, connection);
}

try {
  // A write with an instance reaches that instance's tree, which a client port reads; the default stays empty.
  const written = await method('database.set', { path: 'rooms/lobby', value: { name: 'shard' }, instance: 'shard-00' });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(written.summary, 'Wrote rooms/lobby on shard-00');
  assert.deepEqual(await clientRead('shard-00', 'rooms/lobby'), { name: 'shard' });
  assert.equal(await clientRead(undefined, 'rooms/lobby'), null);

  // The URL form reads the same tree back through the tool.
  const read = await method('database.get', { path: 'rooms/lobby', instance: 'https://shard-00.firebaseio.com' });
  assert.deepEqual(read.data, { exists: true, value: { name: 'shard' } });

  // The project's default instance name and `default` select the default instance.
  const byName = await method('database.set', { path: 'rooms/main', value: 1, instance: 'demo-default-rtdb' });
  assert.equal(byName.summary, 'Wrote rooms/main');
  assert.equal(await clientRead(undefined, 'rooms/main'), 1);
  assert.equal(await clientRead('shard-00', 'rooms/main'), null);
  const byKeyword = await method('database.get', { path: 'rooms/main', instance: 'default' });
  assert.deepEqual(byKeyword.data, { exists: true, value: 1 });

  // An impersonated uid is held to the shard's own rules, not the default's.
  assert.equal((await method('auth.createUser', { uid: 'alice', email: 'alice@example.com' })).ok, true);
  assert.equal((await method('auth.impersonate', { uid: 'alice' })).ok, true);
  const denied = await method('database.set', { path: 'rooms/a', value: 1, instance: 'shard-00' });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.match(denied.summary, /PERMISSION_DENIED/);
  assert.equal((await method('database.set', { path: 'rooms/a', value: 1 })).ok, true);
  assert.equal((await method('auth.createUser', { uid: 'bob', email: 'bob@example.com' })).ok, true);
  assert.equal((await method('auth.impersonate', { uid: 'bob' })).ok, true);
  assert.equal((await method('database.set', { path: 'rooms/a', value: 2, instance: 'shard-00' })).ok, true);
  assert.equal(await clientRead('shard-00', 'rooms/a'), 2);

  // An instance the project does not have is refused with the ones it does.
  const unknown = await method('database.get', { path: 'rooms/lobby', instance: 'shard-09' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.summary,
    'database instance "shard-09" is not declared in firebase.json and holds no data in this sandbox. Known instances: demo-default-rtdb (default), shard-00.');
} finally { await runtime.close(); }
console.log('Hosted database tool instances passed');
