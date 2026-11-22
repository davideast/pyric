/**
 * HTTP byte-route transfer helpers for the worker-backed Storage client.
 *
 * When the host advertises its HTTP byte route, bytes move over plain HTTP
 * while Security Rules checks and upload commits stay on the MessagePort /
 * WebSocket RPC channel.
 */
import { StorageError, type FullMetadata } from 'pyric/storage';
import {
  MAX_STORAGE_OBJECT_BYTES,
  storageObjectPath,
  storageQuotaExceeded,
} from '../protocol.js';
import type { OpMessage } from '../protocol.js';
import { dataRpc, nextId } from './core.js';
import type { ByteRouteAccess } from './handles.js';
import { withinHoldDeadline } from './held-messages.js';
import { reserveSend, type SendReservation } from './send-order.js';
import {
  bucketWire,
  fetchMetadataFromHost,
  withReferenceBucket,
  type ClientSettableMetadata,
  type ClientStorageReference,
} from './storage.js';

/** Bytes an upload sends per request; each one that lands is a progress step. */
const ROUTE_SLICE_BYTES = 4 * 1024 * 1024;

async function byteRouteHeaders(route: ByteRouteAccess): Promise<Record<string, string>> {
  const token = await route.sessionToken();
  const headers: Record<string, string> = { 'x-pyric-byte-route': '1' };
  if (token !== null && token !== '') {
    headers['x-pyric-session-token'] = token;
  }
  return headers;
}

function routeFailure(status: number, path: string): StorageError {
  const refused = status === 401 || status === 403;
  if (refused) {
    return new StorageError('unauthorized', `The host refused bytes for '${path}' (HTTP ${status}).`);
  }
  const missing = status === 404;
  if (missing) {
    return new StorageError('object-not-found', `Object '${path}' does not exist.`);
  }
  return new StorageError('unknown', `The host's byte route answered HTTP ${status} for '${path}'.`);
}

/**
 * Translate a network or stream failure on the HTTP byte route into a
 * `StorageError` matching `@firebase/storage` (`FetchConnection.send` +
 * `NetworkRequest` retry exhaustion -> `storage/retry-limit-exceeded`, or
 * `storage/canceled` when aborted).
 */
function byteTransferFailure(error: unknown, signal?: AbortSignal): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new StorageError('canceled', 'User canceled the upload/download.');
  }
  return new StorageError(
    'retry-limit-exceeded',
    'Max retry time for operation exceeded, please try again.',
  );
}

/**
 * Rethrow an RPC error from a byte transfer step, converting an in-flight host
 * socket drop (`unavailable` / `deadline-exceeded`) into `StorageError`
 * (`storage/retry-limit-exceeded`) while preserving `storage/*` wire errors and
 * pre-attachment hold-deadline errors.
 */
export function rethrowCutOffRpcFailure(error: unknown, transferStarted = false): never {
  if (error instanceof StorageError) {
    throw error;
  }
  let code: unknown;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    code = (error as { code?: unknown }).code;
  }
  if (typeof code === 'string' && code.startsWith('storage/')) {
    throw error;
  }
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  }
  const isHoldTimeout = message.includes('was not restored within');
  const isDroppedUnavailable = code === 'unavailable' && (!isHoldTimeout || transferStarted);
  const isDeadlineExceeded = code === 'deadline-exceeded';
  if (isDroppedUnavailable || isDeadlineExceeded) {
    throw new StorageError(
      'retry-limit-exceeded',
      'Max retry time for operation exceeded, please try again.',
    );
  }
  throw error;
}

function routeFetchOf(
  customFetch: ByteRouteAccess['fetch'] | undefined,
): typeof fetch {
  if (customFetch !== undefined) {
    return customFetch as typeof fetch;
  }
  return fetch;
}

/**
 * Read rules are checked by `getMetadata` over the RPC; the bytes are then read
 * from the generation that check saw.
 */
export async function readOverRoute(
  route: ByteRouteAccess,
  reference: ClientStorageReference,
): Promise<{ bytes: Uint8Array; contentType?: string; size: number }> {
  const performFetch = routeFetchOf(route.fetch);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let metadata: FullMetadata;
    try {
      metadata = await fetchMetadataFromHost(reference);
    } catch (error) {
      rethrowCutOffRpcFailure(error, false);
    }
    const objectPath = storageObjectPath(metadata.bucket, reference.fullPath);
    const url = new URL(objectPath, route.baseUrl);
    url.searchParams.set('generation', metadata.generation);
    let response: Response;
    try {
      const headers = await byteRouteHeaders(route);
      response = await performFetch(url, { headers });
    } catch (error) {
      throw byteTransferFailure(error);
    }
    const changed = response.status === 412;
    if (changed) continue;
    if (!response.ok) {
      throw routeFailure(response.status, reference.fullPath);
    }
    let payload: ArrayBuffer;
    try {
      payload = await response.arrayBuffer();
    } catch (error) {
      throw byteTransferFailure(error);
    }
    const bytes = new Uint8Array(payload);
    const headerType = response.headers.get('content-type');
    let contentType = metadata.contentType;
    if (headerType !== null) {
      contentType = headerType;
    }
    return { bytes, contentType, size: bytes.byteLength };
  }
  throw new StorageError(
    'retry-limit-exceeded',
    `Object '${reference.fullPath}' kept changing while it was read.`,
  );
}

/** An upload in progress on the byte route. */
export interface RouteUpload {
  readonly uploadId: string;
  readonly url: string;
  readonly size: number;
  readonly reference: ClientStorageReference;
  /** How its slices reach the host: the route's fetch. */
  readonly fetch?: ByteRouteAccess['fetch'];
}

/** The byte route a reference's host advertised, if any. */
export function byteRouteOf(reference: ClientStorageReference): ByteRouteAccess | undefined {
  return reference.port.byteRoute;
}

/**
 * Runs `run` once the transport knows whether the host has a byte route.
 * A call issued before the first attachment waits for it, keeping its place in
 * the call order until its first frame is sent or it switches to HTTP.
 */
export async function afterRouteSettles<T>(
  reference: ClientStorageReference,
  run: (route: ByteRouteAccess | undefined, reservation: SendReservation | undefined) => Promise<T>,
): Promise<T> {
  const pending = reference.port.byteRouteSettled?.();
  const isKnown = pending === undefined;
  if (isKnown) {
    return run(byteRouteOf(reference), undefined);
  }
  const reservation = reserveSend(reference.port);
  try {
    await withinHoldDeadline(pending);
    return await run(byteRouteOf(reference), reservation);
  } finally {
    reservation.release();
  }
}

/** Begin an upload over the RPC, where rules decide; returns where its bytes go. */
export async function beginRouteUpload(
  reference: ClientStorageReference,
  route: ByteRouteAccess,
  size: number,
  contentType: string | undefined,
  metadata: ClientSettableMetadata | undefined,
): Promise<RouteUpload> {
  const wireBucket = bucketWire(reference);
  const message: OpMessage & {
    method: 'storage.beginUpload';
    path: string;
    size: number;
    bucket?: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
  } = {
    t: 'op',
    id: nextId(),
    method: 'storage.beginUpload',
    path: reference.fullPath,
    size,
  };
  if (wireBucket.bucket !== undefined) {
    message.bucket = wireBucket.bucket;
  }
  if (contentType !== undefined) {
    message.contentType = contentType;
  }
  if (metadata !== undefined) {
    message.metadata = metadata as Record<string, unknown>;
  }
  let begun: { uploadId: string; uploadUrl?: string };
  try {
    begun = (await dataRpc(reference.port, message)) as {
      uploadId: string;
      uploadUrl?: string;
    };
  } catch (error) {
    rethrowCutOffRpcFailure(error, false);
  }
  const uploadUrl = begun.uploadUrl;
  const unrouted = uploadUrl === undefined;
  if (unrouted) {
    throw new StorageError('unknown', 'The host began the upload without a byte route URL.');
  }
  const resolvedUrl = new URL(uploadUrl, route.baseUrl).href;
  return {
    uploadId: begun.uploadId,
    url: resolvedUrl,
    size,
    reference,
    fetch: route.fetch,
  };
}

/** How many bytes a byte route answer says the host holds. */
function receivedFrom(response: Response, size: number): number {
  const complete = response.status === 200;
  if (complete) return size;
  const rangeHeader = response.headers.get('range');
  let rawRange = '';
  if (rangeHeader !== null) {
    rawRange = rangeHeader;
  }
  const held = /^bytes=0-(\d+)$/.exec(rawRange);
  if (held === null) return 0;
  return Number(held[1]) + 1;
}

/** Send the slice that starts at `offset`; resolves with how many bytes the host now holds. */
export async function sendRouteSlice(
  upload: RouteUpload,
  data: Blob,
  offset: number,
  signal?: AbortSignal,
): Promise<number> {
  const end = Math.min(offset + ROUTE_SLICE_BYTES, upload.size);
  const performFetch = routeFetchOf(upload.fetch);
  let response: Response;
  try {
    response = await performFetch(upload.url, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${offset}-${end - 1}/${upload.size}` },
      body: data.slice(offset, end),
      signal,
    });
  } catch (error) {
    throw byteTransferFailure(error, signal);
  }
  const accepted = response.status === 200 || response.status === 308 || response.status === 409;
  if (!accepted) {
    throw routeFailure(response.status, upload.reference.fullPath);
  }
  return receivedFrom(response, upload.size);
}

/** Ask the host how much of an upload it holds. */
export async function routeUploadOffset(
  upload: RouteUpload,
  signal?: AbortSignal,
): Promise<number> {
  const performFetch = routeFetchOf(upload.fetch);
  let response: Response;
  try {
    response = await performFetch(upload.url, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${upload.size}` },
      signal,
    });
  } catch (error) {
    throw byteTransferFailure(error, signal);
  }
  const accepted = response.status === 200 || response.status === 308;
  if (!accepted) {
    throw routeFailure(response.status, upload.reference.fullPath);
  }
  return receivedFrom(response, upload.size);
}

/**
 * A stored upload's metadata and, when its commit asked for one, the token
 * that rolls it back (`storage.rollbackUpload`), with `replacedObject` when
 * the commit replaced an object. A host that predates the token sends neither.
 */
export interface CommittedUpload {
  readonly metadata: FullMetadata;
  readonly rollbackToken?: string;
  readonly replacedObject?: boolean;
}

/** Split a commit's reply into the object's metadata and its rollback receipt. */
export function committedFrom(reference: ClientStorageReference, reply: unknown): CommittedUpload {
  const { rollbackToken, replacedObject, ...stored } = reply as FullMetadata & {
    rollbackToken?: unknown;
    replacedObject?: unknown;
  };
  const metadata = withReferenceBucket(reference, stored as FullMetadata);
  const hasToken = typeof rollbackToken === 'string';
  if (!hasToken) {
    return { metadata };
  }
  return {
    metadata,
    rollbackToken,
    replacedObject: replacedObject === true,
  };
}

/** The request field that asks a commit for its rollback token. */
export function rollbackField(rollback: boolean): { rollback?: true } {
  if (rollback) {
    return { rollback: true };
  }
  return {};
}

/** Commit a fully sent upload over the RPC, through the engine's upload. */
export async function finishRouteUpload(
  upload: RouteUpload,
  rollback = false,
): Promise<CommittedUpload> {
  const message: OpMessage & {
    method: 'storage.finishUpload';
    uploadId: string;
    rollback?: true;
  } = {
    t: 'op',
    id: nextId(),
    method: 'storage.finishUpload',
    uploadId: upload.uploadId,
  };
  if (rollback) {
    message.rollback = true;
  }
  let reply: unknown;
  try {
    reply = await dataRpc(upload.reference.port, message);
  } catch (error) {
    rethrowCutOffRpcFailure(error, true);
  }
  return committedFrom(upload.reference, reply);
}

/**
 * Roll back a canceled upload's own commit by its token, without the rules:
 * the host puts back the object the commit replaced, or deletes the one it
 * created, and keeps a later write that replaced the commit.
 */
export async function rollBackUpload(
  reference: ClientStorageReference,
  rollbackToken: string,
): Promise<void> {
  await dataRpc(reference.port, {
    t: 'op',
    id: nextId(),
    method: 'storage.rollbackUpload',
    rollbackToken,
  });
}

/** Discard an upload on the host; best effort, as the caller is already failing. */
export async function abortRouteUpload(upload: RouteUpload): Promise<void> {
  try {
    await dataRpc(upload.reference.port, {
      t: 'op',
      id: nextId(),
      method: 'storage.abortUpload',
      uploadId: upload.uploadId,
    });
  } catch {
    // The host discards staging a stopped host left, too.
  }
}

/** The Blob an upload sends, without reading a Blob's bytes into memory. */
export function uploadBlobOf(data: Blob | Uint8Array | ArrayBuffer): Blob {
  if (data instanceof Blob) {
    return data;
  }
  return new Blob([data as Uint8Array<ArrayBuffer>]);
}

/** Send an object's bytes over the byte route, a slice at a time, and commit it over the RPC. */
export async function uploadOverRoute(
  reference: ClientStorageReference,
  route: ByteRouteAccess,
  data: Blob,
  metadata: ClientSettableMetadata | undefined,
  rollback: boolean,
): Promise<CommittedUpload> {
  const tooLarge = data.size > MAX_STORAGE_OBJECT_BYTES;
  if (tooLarge) {
    throw storageQuotaExceeded(data.size, `uploadBytes payload for '${reference.fullPath}'`);
  }
  let contentType: string | undefined;
  if (data.type !== '') {
    contentType = data.type;
  }
  if (metadata?.contentType !== undefined && metadata.contentType !== '') {
    contentType = metadata.contentType;
  }
  const upload = await beginRouteUpload(reference, route, data.size, contentType, metadata);
  try {
    let offset = 0;
    while (offset < upload.size) {
      offset = await sendRouteSlice(upload, data, offset);
    }
    return await finishRouteUpload(upload, rollback);
  } catch (error) {
    await abortRouteUpload(upload);
    throw error;
  }
}
