import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory, loadHostedSnapshot } from '../../../src/serve/hosted/persistence.js';
import { HOSTED_SCHEMA_VERSION, openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

const root = process.argv[2];

/** Compares bytes without asking assert to render a diff of megabytes on failure. */
function assertSameBytes(actual: Uint8Array | undefined, expected: Uint8Array, message: string): void {
  const same = actual !== undefined && Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
  assert.ok(same, `${message}: ${actual?.byteLength ?? 'no'} bytes differ from the expected ${expected.byteLength}`);
}

const MiB = 1024 * 1024;
const bucket = 'pyric-default';
const body = new TextEncoder().encode('stored before the upgrade');
const large = new Uint8Array(8 * MiB).map((_, index) => (index * 17) % 253);
const objects = [
  { path: 'notes/before.txt', bytes: body, mime: 'text/plain' },
  { path: 'media/large.bin', bytes: large, mime: 'application/octet-stream' },
  // The same bytes under a second path are stored once after the upgrade.
  { path: 'media/twin.bin', bytes: large, mime: 'application/octet-stream' },
];
const records = [
  ['meta', { version: 3, savedAt: 0, services: { auth: { users: [], providers: {} } } }],
  ['00', { docs: { 'notes/kept': { answer: 42 } } }],
] as const;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const metadata = (path: string, size: number, contentType: string) => ({
  bucket, fullPath: path, name: path.slice(path.lastIndexOf('/') + 1), size, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType,
});

/** Tables as each earlier release created them, byte for byte in shape. */
const RECORDS_TABLE = 'CREATE TABLE records (namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, id)) STRICT';
const INLINE_OBJECTS_TABLE = `CREATE TABLE storage_objects (
  bucket TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (bucket, path)
) STRICT`;
/** The staging table a failed open of a version-1 database left behind. */
const NINE_COLUMN_STAGING = `CREATE TABLE storage_uploads (
  upload_id TEXT PRIMARY KEY, connection_id TEXT, bucket TEXT NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, content_type TEXT, custom_metadata TEXT, bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT`;
const VERSION_2_STAGING = `CREATE TABLE storage_uploads (
  upload_id TEXT NOT NULL, connection_id TEXT, bucket TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
  content_type TEXT, custom_metadata TEXT, part_index INTEGER NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_index)
) STRICT`;

type EarlierSchema = 'version-1' | 'version-1-nine-column-staging' | 'version-2';
const EARLIER_SCHEMAS: readonly EarlierSchema[] = ['version-1', 'version-1-nine-column-staging', 'version-2'];

/** A project whose hosted state an earlier release wrote, with bytes inline in SQLite. */
function earlierRelease(name: string, schema: EarlierSchema): string {
  const project = mkdtempSync(join(root, `${name}-`));
  const directory = hostedStateDirectory(project);
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec('PRAGMA journal_mode=WAL');
  database.exec(RECORDS_TABLE);
  database.exec(INLINE_OBJECTS_TABLE);
  if (schema === 'version-1-nine-column-staging') database.exec(NINE_COLUMN_STAGING);
  if (schema === 'version-2') database.exec(VERSION_2_STAGING);
  const insertRecord = database.prepare('INSERT INTO records VALUES (?, ?, ?)');
  for (const [id, payload] of records) insertRecord.run('hosted', id, JSON.stringify(payload));
  const insertObject = database.prepare('INSERT INTO storage_objects VALUES (?, ?, ?, ?, ?)');
  for (const object of objects) {
    insertObject.run(bucket, object.path, JSON.stringify(metadata(object.path, object.bytes.byteLength, object.mime)), object.mime, object.bytes);
  }
  database.exec(`PRAGMA user_version=${schema === 'version-2' ? 2 : 1}`);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  return project;
}

function inspect(project: string) {
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    const staging = database.prepare('PRAGMA table_info(storage_uploads)').all().map(row => String(row.name));
    const columns = database.prepare('PRAGMA table_info(storage_objects)').all().map(row => String(row.name));
    const records = Number(database.prepare('SELECT count(*) AS n FROM records').get()?.n);
    return { version, staging, columns, records };
  } finally { database.close(); }
}

const objectsDirectory = (project: string): string => join(hostedStateDirectory(project), 'objects');
const objectFile = (project: string, bytes: Uint8Array): string => {
  const hash = sha256(bytes);
  return join(objectsDirectory(project), hash.slice(0, 2), hash);
};

async function assertObjectsReadable(storage: Awaited<ReturnType<typeof createHostedPersistence>>['storage']): Promise<void> {
  for (const object of objects) {
    const blob = await storage.getBlob(object.path, bucket);
    assertSameBytes(new Uint8Array(await blob!.arrayBuffer()), object.bytes, object.path);
    assert.equal(blob!.type, object.mime);
  }
}

async function chunkedRoundTrip(project: string): Promise<void> {
  const persistence = await createHostedPersistence(project);
  try {
    const bytes = new TextEncoder().encode('staged after the upgrade');
    const uploadId = await persistence.storage.beginUpload(bucket, 'notes/after.txt', bytes.byteLength, 'text/plain');
    await persistence.storage.putPart(uploadId, 0, bytes);
    assert.deepEqual(await persistence.storage.readUpload(uploadId), bytes);
    await persistence.storage.abortUpload(uploadId);
    await assertObjectsReadable(persistence.storage);
  } finally { persistence.close(); }
}

// A new database starts at the current version with bytes outside SQLite.
{
  const project = mkdtempSync(join(root, 'new-'));
  (await createHostedPersistence(project)).close();
  const state = inspect(project);
  assert.equal(state.version, HOSTED_SCHEMA_VERSION);
  assert.ok(state.staging.includes('part_index'));
  assert.equal(state.columns.includes('bytes'), false);
}

// Every earlier schema opens, moves its bytes to files, drops the column, and keeps its data.
for (const schema of EARLIER_SCHEMAS) {
  const project = earlierRelease(schema, schema);
  const before = inspect(project);
  assert.ok(before.columns.includes('bytes'), `${schema}: bytes inline before the upgrade`);
  await chunkedRoundTrip(project);
  const after = inspect(project);
  assert.equal(after.version, HOSTED_SCHEMA_VERSION, `${schema}: version after upgrade`);
  assert.ok(after.staging.includes('part_index'), `${schema}: staging shape after upgrade`);
  assert.deepEqual(after.columns, ['bucket', 'path', 'metadata', 'mime', 'sha256', 'size'], `${schema}: object columns after upgrade`);
  assert.equal(after.records, before.records);
  for (const object of objects) assertSameBytes(readFileSync(objectFile(project, object.bytes)), object.bytes, `${schema}: ${object.path} file`);
  // The database no longer holds the bytes, and gives their space back.
  const databaseSize = statSync(join(hostedStateDirectory(project), 'state.sqlite')).size;
  assert.ok(databaseSize < MiB, `${schema}: state.sqlite is ${databaseSize} bytes after upgrade`);
  // Opening again is a no-op for the schema.
  (await openHostedDatabase(hostedStateDirectory(project))).close();
  assert.equal(inspect(project).version, HOSTED_SCHEMA_VERSION);
}

// An earlier store that fails validation is refused and left exactly as it was found.
for (const schema of EARLIER_SCHEMAS) {
  const project = earlierRelease(`refused-${schema}`, schema);
  const path = join(hostedStateDirectory(project), 'state.sqlite');
  const database = new DatabaseSync(path);
  database.exec("INSERT INTO records VALUES ('unknown-namespace', 'x', '{}')");
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  const bytesBefore = readFileSync(path);
  await assert.rejects(createHostedPersistence(project), /Hosted state could not be restored/);
  assertSameBytes(readFileSync(path), bytesBefore, `${schema}: database unchanged`);
  assert.equal(existsSync(objectsDirectory(project)), false, `${schema}: no object files written`);
  assert.ok(inspect(project).columns.includes('bytes'));
}

// A migration that cannot write its files leaves an intact version-2 store, which the next start migrates.
{
  const project = earlierRelease('interrupted', 'version-2');
  writeFileSync(objectsDirectory(project), 'not a directory');
  await assert.rejects(createHostedPersistence(project), /Hosted state could not be restored/);
  const interrupted = inspect(project);
  assert.equal(interrupted.version, 2);
  assert.ok(interrupted.columns.includes('bytes'));
  rmSync(objectsDirectory(project));
  const persistence = await createHostedPersistence(project);
  try { await assertObjectsReadable(persistence.storage); } finally { persistence.close(); }
  assert.equal(inspect(project).version, HOSTED_SCHEMA_VERSION);
}

// A read-only export of an earlier store reads its inline bytes without changing anything.
for (const schema of EARLIER_SCHEMAS) {
  const project = earlierRelease(`read-only-${schema}`, schema);
  const path = join(hostedStateDirectory(project), 'state.sqlite');
  const bytesBefore = readFileSync(path);
  const snapshot = await loadHostedSnapshot(project);
  assert.equal(snapshot?.storage?.length, objects.length);
  const exported = snapshot!.storage!.find(object => object.metadata.fullPath === 'notes/before.txt');
  assertSameBytes(Buffer.from(exported!.dataBase64, 'base64'), body, `${schema}: exported object`);
  assertSameBytes(readFileSync(path), bytesBefore, `${schema}: database unchanged by export`);
  assert.equal(inspect(project).version, schema === 'version-2' ? 2 : 1);
  assert.equal(existsSync(objectsDirectory(project)), false);
}

// A read-only export of a current store reads the object files.
{
  const project = earlierRelease('export-current', 'version-2');
  (await createHostedPersistence(project)).close();
  const snapshot = await loadHostedSnapshot(project);
  const exported = snapshot!.storage!.find(object => object.metadata.fullPath === 'media/large.bin');
  assertSameBytes(Buffer.from(exported!.dataBase64, 'base64'), large, 'exported object');
}

// Salvage accepts a source from every schema and writes a current-version output with its objects.
for (const schema of [...EARLIER_SCHEMAS, 'current'] as const) {
  const project = earlierRelease(`salvage-${schema}`, schema === 'current' ? 'version-2' : schema);
  if (schema === 'current') (await createHostedPersistence(project)).close();
  const output = join(root, `salvaged-${schema}`);
  const report = await salvageHostedState(hostedStateDirectory(project), output);
  assert.equal(report.recoveredObjects, objects.length, `${schema}: recovered objects`);
  assert.deepEqual(report.excluded, []);
  const database = new DatabaseSync(join(output, 'state.sqlite'), { readOnly: true });
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), HOSTED_SCHEMA_VERSION);
  database.close();
  const recovered = await openHostedDatabase(output);
  try { await assertObjectsReadable(recovered.storage); } finally { recovered.close(); }
}

// Salvage refuses a source whose object directory holds a symlink.
{
  const project = earlierRelease('salvage-symlink', 'version-2');
  (await createHostedPersistence(project)).close();
  symlinkSync('/etc/hosts', join(objectsDirectory(project), 'linked'));
  await assert.rejects(salvageHostedState(hostedStateDirectory(project), join(root, 'salvaged-symlink')), /symlink/);
}

console.log('Schema upgrade passed');
