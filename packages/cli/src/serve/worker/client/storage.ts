/**
 * Worker-backed FirebaseStorage mirror (Pyric Studio data browse) - client-side
 * ref path math plus `listAll`/`getMetadata`/`getBlob`/`getDownloadURL` reads and the base64
 * byte ops (`uploadBytes`/`getBytes`/`deleteObject`) over the worker port.
 */

import type { StorageBucketWire } from '../protocol.js';
import { FirebaseError } from 'pyric/app';
import type { FullMetadata, StringFormat } from 'pyric/storage';
import {
  arrayBufferToBase64,
  cloneSettableMetadata,
  decodeString,
  defaultRawContentType,
  joinStorageRefPaths,
  refPathOf,
  storageLastComponent,
} from 'pyric/storage/internal';
import { dataRpc, nextId, wirePort } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';
import {
  abortRouteUpload,
  afterRouteSettles,
  beginRouteUpload,
  byteRouteOf,
  finishRouteUpload,
  readOverRoute,
  rollBackUpload,
  routeUploadOffset,
  sendRouteSlice,
  uploadBlobOf,
  uploadOverRoute,
  type CommittedUpload,
  type RouteUpload,
} from './storage-byte-route.js';
import {
  readStorageBytesAsFrames,
  uploadBlobInOrder,
  uploadByteArray,
} from './storage-frame-transfer.js';

export {
  abortRouteUpload,
  beginRouteUpload,
  byteRouteOf,
  finishRouteUpload,
  rollBackUpload,
  routeUploadOffset,
  sendRouteSlice,
  uploadBlobOf,
  type CommittedUpload,
  type RouteUpload,
};

/** Worker-backed Storage handle (carries the shared `MessagePort`). */
export interface ClientFirebaseStorage {
  readonly __kind: 'client-storage';
  readonly port: ClientPort;
  readonly bucket: string;
  /** True for a handle `getStorage` opened on a bucket by name, rather than the app's default bucket. */
  readonly namedBucket?: boolean;
  maxOperationRetryTime: number;
  maxUploadRetryTime: number;
}

/** Worker-backed Storage reference (path + name; carries the port for ops). */
export interface ClientStorageReference {
  readonly __kind: 'storage-ref';
  readonly port: ClientPort;
  readonly storage?: ClientFirebaseStorage;
  readonly bucket: string;
  readonly fullPath: string;
  readonly name: string;
  readonly parent: ClientStorageReference | null;
  readonly root: ClientStorageReference;
  toString(): string;
}

class ClientStorageReferenceImpl implements ClientStorageReference {
  readonly __kind = 'storage-ref';
  readonly port: ClientPort;
  readonly storage?: ClientFirebaseStorage;
  readonly bucket: string;
  readonly fullPath: string;
  readonly name: string;

  constructor(port: ClientPort, bucket: string, fullPath: string, storage?: ClientFirebaseStorage) {
    this.port = port;
    this.bucket = bucket;
    this.fullPath = fullPath;
    this.name = storageLastComponent(fullPath);
    if (storage) {
      this.storage = storage;
    }
  }

  get parent(): ClientStorageReference | null {
    if (this.fullPath === '') return null;
    const idx = this.fullPath.lastIndexOf('/');
    const parentPath = idx === -1 ? '' : this.fullPath.slice(0, idx);
    return new ClientStorageReferenceImpl(this.port, this.bucket, parentPath, this.storage);
  }

  get root(): ClientStorageReference {
    return new ClientStorageReferenceImpl(this.port, this.bucket, '', this.storage);
  }

  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}

/** Strip leading/trailing slashes and collapse repeated internal slashes (the worker keyspace uses bare paths). */
function normalizeStorageRefPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/**
 * Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
 * `ClientDb` (reusing its port) or a worker URL (standalone).
 */
export function getStorage(
  source: ClientDb | string | URL,
  name?: string,
  bucketUrl?: string,
  namedBucket = false,
): ClientFirebaseStorage {
  let port: ClientPort;
  if (typeof source === 'object' && '__kind' in source && source.__kind === 'client-db') {
    port = source.port;
  } else {
    if (typeof SharedWorker === 'undefined') {
      throw new Error(
        'SharedWorker is not available. ' +
        'Open this page over http:// (not file://) and use a supported browser.',
      );
    }
    const worker = new SharedWorker(source as string | URL, {
      type: 'classic',
      name: name ?? 'pyric-shared-worker',
    });
    port = worker.port;
    port.start();
    wirePort(port);
  }
  const resolvedBucket = bucketUrl ?? 'pyric-default';
  const base = { __kind: 'client-storage' as const, port, bucket: resolvedBucket, maxOperationRetryTime: 120_000, maxUploadRetryTime: 600_000 };
  if (namedBucket) return { ...base, namedBucket: true };
  return base;
}

/**
 * The bucket an object op names on the wire: a bucket `getStorage` opened by
 * name goes by that name, with its own objects and rules (#1313). The default
 * bucket names none, and the host serves its own default bucket.
 */
export function bucketWire(reference: ClientStorageReference): StorageBucketWire {
  return reference.storage?.namedBucket === true ? { bucket: reference.bucket } : {};
}

/** Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 *  `ref(parentRef, path)`, including `ref(storage, url)`. Client-side path
 *  math; no RPC. */
export function ref(
  parent: ClientFirebaseStorage | ClientStorageReference,
  path?: string,
): ClientStorageReference {
  let fullPath: string;
  let port: ClientPort;
  let bucket = 'pyric-default';
  let storage: ClientFirebaseStorage | undefined;

  if (parent.__kind === 'client-storage') {
    fullPath = normalizeStorageRefPath(refPathOf(path, true));
    port = parent.port;
    bucket = parent.bucket;
    storage = parent;
  } else {
    fullPath = joinStorageRefPaths(parent.fullPath, refPathOf(path, false));
    port = parent.port;
    bucket = parent.bucket;
    storage = parent.storage;
  }
  return new ClientStorageReferenceImpl(port, bucket, fullPath, storage);
}

/** Enumerate immediate child items + sub-prefixes under a ref (Pyric Studio
 *  data browse). The host enforces `read` rules on the scanned prefix. */
export async function listAll(
  reference: ClientStorageReference,
): Promise<{ items: ClientStorageReference[]; prefixes: ClientStorageReference[] }> {
  const r = (await dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.listAll', path: reference.fullPath, ...bucketWire(reference),
  })) as { items: Array<{ fullPath: string; name: string }>; prefixes: Array<{ fullPath: string; name: string }> };
  const mk = (e: { fullPath: string; name: string }): ClientStorageReference =>
    new ClientStorageReferenceImpl(reference.port, reference.bucket, e.fullPath, reference.storage);
  return { items: r.items.map(mk), prefixes: r.prefixes.map(mk) };
}

export function withReferenceBucket(reference: ClientStorageReference, metadata: FullMetadata): FullMetadata {
  const next: FullMetadata = { ...metadata };
  if (reference.bucket !== '') {
    next.bucket = reference.bucket;
  }
  if (metadata.customMetadata !== undefined) {
    next.customMetadata = { ...metadata.customMetadata };
  }
  return next;
}

function guardClientNonRoot(reference: ClientStorageReference, operation: string): void {
  if (reference.fullPath === '') {
    throw new FirebaseError(
      'storage/invalid-root-operation',
      `storage/invalid-root-operation: ${operation} cannot operate on the root reference.`,
    );
  }
}

export async function fetchMetadataFromHost(reference: ClientStorageReference): Promise<FullMetadata> {
  return (await dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getMetadata', path: reference.fullPath, ...bucketWire(reference),
  })) as FullMetadata;
}

/** Read an object's metadata (Pyric Studio inspector). */
export function getMetadata(reference: ClientStorageReference): Promise<FullMetadata> {
  guardClientNonRoot(reference, 'getMetadata');
  return fetchMetadataFromHost(reference).then((meta) => withReferenceBucket(reference, meta));
}

/** Reconstruct binary data locally so reads work over MessagePort and JSON WebSocket. */
export function getBlob(reference: ClientStorageReference, maxDownloadSizeBytes?: number): Promise<Blob> {
  guardClientNonRoot(reference, 'getBlob');
  return readStorageBytesInternal(reference).then((result) => {
    let bytes = result.bytes;
    if (typeof maxDownloadSizeBytes === 'number' && bytes.byteLength > maxDownloadSizeBytes) {
      bytes = bytes.subarray(0, Math.max(0, maxDownloadSizeBytes));
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: result.contentType ?? 'application/octet-stream' });
  });
}

async function readStorageBytesInternal(
  reference: ClientStorageReference,
): Promise<{ bytes: Uint8Array; contentType?: string; size: number }> {
  return afterRouteSettles(reference, (route, reservation) => {
    const routed = route !== undefined;
    if (!routed) return readStorageBytesAsFrames(reference, reservation);
    reservation?.release();
    return readOverRoute(route, reference);
  });
}

/**
 * Return a `data:<contentType>;base64,<payload>` URI for an object read
 * through the SharedWorker. Same shape the in-process `pyric/storage`
 * `getDownloadURL` returns, so a URL produced in worker mode resolves in every
 * context the page hands it to rather than only inside the page that made it.
 */
export async function getDownloadURL(reference: ClientStorageReference): Promise<string> {
  guardClientNonRoot(reference, 'getDownloadURL');
  // A host with a byte route returns the object's HTTP URL, carrying its
  // persistent download token, as production does.
  const routedUrl = await afterRouteSettles(reference, async (route, reservation) => {
    const routed = route !== undefined;
    if (!routed) return undefined;
    const { path } = (await dataRpc(reference.port, {
      t: 'op', id: nextId(), method: 'storage.getDownloadURL', path: reference.fullPath, ...bucketWire(reference),
    }, reservation)) as { path: string };
    return new URL(path, route.baseUrl).href;
  });
  if (routedUrl !== undefined) return routedUrl;
  const blob = await getBlob(reference);
  const contentType = blob.type || 'application/octet-stream';
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${contentType};base64,${base64}`;
}

// Worker-mode byte ops (`storage.putBytes` / `storage.getBytes` / `storage.deleteObject`),
// capped at `MAX_STORAGE_OP_BYTES` (8 MiB) and enforced against configured storage.rules.

/** Mirror of `pyric/storage`'s `SettableMetadata` (plain JSON on the wire). */
export interface ClientSettableMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: { [key: string]: string };
}

/** Upload bytes at the reference's path (replaces existing content).
 *  Mirrors `pyric/storage`'s `uploadBytes` result shape. */
export function uploadBytes(
  reference: ClientStorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: ClientSettableMetadata,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  guardClientNonRoot(reference, 'uploadBytes');
  return commitUpload(reference, data, metadata, false).then((committed) => ({ ref: reference, metadata: committed.metadata }));
}

/**
 * Upload bytes at the reference's path, over the byte route or as frames.
 * With `rollback`, the commit asks the host for its rollback token, which a
 * resumable task uses when a cancel races the commit.
 */
export async function commitUpload(
  reference: ClientStorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata: ClientSettableMetadata | undefined,
  rollback: boolean,
): Promise<CommittedUpload> {
  const clonedMetadata = cloneSettableMetadata(metadata);
  return afterRouteSettles(reference, (route, reservation) => {
    const routed = route !== undefined;
    if (routed) {
      reservation?.release();
      return uploadOverRoute(reference, route, uploadBlobOf(data), clonedMetadata, rollback);
    }
    const isBlob = data instanceof Blob;
    if (isBlob) return uploadBlobInOrder(reference, data, clonedMetadata, rollback, reservation);
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }
    let contentType: string | undefined;
    if (clonedMetadata?.contentType !== undefined && clonedMetadata.contentType !== '') {
      contentType = clonedMetadata.contentType;
    }
    return uploadByteArray(reference, bytes, contentType, clonedMetadata, rollback, reservation);
  });
}

/** Upload string payload at the reference's path.
 *  Mirrors `pyric/storage`'s `uploadString` result shape. */
export function uploadString(
  reference: ClientStorageReference,
  value: string,
  format: StringFormat = 'raw',
  metadata?: ClientSettableMetadata,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  guardClientNonRoot(reference, 'uploadString');
  let decoded: { bytes: Uint8Array; inferredType: string | undefined };
  try {
    decoded = decodeString(value, format);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (typeof code === 'string' && typeof message === 'string') {
      throw new FirebaseError(code, message);
    }
    throw err;
  }
  let resolvedContentType = defaultRawContentType(format);
  if (decoded.inferredType !== undefined) resolvedContentType = decoded.inferredType;
  if (metadata?.contentType !== undefined) resolvedContentType = metadata.contentType;
  const effective: ClientSettableMetadata = { ...metadata, contentType: resolvedContentType };
  return uploadBytes(reference, decoded.bytes, effective);
}

/** Read an object's bytes (JSON-safe base64 op -> `ArrayBuffer`). Mirrors
 *  `pyric/storage`'s `getBytes`, including the optional client-side cap. */
export function getBytes(
  reference: ClientStorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  guardClientNonRoot(reference, 'getBytes');
  return readStorageBytesInternal(reference).then((res) => {
    let bytes = res.bytes;
    if (typeof maxDownloadSizeBytes === 'number' && bytes.byteLength > maxDownloadSizeBytes) {
      bytes = bytes.subarray(0, Math.max(0, maxDownloadSizeBytes));
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
}

/** Delete the object at the reference's path; rejects with storage/object-not-found when absent. */
export function deleteObject(reference: ClientStorageReference): Promise<void> {
  guardClientNonRoot(reference, 'deleteObject');
  return dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.deleteObject', path: reference.fullPath, ...bucketWire(reference),
  }).then(() => undefined);
}

export { uploadBytesResumable } from './resumable.js';
export type { ClientUploadTask, ClientUploadTaskSnapshot } from './resumable.js';
