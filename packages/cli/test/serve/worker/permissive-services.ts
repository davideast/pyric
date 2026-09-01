/** Explicitly open non-security services used by worker transport tests. */
import type { LocalSandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { getStorageSandbox, type FirebaseStorage } from 'pyric/storage';

export const OPEN_STORAGE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if true;
    }
  }
}`;

export function allowRtdbForTransportTests(sandbox: LocalSandbox): void {
  databaseSandbox.setDefaultPolicy(getDatabase(sandbox), 'allow');
}

export function openStorageForTransportTests(
  sandbox: LocalSandbox,
  dbName?: string,
): FirebaseStorage {
  return getStorageSandbox(sandbox, {
    ...(dbName ? { dbName } : {}),
    rules: OPEN_STORAGE_RULES,
  });
}

export function allowWorkerServicesForTransportTests(
  sandbox: LocalSandbox,
  storageDbName?: string,
): void {
  allowRtdbForTransportTests(sandbox);
  openStorageForTransportTests(sandbox, storageDbName);
}
