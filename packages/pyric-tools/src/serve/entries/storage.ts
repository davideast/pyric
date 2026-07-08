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
  getMetadata as workerGetMetadata,
  listAll as workerListAll,
  ref as workerRef,
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

export const StorageError = ip.StorageError;

function acceptedNoOp(name: string): void {
  console.info(`[pyric serve] firebase/storage ${name}() is ignored; this page already uses the pyric sandbox.`);
}

export function connectStorageEmulator(
  _storage: unknown,
  _host: string,
  _port: number,
  _options?: unknown,
): void {
  acceptedNoOp('connectStorageEmulator');
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

export const uploadBytes = workerOrInPage('uploadBytes', ip.uploadBytes);
export const uploadString = workerOrInPage('uploadString', ip.uploadString);
export const getBytes = workerOrInPage('getBytes', ip.getBytes);
export const getBlob = workerOrInPage('getBlob', ip.getBlob);
export const deleteObject = workerOrInPage('deleteObject', ip.deleteObject);
export const updateMetadata = workerOrInPage('updateMetadata', ip.updateMetadata);
