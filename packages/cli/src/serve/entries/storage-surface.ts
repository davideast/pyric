/**
 * The `firebase/storage` surface the served page bundle (`./storage.js`) and a
 * registered Node process (#1082) share.
 *
 * Served apps keep their normal Firebase Storage imports. In worker mode, browse
 * and metadata reads use the shared worker-hosted object store; operations that
 * still lack a worker protocol fail loudly. In in-page fallback mode, the entry
 * delegates to `pyric/storage` against the page sandbox.
 */
import { observeStorageOperation, rulesBucketName } from 'pyric/storage/internal';
import * as ip from 'pyric/storage';
import {
  getStorage as pyricGetStorage,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  getStorage as workerGetStorage,
  getBlob as workerGetBlob,
  getBytes as workerGetBytes,
  getDownloadURL as workerGetDownloadURL,
  getMetadata as workerGetMetadata,
  listAll as workerListAll,
  ref as workerRef,
  uploadBytes as workerUploadBytes,
  uploadString as workerUploadString,
  uploadBytesResumable as workerUploadBytesResumable,
  deleteObject as workerDeleteObject,
} from '../worker/client.js';
import { useWorker } from './worker-runtime.js';
import { sandbox as pageSandbox } from './app-backend.js';
import { hasPendingStorageTargets, resolvePendingStorageTargets } from '../storage-rules-install.js';
import { getApp, type FirebaseApp } from 'pyric/app';
import { workerClientForApp } from './app-client.js';
import { markServiceUsed } from './service-use.js';
import { updateMetadata as unavailableUpdateMetadata } from './unsupported/storage.js';

/**
 * One worker-backed handle per app and bucket name, the default bucket under
 * `''`. A bucket URL naming the app's own bucket is cached under its name too.
 */
const workerStorageByApp = new WeakMap<FirebaseApp, Map<string, FirebaseStorage>>();

export function getStorage(app?: FirebaseApp, bucketUrl?: string): FirebaseStorage {
  const resolved = app ?? getApp();
  markServiceUsed();
  if (!useWorker) {
    // Deploy targets no project resolved at server start resolve with the
    // app's project, as RTDB targets do. Only then are the app's options read:
    // a deleted app's options throw, and a cached factory call must not.
    if (hasPendingStorageTargets(pageSandbox)) {
      for (const notice of resolvePendingStorageTargets(pageSandbox, resolved.options?.projectId)) {
        console.info(`[pyric sandbox] ${notice}`);
      }
    }
    return pyricGetStorage(resolved, bucketUrl);
  }
  // A cached handle comes back before the app's options are read: a deleted
  // app's options throw, and production's cached factory call does not.
  const named = rulesBucketName('', bucketUrl);
  const handles = workerStorageByApp.get(resolved) ?? new Map<string, FirebaseStorage>();
  workerStorageByApp.set(resolved, handles);
  const cached = handles.get(named);
  if (cached) return cached;
  // A bucket URL naming another bucket opens that bucket, with its own
  // objects and its own rules, as production keeps them apart (#1313). The
  // default bucket goes by the app's `storageBucket` option, as the host and
  // firebase-admin name it.
  const configured = resolved.options?.storageBucket;
  const appBucket = typeof configured === 'string' && configured !== '' ? rulesBucketName('', configured) : undefined;
  const namesOtherBucket = named !== '' && named !== appBucket;
  const key = namesOtherBucket ? named : '';
  const existing = handles.get(key);
  if (existing) {
    handles.set(named, existing);
    return existing;
  }
  const client = workerClientForApp(resolved);
  const opened = workerGetStorage(client, undefined, namesOtherBucket ? named : appBucket, namesOtherBucket);
  const handle = Object.assign(opened, { app: resolved }) as unknown as FirebaseStorage;
  handles.set(key, handle);
  handles.set(named, handle);
  if (!namesOtherBucket && appBucket) handles.set(appBucket, handle);
  return handle;
}

export const ref = (useWorker ? workerRef : ip.ref) as typeof ip.ref;
export const listAll = (useWorker ? observeStorageOperation('listAll', workerListAll) : ip.listAll) as typeof ip.listAll;
export const getMetadata = (
  useWorker ? observeStorageOperation('getMetadata', workerGetMetadata) : ip.getMetadata
) as typeof ip.getMetadata;
export const getBlob = (useWorker ? observeStorageOperation('getBlob', workerGetBlob) : ip.getBlob) as typeof ip.getBlob;
export const getDownloadURL = (
  useWorker ? observeStorageOperation('getDownloadURL', workerGetDownloadURL) : ip.getDownloadURL
) as typeof ip.getDownloadURL;

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
    '[pyric sandbox] Pyric replaces the Firebase emulator; connectStorageEmulator is a no-op.',
  );
  if (!useWorker) ip.connectStorageEmulator(storage as FirebaseStorage, _host, _port, _options as never);
}

// Byte ops use the worker protocol (base64 `storage.putBytes` /
// `storage.getBytes` / `storage.deleteObject`) and the initiating app port's
// authenticated session. All app ports reach the same object store and
// ruleset; only their active Auth sessions differ. Payloads are capped at
// 8 MiB per op.
export const uploadBytes = (useWorker ? observeStorageOperation('uploadBytes', workerUploadBytes) : ip.uploadBytes) as typeof ip.uploadBytes;

let selectedUploadBytesResumable = ip.uploadBytesResumable;
const isWorkerMode = useWorker === true;
if (isWorkerMode) {
  selectedUploadBytesResumable = observeStorageOperation('uploadBytesResumable', workerUploadBytesResumable) as unknown as typeof ip.uploadBytesResumable;
}
export const uploadBytesResumable: typeof ip.uploadBytesResumable = selectedUploadBytesResumable;

export const getBytes = (useWorker ? observeStorageOperation('getBytes', workerGetBytes) : ip.getBytes) as typeof ip.getBytes;
export const deleteObject = (useWorker ? observeStorageOperation('deleteObject', workerDeleteObject) : ip.deleteObject) as typeof ip.deleteObject;

export const uploadString = (useWorker ? observeStorageOperation('uploadString', workerUploadString) : ip.uploadString) as typeof ip.uploadString;
export const updateMetadata: typeof ip.updateMetadata = useWorker
  ? observeStorageOperation('updateMetadata', (_ref: Parameters<typeof ip.updateMetadata>[0], ..._args: [Parameters<typeof ip.updateMetadata>[1]]) => unavailableUpdateMetadata())
  : ip.updateMetadata;

export {
  StringFormat,
  StorageErrorCode,
} from 'pyric/storage';

export * from './unsupported/storage.js';
