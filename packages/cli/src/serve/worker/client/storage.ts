/**
 * Worker-backed FirebaseStorage mirror (Pyric Studio data browse) — client-side
 * ref path math plus `listAll`/`getMetadata`/`getBlob`/`getDownloadURL` reads and the base64
 * byte ops (`uploadBytes`/`getBytes`/`deleteObject`) over the worker port.
 */

import { bytesToBase64, base64ToBytes, storagePayloadTooLarge, MAX_STORAGE_OP_BYTES } from '../protocol.js';
import type { FullMetadata } from 'pyric/storage';
import { nextId, rpc, wirePort } from './core.js';
import { lastSegment } from './handles.js';
import type { ClientDb, ClientPort } from './handles.js';

// ─── Storage (Pyric Studio data browse) ───────────────────────────────────
// A worker-backed `FirebaseStorage` mirror: `ref` is client-side (path math),
// `listAll`/`getMetadata`/`getBlob`/`getDownloadURL` RPC to the host (which enforces rules).
// Mutations are a follow-up.

/** Worker-backed Storage handle (carries the shared `MessagePort`). */
export interface ClientFirebaseStorage {
  readonly __kind: 'client-storage';
  readonly port: ClientPort;
}

/** Worker-backed Storage reference (path + name; carries the port for ops). */
export interface ClientStorageReference {
  readonly __kind: 'storage-ref';
  readonly port: ClientPort;
  readonly fullPath: string;
  readonly name: string;
}

/** Strip leading/trailing slashes (the worker keyspace uses bare paths). */
function normalizeStorageRefPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
 * `ClientDb` (reusing its port) or a worker URL (standalone).
 */
export function getStorage(source: ClientDb | string | URL, name?: string): ClientFirebaseStorage {
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
  return { __kind: 'client-storage', port };
}

/** Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 *  `ref(parentRef, path)`. Client-side path math; no RPC. */
export function ref(
  parent: ClientFirebaseStorage | ClientStorageReference,
  path?: string,
): ClientStorageReference {
  const rel = normalizeStorageRefPath(path ?? '');
  let fullPath: string;
  if (parent.__kind === 'client-storage') {
    fullPath = rel;
  } else {
    const base = parent.fullPath;
    fullPath = rel ? (base ? `${base}/${rel}` : rel) : base;
  }
  return { __kind: 'storage-ref', port: parent.port, fullPath, name: lastSegment(fullPath) };
}

/** Enumerate immediate child items + sub-prefixes under a ref (Pyric Studio
 *  data browse). The host enforces `read` rules on the scanned prefix. */
export async function listAll(
  reference: ClientStorageReference,
): Promise<{ items: ClientStorageReference[]; prefixes: ClientStorageReference[] }> {
  const r = (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.listAll', path: reference.fullPath,
  })) as { items: Array<{ fullPath: string; name: string }>; prefixes: Array<{ fullPath: string; name: string }> };
  const mk = (e: { fullPath: string; name: string }): ClientStorageReference => ({
    __kind: 'storage-ref', port: reference.port, fullPath: e.fullPath, name: e.name,
  });
  return { items: r.items.map(mk), prefixes: r.prefixes.map(mk) };
}

/** Read an object's metadata (Pyric Studio inspector). */
export async function getMetadata(reference: ClientStorageReference): Promise<FullMetadata> {
  return (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getMetadata', path: reference.fullPath,
  })) as FullMetadata;
}

/** Read an object's bytes as a Blob (Pyric Studio inspector preview).
 *  MessagePort-only — a Blob cannot cross the JSON bridge relay. */
export async function getBlob(reference: ClientStorageReference): Promise<Blob> {
  return (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getBlob', path: reference.fullPath,
  })) as Blob;
}

/** Return a page-owned URL for an object read through the SharedWorker. */
export async function getDownloadURL(reference: ClientStorageReference): Promise<string> {
  return URL.createObjectURL(await getBlob(reference));
}

// ─── Storage mutations + JSON-safe reads (worker-mode byte ops) ───────────
// Backed by the base64 `storage.putBytes` / `storage.getBytes` /
// `storage.deleteObject` ops (remote sandbox, slice 2). No `actAs` lens is
// attached: page callers run under the worker's page storage handle (same
// model as `listAll`/`getMetadata` above). Storage rules apply when the
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
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
  if (bytes.byteLength > MAX_STORAGE_OP_BYTES) {
    throw storagePayloadTooLarge(bytes.byteLength, `uploadBytes payload for '${reference.fullPath}'`);
  }
  // contentType precedence mirrors pyric/storage: caller metadata → Blob.type.
  const contentType =
    metadata?.contentType ?? (data instanceof Blob && data.type ? data.type : undefined);
  const stored = (await rpc(reference.port, {
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

/** Read an object's bytes (JSON-safe base64 op → `ArrayBuffer`). Mirrors
 *  `pyric/storage`'s `getBytes`, including the optional client-side cap. */
export async function getBytes(
  reference: ClientStorageReference,
  maxDownloadSizeBytes?: number,
): Promise<ArrayBuffer> {
  const res = (await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.getBytes', path: reference.fullPath,
  })) as { dataB64: string; size: number };
  if (typeof maxDownloadSizeBytes === 'number' && res.size > maxDownloadSizeBytes) {
    const err = new Error(
      `storage/quota-exceeded: object at '${reference.fullPath}' is ${res.size} bytes — ` +
        `over the requested maxDownloadSizeBytes (${maxDownloadSizeBytes}).`,
    ) as Error & { code: string };
    err.code = 'storage/quota-exceeded';
    throw err;
  }
  const bytes = base64ToBytes(res.dataB64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Delete the object at the reference's path (idempotent — missing = no-op,
 *  matching the sandbox backend's delete semantics). */
export async function deleteObject(reference: ClientStorageReference): Promise<void> {
  await rpc(reference.port, {
    t: 'op', id: nextId(), method: 'storage.deleteObject', path: reference.fullPath,
  });
}
