import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';
import { archiveHostedDirectory } from '../../../src/serve/hosted/persistence/archive.js';

const directory = process.argv[2];
const source = join(directory, 'crashed');
const original = await openHostedDatabase(source);
await original.records.putRecords('hosted', new Map<string, unknown>([
  ['meta', { version: 3, savedAt: 0, services: {} }],
  ['00', { docs: { 'notes/acknowledged': { revision: 1 } } }],
]));
original.close();
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import { DatabaseSync } from 'node:sqlite';
  const database = new DatabaseSync(process.argv[1]);
  database.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
  database.prepare("UPDATE records SET payload=? WHERE namespace='hosted' AND id='00'")
    .run(JSON.stringify({ docs: { 'notes/acknowledged': { revision: 2 } } }));
  process.stdout.write('committed');
  setInterval(() => {}, 1000);
`, join(source, 'state.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
try {
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(() => { throw new Error('Writer exited before committing to WAL.'); }),
  ]);
  child.kill('SIGKILL');
  await exited;
} finally { clearTimeout(deadline); child.kill('SIGKILL'); }
assert.ok(readFileSync(join(source, 'state.sqlite-wal')).length > 0);
rmSync(join(source, 'state.sqlite-shm'));
assert.equal(existsSync(join(source, 'state.sqlite-shm')), false);
const before = new Map(readdirSync(source).map(name => [name, readFileSync(join(source, name))]));

const repairedPath = join(directory, 'repaired');
const report = await salvageHostedState(source, repairedPath);
assert.equal(report.recoveredDocuments, 1);
assert.deepEqual(report.excluded, []);
const repaired = await openHostedDatabase(repairedPath);
try {
  assert.match(JSON.stringify([...repaired.readRecords('hosted').values()]), /"revision":2/);
} finally { repaired.close(); }
assert.deepEqual(readdirSync(source).sort(), [...before.keys()].sort());
for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(source, name)), bytes);

const archiveSource = join(directory, 'to-archive');
cpSync(source, archiveSource, { recursive: true });
assert.equal(existsSync(join(archiveSource, 'state.sqlite-shm')), false);
const archivedPath = await archiveHostedDirectory(archiveSource);
assert.ok(archivedPath);
assert.equal(existsSync(archiveSource), false);
const archived = await openHostedDatabase(archivedPath);
try {
  assert.deepEqual(archived.readRecord('hosted', '00'), { docs: { 'notes/acknowledged': { revision: 2 } } });
} finally { archived.close(); }
console.log('WAL recovery passed');
