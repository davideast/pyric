import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, installStorageBackend } from 'pyric/storage/internal';
import { ref, uploadBytes } from 'pyric/storage';
import { createHostedPersistence, hostedStateDirectory, loadHostedSnapshot } from '../../../src/serve/hosted/persistence.js';
import { HOSTED_SCHEMA_VERSION, openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

const root = process.argv[2];
const body = 'stored before the upgrade';

/** The staging table as the failed open of a previous-schema database left it. */
const NINE_COLUMN_STAGING = `CREATE TABLE storage_uploads (
  upload_id TEXT PRIMARY KEY, connection_id TEXT, bucket TEXT NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, content_type TEXT, custom_metadata TEXT, bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT`;

/** A project whose hosted state the release before chunked transfer wrote. */
async function previousRelease(name: string, staging: 'none' | 'nine-column'): Promise<string> {
  const project = mkdtempSync(join(root, `${name}-`));
  const persistence = await createHostedPersistence(project);
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, persistence.storage);
  await sandbox.enablePersistence({ key: 'hosted', injectedBackend: persistence.backend });
  await uploadBytes(ref(getAdminStorageSandbox(sandbox), 'notes/before.txt'), new TextEncoder().encode(body));
  await new Promise((resolve) => setTimeout(resolve, 200));
  sandbox.dispose();
  persistence.close();
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'));
  database.exec('DROP TABLE storage_uploads');
  if (staging === 'nine-column') database.exec(NINE_COLUMN_STAGING);
  database.exec('PRAGMA user_version=1');
  database.close();
  return project;
}

function inspect(project: string) {
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    const columns = database.prepare('PRAGMA table_info(storage_uploads)').all().map((row) => String(row.name));
    const objects = database.prepare('SELECT path FROM storage_objects').all().map((row) => String(row.path));
    const records = Number(database.prepare('SELECT count(*) AS n FROM records').get()?.n);
    return { version, columns, objects, records };
  } finally { database.close(); }
}

async function chunkedRoundTrip(project: string): Promise<void> {
  const persistence = await createHostedPersistence(project);
  try {
    const bytes = new TextEncoder().encode('staged after the upgrade');
    const uploadId = await persistence.storage.beginUpload('pyric-default', 'notes/after.txt', bytes.byteLength, 'text/plain');
    await persistence.storage.putPart(uploadId, 0, bytes);
    const stored = await persistence.storage.finishUpload(uploadId);
    assert.equal(stored.size, bytes.byteLength);
    assert.equal(await (await persistence.storage.getBlob('notes/before.txt', 'pyric-default'))?.text(), body);
  } finally { persistence.close(); }
}

// A new database starts at the current version with the current staging shape.
{
  const project = mkdtempSync(join(root, 'new-'));
  (await createHostedPersistence(project)).close();
  const state = inspect(project);
  assert.equal(state.version, HOSTED_SCHEMA_VERSION);
  assert.ok(state.columns.includes('part_index'));
}

// Both previous-release shapes open, upgrade in place, keep their data, and accept chunked uploads.
for (const staging of ['none', 'nine-column'] as const) {
  const project = await previousRelease(`previous-${staging}`, staging);
  const before = inspect(project);
  assert.equal(before.version, 1);
  await chunkedRoundTrip(project);
  const after = inspect(project);
  assert.equal(after.version, HOSTED_SCHEMA_VERSION, `${staging}: version after upgrade`);
  assert.ok(after.columns.includes('part_index'), `${staging}: staging shape after upgrade`);
  assert.deepEqual(after.objects.filter((path) => path === 'notes/before.txt'), ['notes/before.txt']);
  assert.equal(after.records, before.records);
  // Opening again is a no-op for the schema.
  (await openHostedDatabase(hostedStateDirectory(project))).close();
  assert.equal(inspect(project).version, HOSTED_SCHEMA_VERSION);
}

// A read-only export of a previous-release database reads it without changing the file.
{
  const project = await previousRelease('read-only', 'none');
  const path = join(hostedStateDirectory(project), 'state.sqlite');
  const bytesBefore = readFileSync(path);
  const snapshot = await loadHostedSnapshot(project);
  assert.equal(snapshot?.storage?.length, 1);
  assert.deepEqual(readFileSync(path), bytesBefore);
  assert.equal(inspect(project).version, 1);
}

// Salvage accepts a previous-release source and writes a current-version output.
{
  const project = await previousRelease('salvage', 'nine-column');
  const output = join(root, 'salvaged');
  const report = await salvageHostedState(hostedStateDirectory(project), output);
  assert.equal(report.recoveredObjects, 1);
  assert.deepEqual(report.excluded, []);
  const database = new DatabaseSync(join(output, 'state.sqlite'), { readOnly: true });
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), HOSTED_SCHEMA_VERSION);
  database.close();
}

console.log('Schema upgrade passed');
