import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

const source = join(process.argv[2], 'damaged');
const output = join(process.argv[2], 'repaired');
const database = await openHostedDatabase(source);
await database.records.putRecords('hosted', new Map<string, unknown>([
  ['meta', { version: 3, savedAt: 0, services: {} }],
  ['00', { docs: { 'shared/valid': { answer: 42 }, 'shared/broken': null } }],
]));
database.close();
const before = new Map(readdirSync(source).map(name => [name, readFileSync(join(source, name))]));
const cli = fileURLToPath(new URL('../../../src/cli/index.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'sandbox', 'salvage', '--source', source, '--out', output], {
  encoding: 'utf8', timeout: 10_000,
});
assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(result.stdout);
assert.deepEqual(report.excluded, [{ namespace: 'hosted', id: 'shared/broken', reason: 'Document validation failed' }]);
assert.deepEqual(JSON.parse(readFileSync(join(output, 'recovery-report.json'), 'utf8')).excluded, report.excluded);
assert.equal(report.recoveredDocuments, 1);
assert.equal(report.excluded.some((entry: { id: string }) => entry.id === 'shared/broken'), true);
assert.deepEqual(readdirSync(source).sort(), [...before.keys()].sort());
for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(source, name)), bytes);
const repaired = await openHostedDatabase(output);
try {
  const records = [...repaired.readRecords('hosted').values()];
  assert.match(JSON.stringify(records), /answer/);
  assert.doesNotMatch(JSON.stringify(records), /broken/);
} finally { repaired.close(); }
await assert.rejects(salvageHostedState(source, output), /exist/);
const damagedMetadata = await openHostedDatabase(source);
damagedMetadata.connection.prepare("UPDATE records SET payload='{' WHERE id='meta'").run();
damagedMetadata.close();
await assert.rejects(salvageHostedState(source, join(process.argv[2], 'invalid-format')), /metadata|format/);
const emptySource = join(process.argv[2], 'empty-recovery');
const emptyStore = await openHostedDatabase(emptySource);
await emptyStore.records.putRecords('hosted', new Map<string, unknown>([
  ['meta', { version: 3, savedAt: 0, services: { auth: { users: [], providers: {} } } }],
  ['00', { docs: { 'notes/broken': null } }],
]));
emptyStore.close();
await assert.rejects(salvageHostedState(emptySource, join(process.argv[2], 'no-replacement')), /No recoverable state/);
const futureSource = join(process.argv[2], 'future-format');
const future = await openHostedDatabase(futureSource);
await future.records.putRecords('hosted', new Map<string, unknown>([
  ['meta', { version: 3, savedAt: 0, services: {} }],
  ['00', { docs: { 'notes/valid': { value: 1 } } }],
  ['01', { docs: {}, encoding: 'pyric/firestore-values/999' }],
]));
future.close();
await assert.rejects(salvageHostedState(futureSource, join(process.argv[2], 'unsupported-output')), /Unsupported Firestore value encoding/);
console.log('Salvage passed');
