import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeToBuckets, bundleRecords } from 'pyric/sandbox';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

const project = process.argv[2];
let persistence = await createHostedPersistence(project);
const fixture = {
  version: 1 as const,
  firestore: JSON.parse(bundleRecords(serializeToBuckets({ 'notes/one': { answer: 42 } }, {}, 0))),
  auth: null,
  storage: [{ dataBase64: 'invalid base64', blobType: '', metadata: {
    bucket: 'first', fullPath: 'file', name: 'file', size: 1, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
  } }],
};
try {
  assert.throws(() => persistence.seed(fixture), /base64/);
  assert.equal(persistence.state.exists(), false, 'a rejected fixture must not leave partial documents');
} finally { persistence.close(); }
persistence = await createHostedPersistence(project);
try { persistence.seed({ ...fixture, storage: [] }); }
finally { persistence.close(); }
persistence = await createHostedPersistence(project, { fresh: true });
try {
  assert.equal(persistence.state.exists(), false);
  assert.equal(existsSync(join(persistence.state.backupPath, 'state.sqlite')), true);
} finally { persistence.close(); }
const damaged = join(project, 'damaged');
const damagedStore = join(damaged, '.pyric/state/hosted');
mkdirSync(damagedStore, { recursive: true });
writeFileSync(join(damagedStore, 'state.sqlite'), 'physically damaged');
writeFileSync(join(damagedStore, 'state.sqlite-wal'), 'preserve sidecar');
persistence = await createHostedPersistence(damaged, { fresh: true });
try {
  assert.equal(readFileSync(join(persistence.state.backupPath, 'state.sqlite'), 'utf8'), 'physically damaged');
  assert.equal(readFileSync(join(persistence.state.backupPath, 'state.sqlite-wal'), 'utf8'), 'preserve sidecar');
  assert.equal(persistence.state.exists(), false);
} finally { persistence.close(); }
const supportedNodeVersion = process.versions.node;
Object.defineProperty(process.versions, 'node', { value: '20.19.0', configurable: true });
try {
  await assert.rejects(async () => {
    const unsupported = await createHostedPersistence(damaged, { fresh: true });
    unsupported.close();
  }, /requires Node/);
} finally { Object.defineProperty(process.versions, 'node', { value: supportedNodeVersion, configurable: true }); }
const bunVersion = Object.getOwnPropertyDescriptor(process.versions, 'bun');
const directoriesBeforeRefusal = readdirSync(join(damaged, '.pyric/state'));
const databaseBeforeRefusal = readFileSync(join(damagedStore, 'state.sqlite'));
Object.defineProperty(process.versions, 'bun', { value: '1.3.9', configurable: true });
try {
  await assert.rejects(async () => {
    const unsupported = await createHostedPersistence(damaged, { fresh: true });
    unsupported.close();
  }, /Hosted mode is unavailable in the Bun standalone binary/);
  assert.deepEqual(readdirSync(join(damaged, '.pyric/state')), directoriesBeforeRefusal,
    'Bun refusal must precede fresh archiving');
  assert.deepEqual(readFileSync(join(damagedStore, 'state.sqlite')), databaseBeforeRefusal);
} finally {
  if (bunVersion) Object.defineProperty(process.versions, 'bun', bunVersion);
  else Reflect.deleteProperty(process.versions, 'bun');
}
console.log('Lifecycle passed');
