/**
 * Shared setup for the branch engine's tests: a sandbox holding state in every
 * service a branch carries, and the rule sources it runs under.
 */
import { getAuth } from '../../../src/auth/instances.js';
import { sandbox as authDriver } from '../../../src/auth/sandbox/driver.js';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import { initializeSandbox, type LocalSandbox } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { getAdminStorageSandbox, replaceStorageRules } from '../../../src/storage/internal.js';
import { ref as storageRef, uploadBytes } from '../../../src/storage/index.js';

export const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

export const CANDIDATE_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read: if true; allow write: if false; }
  }
}`;

export const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

export const DATABASE_RULES = { rules: { '.read': true, '.write': true } };

let nextStorageDb = 1;

/**
 * A sandbox holding one value in every service a branch carries.
 *
 * Storage durability is keyed by database name, so the fixture pins one per
 * sandbox. Without that, two sandboxes in one run would share a bucket and a
 * case would read the objects a previous case uploaded.
 */
export async function populatedSandbox(): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  getAdminStorageSandbox(sandbox, { dbName: `pyric-test-storage:${nextStorageDb++}` });
  getInternalEnv(sandbox).seed({
    rules: FIRESTORE_RULES,
    documents: { 'things/a': { v: 1 }, 'things/keep': { v: 100 } },
  });

  const database = getOrCreateBackend(sandbox);
  database.setRules(DATABASE_RULES);
  database.adminSet('rooms/one', { title: 'first' });

  authDriver.seedUsers(getAuth(sandbox), [
    { uid: 'alice', email: 'alice@example.com', password: 'secret-alice', tenantId: 'tenant-a' },
  ]);

  await replaceStorageRules(sandbox, STORAGE_RULES);
  await uploadBytes(
    storageRef(getAdminStorageSandbox(sandbox), 'docs/hello.txt'),
    new Uint8Array([1, 2, 3]),
    { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
  );

  return sandbox;
}
