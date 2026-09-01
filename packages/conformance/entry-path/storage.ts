/**
 * Entry-path conformance program — `pyric/app` + `pyric/storage` over an
 * explicitly configured sandbox supplied by the harness.
 *
 * Adapted from Firebase's official web quickstart shape:
 *   - https://firebase.google.com/docs/storage/web/upload-files
 *     (`ref` + `uploadBytes`)
 *
 * The upload doc's `file` "comes from the Blob or File API" — neither
 *     exists in this headless, in-process run, so this program uses a
 *     `Uint8Array` instead, one of `uploadBytes`'s own documented accepted
 *     input types (`Blob | Uint8Array | ArrayBuffer`), not a pyric-specific
 *     shape.
 */
import { initializeApp } from 'pyric/app';
import { getStorage, ref, uploadBytes } from 'pyric/storage';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

const OPEN_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

export async function run(): Promise<void> {
  // Keep the public quickstart initialization in the critical path while the
  // harness supplies the project rules that production normally deploys.
  initializeApp({ projectId: 'entry-path-project' });
  const sandbox = initializeSandbox();
  getAdminStorageSandbox(sandbox, { rules: OPEN_RULES });
  const app = createAppForSandbox(sandbox, { projectId: 'entry-path-project' }, 'entry-path-storage');
  const storage = getStorage(app);
  const storageRef = ref(storage, 'entry-path/quickstart.txt');

  // https://firebase.google.com/docs/storage/web/upload-files — the one
  // real operation this program performs and asserts.
  const bytes = new TextEncoder().encode('entry-path quickstart payload');
  const snapshot = await uploadBytes(storageRef, bytes);

  if (snapshot.metadata.fullPath !== 'entry-path/quickstart.txt') {
    throw new Error(`uploadBytes returned unexpected metadata.fullPath (got ${snapshot.metadata.fullPath})`);
  }
  if (snapshot.metadata.size !== bytes.byteLength) {
    throw new Error(`uploadBytes returned unexpected metadata.size (got ${snapshot.metadata.size}, want ${bytes.byteLength})`);
  }
}
