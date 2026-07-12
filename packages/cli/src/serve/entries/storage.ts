/**
 * The bundle the import map serves for `firebase/storage`.
 *
 * Served apps keep their normal Firebase Storage imports. In worker mode, browse
 * and metadata reads use the shared worker-hosted object store; operations that
 * still lack a worker protocol fail loudly. In in-page fallback mode, the entry
 * delegates to `pyric/storage` against the page sandbox.
 */
import * as ip from 'pyric/storage';
import {
  getStorage as pyricGetStorage,
  getStorageSandbox,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  getStorage as workerGetStorage,
  getBlob as workerGetBlob,
  getBytes as workerGetBytes,
  getMetadata as workerGetMetadata,
  listAll as workerListAll,
  ref as workerRef,
  uploadBytes as workerUploadBytes,
  deleteObject as workerDeleteObject,
} from '../worker/client.js';
import { sandbox, useWorker, workerDb } from './runtime.js';

export function getStorage(app?: unknown, _bucketUrl?: string): FirebaseStorage {
  if (useWorker) return workerGetStorage(workerDb!) as unknown as FirebaseStorage;
  return app ? pyricGetStorage(app as never) : getStorageSandbox(sandbox);
}

export const ref = (useWorker ? workerRef : ip.ref) as typeof ip.ref;
export const listAll = (useWorker ? workerListAll : ip.listAll) as typeof ip.listAll;
export const getMetadata = (
  useWorker ? workerGetMetadata : ip.getMetadata
) as typeof ip.getMetadata;
export const getBlob = (useWorker ? workerGetBlob : ip.getBlob) as typeof ip.getBlob;

export const StorageError = ip.StorageError;

// pyric replaces the Firebase emulator; connectStorageEmulator is a
// no-op. Served apps are already talking to the pyric sandbox (or the
// SharedWorker's shared store), which IS the local emulator — pointing
// it at a `firebase-tools` emulator host would be a step backward, not
// forward, so the call is logged and swallowed rather than forwarded.
export function connectStorageEmulator(
  storage: unknown,
  _host: string,
  _port: number,
  _options?: unknown,
): void {
  console.info(
    '[pyric dev] pyric replaces the Firebase emulator; connectStorageEmulator is a no-op.',
  );
  if (!useWorker) ip.connectStorageEmulator(storage as FirebaseStorage, _host, _port, _options as never);
}

function unsupportedWorkerApi(name: string): never {
  throw new Error(
    `firebase/storage ${name}() is not supported over the pyric SharedWorker yet. ` +
      'Use the in-page fallback for this operation.',
  );
}

function workerOrInPage<T extends (...args: any[]) => unknown>(name: string, fn: T): T {
  return (useWorker ? (() => unsupportedWorkerApi(name)) : fn) as T;
}

// Byte ops now have a worker protocol (base64 `storage.putBytes` /
// `storage.getBytes` / `storage.deleteObject`), so worker mode routes them to
// the shared object store instead of throwing. No lens is attached (these
// calls run as the shared anonymous page handle — `actAs` absent), but the
// served worker's `applyServeInit` configures the sandbox's storage.rules at
// boot (before any op can run), so that shared handle enforces them like
// every other lens (see `lensStorage` in host.ts). The admin lens matters for
// embedding/test hosts that pre-open the service with rules. Payloads are
// capped at 8 MiB per op.
export const uploadBytes = (useWorker ? workerUploadBytes : ip.uploadBytes) as typeof ip.uploadBytes;
export const getBytes = (useWorker ? workerGetBytes : ip.getBytes) as typeof ip.getBytes;
export const deleteObject = (useWorker ? workerDeleteObject : ip.deleteObject) as typeof ip.deleteObject;

export const uploadString = workerOrInPage('uploadString', ip.uploadString);
export const updateMetadata = workerOrInPage('updateMetadata', ip.updateMetadata);
