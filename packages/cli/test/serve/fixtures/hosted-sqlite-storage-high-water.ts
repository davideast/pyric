import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getStorageSandbox, ref, uploadBytes, type FirebaseStorage } from 'pyric/storage';
import { installStorageBackend, referenceStorageState, resetStorageState, restoreStorageReferences } from 'pyric/storage/internal';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

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

async function write(storage: FirebaseStorage, body: string): Promise<bigint> {
  const result = await uploadBytes(ref(storage, PATH), new Blob([body]));
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
console.log('Storage high-water marks passed');
