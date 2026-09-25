/**
 * Worker-backed FirebaseStorage mirror (Pyric Studio data browse) — client-side
 * ref path math plus `listAll`/`getMetadata`/`getBlob`/`getDownloadURL` reads and the base64
 * byte ops (`uploadBytes`/`getBytes`/`deleteObject`) over the worker port.
 */

import {
  bytesToBase64,
  base64ToBytes,
  storagePayloadTooLarge,
  storageQuotaExceeded,
  MAX_STORAGE_OP_BYTES,
  MAX_STORAGE_PART_BYTES,
  MAX_STORAGE_OBJECT_BYTES,
  storageObjectPath,
} from '../protocol.js';
import { FirebaseError } from 'pyric/app';
import type { FullMetadata, StringFormat } from 'pyric/storage';
import { arrayBufferToBase64, decodeString, defaultRawContentType, refPathOf } from 'pyric/storage/internal';
import { dataRpc, nextId, wirePort } from './core.js';
import { lastSegment } from './handles.js';
import type { ByteRouteAccess, ClientDb, ClientPort } from './handles.js';

// ─── Storage (Pyric Studio data browse) ───────────────────────────────────
// A worker-backed `FirebaseStorage` mirror: `ref` is client-side (path math),
// `listAll`/`getMetadata`/`getBlob`/`getDownloadURL` RPC to the host (which enforces rules).
// Mutations are a follow-up.

/** Worker-backed Storage handle (carries the shared `MessagePort`). */
export interface ClientFirebaseStorage {
  readonly __kind: 'client-storage';
  readonly port: ClientPort;
  readonly bucket: string;
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
    this.name = lastSegment(fullPath);
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
    if (this.fullPath === '') return this;
    return new ClientStorageReferenceImpl(this.port, this.bucket, '', this.storage);
  }

  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}

/** Strip leading/trailing slashes (the worker keyspace uses bare paths). */
function normalizeStorageRefPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
 * `ClientDb` (reusing its port) or a worker URL (standalone).
 */
export function getStorage(source: ClientDb | string | URL, name?: string, bucketUrl?: string): ClientFirebaseStorage {
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
  return { __kind: 'client-storage', port, bucket: bucketUrl ?? 'pyric-default' };
}

/** Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 *  `ref(parentRef, path)`, including `ref(storage, url)`. Client-side path
 *  math; no RPC. */
export function ref(
  parent: ClientFirebaseStorage | ClientStorageReference,
  path?: string,
): ClientStorageReference {
  const rel = normalizeStorageRefPath(refPathOf(path, parent.__kind === 'client-storage'));
  let fullPath: string;
  let port: ClientPort;
  let bucket = 'pyric-default';
  let storage: ClientFirebaseStorage | undefined;

  if (parent.__kind === 'client-storage') {
    fullPath = rel;
    port = parent.port;
    bucket = parent.bucket;
    storage = parent;
  } else {
    const base = parent.fullPath;
    fullPath = rel ? (base ? `${base}/${rel}` : rel) : base;
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
    t: 'op', id: nextId(), method: 'storage.listAll', path: reference.fullPath,
  })) as { items: Array<{ fullPath: string; name: string }>; prefixes: Array<{ fullPath: string; name: string }> };
  const mk = (e: { fullPath: string; name: string }): ClientStorageReference =>
    new ClientStorageReferenceImpl(reference.port, reference.bucket, e.fullPath, reference.storage);
  return { items: r.items.map(mk), prefixes: r.prefixes.map(mk) };
}

/** Read an object's metadata (Pyric Studio inspector). */
export async function getMetadata(reference: ClientStorageReference): Promise<FullMetadata> {
  return (await dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getMetadata', path: reference.fullPath,
  })) as FullMetadata;
}

// ─── The byte route ────────────────────────────────────────────────────────
// When the host advertises its HTTP byte route, bytes travel over it: rules
// and the commit stay on the RPC, and only bytes move to HTTP.

/** Bytes an upload sends per request; each one that lands is a progress step. */
const ROUTE_SLICE_BYTES = 4 * 1024 * 1024;

async function sessionTokenOf(route: ByteRouteAccess): Promise<string> {
  const token = await route.sessionToken();
  const missing = token === null || token === '';
  if (missing) throw new FirebaseError('unavailable', 'The page has no session token for the hosted byte route. Reload the page.');
  return token;
}

function routeFailure(status: number, path: string): FirebaseError {
  const refused = status === 401 || status === 403;
  if (refused) return new FirebaseError('storage/unauthorized', `The host refused bytes for '${path}' (HTTP ${status}).`);
  const missing = status === 404;
  if (missing) return new FirebaseError('storage/object-not-found', `Object '${path}' does not exist.`);
  return new FirebaseError('storage/unknown', `The host's byte route answered HTTP ${status} for '${path}'.`);
}

/**
 * Read rules are checked by getMetadata over the RPC; the bytes are then read
 * from exactly the generation that check saw.
 */
async function readOverRoute(
  route: ByteRouteAccess,
  reference: ClientStorageReference,
): Promise<{ bytes: Uint8Array; contentType?: string; size: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const metadata = await getMetadata(reference);
    const url = new URL(storageObjectPath(metadata.bucket, reference.fullPath), route.baseUrl);
    url.searchParams.set('generation', metadata.generation);
    const response = await fetch(url, { headers: { 'x-pyric-session-token': await sessionTokenOf(route) } });
    const changed = response.status === 412;
    if (changed) continue;
    if (!response.ok) throw routeFailure(response.status, reference.fullPath);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, contentType: response.headers.get('content-type') ?? metadata.contentType, size: bytes.byteLength };
  }
  throw new FirebaseError('storage/retry-limit-exceeded', `Object '${reference.fullPath}' kept changing while it was read.`);
}

/** An upload in progress on the byte route. */
export interface RouteUpload {
  readonly uploadId: string;
  readonly url: string;
  readonly size: number;
  readonly reference: ClientStorageReference;
}

/** The byte route a reference's host advertised, if any. */
export function byteRouteOf(reference: ClientStorageReference): ByteRouteAccess | undefined {
  return reference.port.byteRoute;
}

/** Begin an upload over the RPC, where rules decide; returns where its bytes go. */
export async function beginRouteUpload(
  reference: ClientStorageReference,
  route: ByteRouteAccess,
  size: number,
  contentType: string | undefined,
  metadata: ClientSettableMetadata | undefined,
): Promise<RouteUpload> {
  const begun = (await dataRpc(reference.port, {
    t: 'op',
    id: nextId(),
    method: 'storage.beginUpload',
    path: reference.fullPath,
    size,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  })) as { uploadId: string; uploadUrl?: string };
  const uploadUrl = begun.uploadUrl;
  const unrouted = uploadUrl === undefined;
  if (unrouted) throw new FirebaseError('storage/unknown', 'The host began the upload without a byte route URL.');
  return { uploadId: begun.uploadId, url: new URL(uploadUrl, route.baseUrl).href, size, reference };
}

/** How many bytes a byte route answer says the host holds. */
function receivedFrom(response: Response, size: number): number {
  const complete = response.status === 200;
  if (complete) return size;
  const held = /^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? '');
  return held === null ? 0 : Number(held[1]) + 1;
}

/** Send the slice that starts at `offset`; resolves with how many bytes the host now holds. */
export async function sendRouteSlice(upload: RouteUpload, data: Blob, offset: number, signal?: AbortSignal): Promise<number> {
  const end = Math.min(offset + ROUTE_SLICE_BYTES, upload.size);
  const response = await fetch(upload.url, {
    method: 'PUT',
    headers: { 'content-range': `bytes ${offset}-${end - 1}/${upload.size}` },
    body: data.slice(offset, end),
    signal,
  });
  const accepted = response.status === 200 || response.status === 308 || response.status === 409;
  if (!accepted) throw routeFailure(response.status, upload.reference.fullPath);
  return receivedFrom(response, upload.size);
}

/** Ask the host how much of an upload it holds. */
export async function routeUploadOffset(upload: RouteUpload, signal?: AbortSignal): Promise<number> {
  const response = await fetch(upload.url, { method: 'PUT', headers: { 'content-range': `bytes */${upload.size}` }, signal });
  const accepted = response.status === 200 || response.status === 308;
  if (!accepted) throw routeFailure(response.status, upload.reference.fullPath);
  return receivedFrom(response, upload.size);
}

/** Commit a fully sent upload over the RPC, through the engine's upload. */
export async function finishRouteUpload(upload: RouteUpload): Promise<FullMetadata> {
  return (await dataRpc(upload.reference.port, {
    t: 'op', id: nextId(), method: 'storage.finishUpload', uploadId: upload.uploadId,
  })) as FullMetadata;
}

/** Discard an upload on the host; best effort, as the caller is already failing. */
export async function abortRouteUpload(upload: RouteUpload): Promise<void> {
  try {
    await dataRpc(upload.reference.port, { t: 'op', id: nextId(), method: 'storage.abortUpload', uploadId: upload.uploadId });
  } catch {
    // The host discards staging a stopped host left, too.
  }
}

/** The Blob an upload sends, without reading a Blob's bytes into memory. */
export function uploadBlobOf(data: Blob | Uint8Array | ArrayBuffer): Blob {
  return data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
}

/** Reconstruct binary data locally so reads work over MessagePort and JSON WebSocket. */
export async function getBlob(reference: ClientStorageReference): Promise<Blob> {
  const result = await readStorageBytesInternal(reference);
  const buffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: result.contentType ?? 'application/octet-stream' });
}

async function readStorageBytesInternal(
  reference: ClientStorageReference,
): Promise<{ bytes: Uint8Array; contentType?: string; size: number }> {
  const route = byteRouteOf(reference);
  const routed = route !== undefined;
  if (routed) return readOverRoute(route, reference);
  try {
    const res = (await dataRpc(reference.port, {
      t: 'op',
      id: nextId(),
      method: 'storage.getBytes',
      path: reference.fullPath,
    })) as { dataB64: string; contentType?: string; size: number };
    return {
      bytes: base64ToBytes(res.dataB64),
      contentType: res.contentType,
      size: res.size,
    };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'payload-too-large') {
      const meta = await getMetadata(reference);
      const byteParts: Uint8Array[] = [];
      let offset = 0;
      while (offset < meta.size) {
        const length = Math.min(MAX_STORAGE_PART_BYTES, meta.size - offset);
        const chunkRes = (await dataRpc(reference.port, {
          t: 'op',
          id: nextId(),
          method: 'storage.getBytes',
          path: reference.fullPath,
          offset,
          length,
          expectedGeneration: meta.generation,
        })) as { dataB64: string; contentType?: string; size: number };
        byteParts.push(base64ToBytes(chunkRes.dataB64));
        offset += length;
      }
      const combined = new Uint8Array(meta.size);
      let pos = 0;
      for (const p of byteParts) {
        combined.set(p, pos);
        pos += p.byteLength;
      }
      return {
        bytes: combined,
        contentType: meta.contentType,
        size: meta.size,
      };
    }
    throw err;
  }
}

function readStorageBytes(reference: ClientStorageReference): Promise<{
  dataB64: string;
  contentType?: string;
  size: number;
}> {
  return dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getBytes', path: reference.fullPath,
  }) as Promise<{ dataB64: string; contentType?: string; size: number }>;
}

/**
 * Return a `data:<contentType>;base64,<payload>` URI for an object read
 * through the SharedWorker. Same shape the in-process `pyric/storage`
 * `getDownloadURL` returns, so a URL produced in worker mode resolves in every
 * context the page hands it to rather than only inside the page that made it.
 */
export async function getDownloadURL(reference: ClientStorageReference): Promise<string> {
  // A host with a byte route returns the object's HTTP URL, carrying its
  // persistent download token, as production does.
  const route = byteRouteOf(reference);
  const routed = route !== undefined;
  if (routed) {
    const { path } = (await dataRpc(reference.port, {
      t: 'op', id: nextId(), method: 'storage.getDownloadURL', path: reference.fullPath,
    })) as { path: string };
    return new URL(path, route.baseUrl).href;
  }
  const blob = await getBlob(reference);
  const contentType = blob.type || 'application/octet-stream';
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${contentType};base64,${base64}`;
}

// ─── Storage mutations + JSON-safe reads (worker-mode byte ops) ───────────
// Backed by the base64 `storage.putBytes` / `storage.getBytes` /
// `storage.deleteObject` ops (remote sandbox, slice 2). Studio's data lens is
// attached by `dataRpc`; ordinary served-app bundles have no default lens and
// therefore remain app-session operations. Storage rules apply when the
// HOST configured them on the sandbox's storage service — the served
// worker's `applyServeInit` (serve-init.ts) does this at boot, before any op
// can reach the host, so worker-mode storage enforces the project's
// storage.rules the same as Firestore/RTDB (open only when the project has
// none); the admin lens matters for embedding/test hosts that pre-open the
// service with rules. Raw payloads are capped at 8 MiB
// (`MAX_STORAGE_OP_BYTES`) — same cap the host enforces.

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
export async function uploadBytes(
  reference: ClientStorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: ClientSettableMetadata,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  const route = byteRouteOf(reference);
  const routed = route !== undefined;
  if (routed) return uploadOverRoute(reference, route, uploadBlobOf(data), metadata);
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
  if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
    throw storageQuotaExceeded(bytes.byteLength, `uploadBytes payload for '${reference.fullPath}'`);
  }
  // contentType precedence mirrors pyric/storage: caller metadata → Blob.type.
  const contentType =
    metadata?.contentType ?? (data instanceof Blob && data.type ? data.type : undefined);

  if (bytes.byteLength <= MAX_STORAGE_PART_BYTES) {
    const stored = (await dataRpc(reference.port, {
      t: 'op',
      id: nextId(),
      method: 'storage.putBytes',
      path: reference.fullPath,
      dataB64: bytesToBase64(bytes),
      ...(contentType !== undefined ? { contentType } : {}),
      ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
    })) as FullMetadata;
    return { ref: reference, metadata: stored };
  }

  // Chunked upload for objects > 4 MiB (ADR 0015)
  const beginRes = (await dataRpc(reference.port, {
    t: 'op',
    id: nextId(),
    method: 'storage.beginUpload',
    path: reference.fullPath,
    size: bytes.byteLength,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  })) as { uploadId: string };

  const uploadId = beginRes.uploadId;
  try {
    let offset = 0;
    let partIndex = 0;
    while (offset < bytes.byteLength) {
      const nextOffset = Math.min(offset + MAX_STORAGE_PART_BYTES, bytes.byteLength);
      const partSlice = bytes.subarray(offset, nextOffset);
      await dataRpc(reference.port, {
        t: 'op',
        id: nextId(),
        method: 'storage.putPart',
        uploadId,
        partIndex,
        dataB64: bytesToBase64(partSlice),
      });
      offset = nextOffset;
      partIndex++;
    }
    const stored = (await dataRpc(reference.port, {
      t: 'op',
      id: nextId(),
      method: 'storage.finishUpload',
      uploadId,
    })) as FullMetadata;
    return { ref: reference, metadata: stored };
  } catch (err) {
    try {
      await dataRpc(reference.port, {
        t: 'op',
        id: nextId(),
        method: 'storage.abortUpload',
        uploadId,
      });
    } catch {
      // Secondary abort best effort
    }
    throw err;
  }
}

/** Send an object's bytes over the byte route, a slice at a time, and commit it over the RPC. */
async function uploadOverRoute(
  reference: ClientStorageReference,
  route: ByteRouteAccess,
  data: Blob,
  metadata: ClientSettableMetadata | undefined,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  const tooLarge = data.size > MAX_STORAGE_OBJECT_BYTES;
  if (tooLarge) throw storageQuotaExceeded(data.size, `uploadBytes payload for '${reference.fullPath}'`);
  // contentType precedence mirrors pyric/storage: caller metadata → Blob.type.
  const contentType = metadata?.contentType ?? (data.type !== '' ? data.type : undefined);
  const upload = await beginRouteUpload(reference, route, data.size, contentType, metadata);
  try {
    let offset = 0;
    while (offset < upload.size) offset = await sendRouteSlice(upload, data, offset);
    return { ref: reference, metadata: await finishRouteUpload(upload) };
  } catch (error) {
    await abortRouteUpload(upload);
    throw error;
  }
}

/** Upload string payload at the reference's path.
 *  Mirrors `pyric/storage`'s `uploadString` result shape. */
export async function uploadString(
  reference: ClientStorageReference,
  value: string,
  format: StringFormat = 'raw',
  metadata?: ClientSettableMetadata,
): Promise<{ ref: ClientStorageReference; metadata: FullMetadata }> {
  const { bytes, inferredType } = decodeString(value, format);
  const effective: ClientSettableMetadata = {
    ...metadata,
    contentType: metadata?.contentType ?? inferredType ?? defaultRawContentType(format),
  };
  return uploadBytes(reference, bytes, effective);
}

/** Read an object's bytes (JSON-safe base64 op → `ArrayBuffer`). Mirrors
 *  `pyric/storage`'s `getBytes`, including the optional client-side cap. */
export async function getBytes(
  reference: ClientStorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  const res = await readStorageBytesInternal(reference);
  if (typeof maxDownloadSizeBytes === 'number' && res.size > maxDownloadSizeBytes) {
    const err = new Error(
      `storage/quota-exceeded: object at '${reference.fullPath}' is ${res.size} bytes — ` +
        `over the requested maxDownloadSizeBytes (${maxDownloadSizeBytes}).`,
    ) as Error & { code: string };
    err.code = 'storage/quota-exceeded';
    throw err;
  }
  return res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
}

/** Delete the object at the reference's path (idempotent — missing = no-op,
 *  matching the sandbox backend's delete semantics). */
export async function deleteObject(reference: ClientStorageReference): Promise<void> {
  await dataRpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.deleteObject', path: reference.fullPath,
  });
}

export { uploadBytesResumable } from './resumable.js';
export type { ClientUploadTask, ClientUploadTaskSnapshot } from './resumable.js';
