/**
 * Entry-path conformance program — configured `pyric/storage` sandbox.
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
import { getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { initializeSandbox } from 'pyric/sandbox';

const OPEN_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

export async function run(): Promise<void> {
  const storage = getStorageSandbox(initializeSandbox(), { rules: OPEN_RULES });
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
