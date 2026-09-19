import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { hostedStateDirectory, HOSTED_NAMESPACE } from '../../../src/serve/hosted/persistence.js';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const project = process.argv[2];
const database = await openHostedDatabase(hostedStateDirectory(project));
await database.records.putRecords(HOSTED_NAMESPACE, new Map([['meta', { version: 3, savedAt: 0, services: { auth: { users: 'damaged', providers: {} } } }]]));
database.close();
await assert.rejects(async () => {
  const runtime = await createHostedRuntime({ rules: null, rulesHash: null, bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project }, 'http://127.0.0.1:1', () => {}, project);
  await runtime.close();
}, /salvage/);
for (const name of ['namespace', 'duplicate']) {
  const otherProject = join(project, name);
  const store = await openHostedDatabase(hostedStateDirectory(otherProject));
  const usesForeignNamespace = name === 'namespace';
  const namespace = usesForeignNamespace ? 'foreign' : 'hosted';
  await store.records.putRecords(namespace, new Map<string, unknown>([
    ['meta', { version: 3, savedAt: 0, services: {} }],
    ['00', { docs: { 'notes/one': { value: 1 } } }],
    ['01', { docs: { 'notes/one': { value: 2 } } }],
  ]));
  store.close();
  await assert.rejects(async () => {
    const runtime = await createHostedRuntime({ rules: null, rulesHash: null, bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: otherProject }, 'http://127.0.0.1:1', () => {}, otherProject);
    await runtime.close();
  }, /salvage/);
}
console.log('Malformed state refused');
