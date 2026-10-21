import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { deleteObject, getStorageSandbox, ref, uploadBytes, type FirebaseStorage } from 'pyric/storage';
import { installStorageBackend, referenceStorageState, resetStorageState, restoreStorageReferences } from 'pyric/storage/internal';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

// Generation high-water marks on the Node host's SQLite store (issue #1160):
// two sandboxes on one store writing one path concurrently, a reopen followed
// by a restore to an earlier capture, and a reset never repeat a generation.
const RULES = "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }";
const FIXED_AT = Date.UTC(2030, 0, 1);
const PATH = 'media/clip.bin';
const directory = process.argv[2];

type Database = Awaited<ReturnType<typeof openHostedDatabase>>;

function frozenStorage(database: Database): FirebaseStorage {
  const sandbox = initializeSandbox();
  installStorageBackend(sandbox, database.storage);
  getClock(sandbox).set(FIXED_AT);
  return getStorageSandbox(sandbox, { rules: RULES });
}

async function write(storage: FirebaseStorage, body: string, path = PATH): Promise<bigint> {
  const result = await uploadBytes(ref(storage, path), new Blob([body]));
  return BigInt(result.metadata.generation);
}

// Two sandboxes sharing one store.
let database = await openHostedDatabase(directory);
try {
  const [a, b] = [frozenStorage(database), frozenStorage(database)];
  const generations = await Promise.all([write(a, 'a'), write(b, 'b'), write(a, 'c'), write(b, 'd')]);
  assert.equal(new Set(generations).size, 4, `generations ${generations.join(', ')} repeat`);
} finally { database.close(); }

// A reopen, then a restore to an earlier capture.
let earlier: Awaited<ReturnType<typeof referenceStorageState>>;
let later: bigint;
database = await openHostedDatabase(directory);
try {
  const storage = frozenStorage(database);
  await write(storage, 'e');
  earlier = await referenceStorageState(storage);
  later = await write(storage, 'f');
} finally { database.close(); }
database = await openHostedDatabase(directory);
try {
  const storage = frozenStorage(database);
  await restoreStorageReferences(storage, earlier);
  const next = await write(storage, 'g');
  assert.ok(next > later, `generation ${next} after the restore does not pass ${later}`);
  // A reset keeps the marks.
  await resetStorageState(storage);
  assert.ok(await write(storage, 'h') > next, 'generation after a reset does not pass the one before it');
} finally { database.close(); }
// A delete between two concurrent writes.
database = await openHostedDatabase(directory);
try {
  const storage = database.storage;
  const issueAbove = (floor: string | undefined): string => String(BigInt(floor ?? '0') + 1n);
  const metadataFor = () => ({
    bucket: 'pyric-default', fullPath: 'raced.bin', name: 'raced.bin', size: 1, generation: '0', metageneration: '1',
    timeCreated: '2030-01-01T00:00:00Z', updated: '2030-01-01T00:00:00Z', contentType: 'application/octet-stream',
  });
  const [first, second] = [metadataFor(), metadataFor()];
  await Promise.all([
    storage.put('raced.bin', new Blob(['a']), first, issueAbove),
    storage.delete('raced.bin'),
    storage.put('raced.bin', new Blob(['b']), second, issueAbove),
  ]);
  assert.ok(BigInt(second.generation) > BigInt(first.generation), `generations ${first.generation}, ${second.generation} do not increase`);
} finally { database.close(); }

// Salvage keeps the marks, even for an object deleted before it.
const damaged = join(directory, 'salvage-source');
const repaired = join(directory, 'salvage-output');
let deleted: bigint;
database = await openHostedDatabase(damaged);
try {
  const storage = frozenStorage(database);
  await write(storage, 'a', 'p.bin');
  deleted = await write(storage, 'b', 'p.bin');
  await deleteObject(ref(storage, 'p.bin'));
  // Salvage needs some state to recover.
  await write(storage, 'kept', 'kept.bin');
} finally { database.close(); }
await salvageHostedState(damaged, repaired);
database = await openHostedDatabase(repaired);
try {
  const next = await write(frozenStorage(database), 'c', 'p.bin');
  assert.ok(next > deleted, `generation ${next} after salvage does not pass ${deleted}`);
} finally { database.close(); }
console.log('Storage high-water marks passed');
