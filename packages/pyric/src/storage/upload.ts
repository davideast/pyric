/**
 * Upload operations: `uploadBytes`, `uploadString`.
 *
 * Both delegate to the same internal pipeline:
 *   1. Normalize the incoming payload to a `Blob` (`toBlob`).
 *   2. Build a `StoredMetadata` record with server-set fields
 *      populated and client-settable fields merged in.
 *   3. Atomically `put` the blob + metadata via the persistence
 *      backend.
 *   4. Return `{ ref, metadata: toFullMetadata(stored) }`.
 *
 * Slice 5 ships the upload surface without rule evaluation —
 * Slice 8 will wrap this pipeline so denials throw before the IDB
 * write happens.
 *
 * Survey alignment (Section 4):
 *   - `uploadBytes` accepts `Blob | Uint8Array | ArrayBuffer` per
 *     the JS SDK's input contract.
 *   - `uploadString` accepts `raw` | `base64` | `data_url` formats;
 *     the data-url variant pulls `contentType` from the prefix
 *     unless explicitly overridden.
 *   - `contentType` precedence: caller's `metadata.contentType` →
 *     payload's intrinsic type (`Blob.type`, data-url prefix) →
 *     `application/octet-stream`. Matches the JS SDK.
 */
import { createMd5Hasher, md5 } from '@pyric/rules/internal/storage';
import { emitSandboxEvent, getClock, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { arrayBufferToBase64 } from './base64.js';
import { operationStorageOf } from './sandbox/cross-bucket-target.js';
import { getStorageService, storageAuth, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored, requestResourceFor } from './sandbox/rules-resources.js';
import { cloneCustomMetadata, toFullMetadata, type SettableMetadata, type UploadResult } from './metadata.js';
import { planeOf, uploadContentDisposition } from './content-defaults.js';
import { StorageError, invalidRootOperation, invalidFormat } from './errors.js';
import { clockGeneration, generationIssuer } from './generation.js';
import type { StoredMetadata, StoredObject } from './persistence.js';
import type { StorageReference } from './reference.js';

const OCTET = 'application/octet-stream';

/** `uploadString` format selector. */
import type { StringFormat } from './string-format.js';
export type { StringFormat } from './string-format.js';

/**
 * Upload bytes to the reference's `fullPath`. Replaces any existing
 * object at the path. Returns the populated `FullMetadata` and the
 * same `ref` for chaining.
 *
 * Throws when the reference targets the root (`fullPath === ''`) —
 * uploads need a non-empty path, matching Firebase's
 * `invalid-root-operation` precondition.
 *
 * Provenance is captured from the reference's operation-scoped Storage
 * handle before the first await. The optional `provenance` argument remains
 * as a compatibility override for internal callers. Either way, concurrent
 * uploads cannot exchange source or auth-lens identity, and
 * `service: 'storage'` always wins.
 */
export function uploadBytes(
  ref: StorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: SettableMetadata,
  provenance?: EventProvenance,
): Promise<UploadResult> {
  guardNonRoot(ref, 'uploadBytes');
  return uploadObject(ref, data, metadata, { provenance });
}

/** What {@link uploadObject} takes besides the bytes and settable metadata. */
export interface UploadObjectOptions {
  provenance?: EventProvenance;
  /**
   * Download tokens the object is created with, comma-separated, as
   * firebase-admin's `save` sets them through the
   * `firebaseStorageDownloadTokens` custom key. Only the admin plane sets them.
   */
  downloadTokens?: string;
}

/** An upload's result, with the object its write replaced. */
export interface ReplacingUploadResult {
  result: UploadResult;
  /**
   * The object at the path just before the write, read by the backend in the
   * same transaction as the write, or `undefined` when the path was empty. A
   * rollback puts it back with `replaceIfGeneration`.
   */
  replaced: StoredObject | undefined;
}

/**
 * The upload pipeline behind {@link uploadBytes}. The admin plane can also
 * create the object with download tokens, in the same write as its bytes.
 */
export async function uploadObject(
  ref: StorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata: SettableMetadata | undefined,
  options: UploadObjectOptions = {},
): Promise<UploadResult> {
  const { result } = await uploadObjectReplacing(ref, data, metadata, options);
  return result;
}

/** {@link uploadObject}, also returning the object the write replaced. */
export async function uploadObjectReplacing(
  ref: StorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata: SettableMetadata | undefined,
  { provenance, downloadTokens }: UploadObjectOptions = {},
): Promise<ReplacingUploadResult> {
  guardNonRoot(ref, 'uploadBytes');
  const operationStorage = operationStorageOf(ref);
  const target = targetOf(operationStorage);
  const setsTokens = downloadTokens !== undefined;
  if (setsTokens && planeOf(target) !== 'admin') {
    throw new StorageError('unauthorized', 'Only the admin plane sets download tokens on upload.');
  }
  const operationProvenance = storageOperationProvenance(target, provenance);
  const blob = toBlob(data, metadata?.contentType);
  const md5Hash = await computePayloadMd5Base64(data, blob);
  // Server-set object times come from the sandbox clock, so `timeCreated` and
  // `updated` agree with the `request.time` the rules see for this same upload.
  const uploadedAt = getClock(target.sandbox).date();
  const stored = buildStoredMetadata({ ref, blob, settable: metadata, now: uploadedAt, md5Hash });
  if (setsTokens) stored.downloadTokens = downloadTokens;
  const service = await getStorageService(operationStorage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: storageAuth(target),
      // Every upload is a `create`, whether or not an object exists at the
      // path; `resource` is the stored object when one does. `update` is a
      // metadata update.
      method: 'create',
      path: ref.fullPath,
      resource: requestResourceFor(stored, 'upload'),
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
  // The backend issues the generation in the write's transaction, so every
  // version gets its own, even within one clock tick (#1160).
  const replaced = await service.backend.put(ref.fullPath, blob, stored, generationIssuer(uploadedAt.getTime()));
  // Land the put on the unified Studio stream. Best-effort: a throw from
  // the emit path must not fail the upload the caller just completed.
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        at: getClock(target.sandbox).now(),
        service: 'storage',
        op: 'object_put',
        path: ref.fullPath,
        auth: storageAuth(target),
        before: replaced?.metadata,
        after: stored,
        detail: {
          bucket: target.bucket,
          size: stored.size,
          contentType: stored.contentType,
          overwrite: replaced !== undefined,
        },
      }),
      operationProvenance,
    );
  } catch {
    // Observational — never let event emission break a storage write.
  }
  return { result: { ref, metadata: toFullMetadata(stored, planeOf(target), ref.bucket) }, replaced };
}

/**
 * Upload a string in one of three formats:
 *
 *   - `raw` (default): UTF-8 text. Defaults `contentType` to
 *     `application/octet-stream` unless caller `metadata.contentType` sets one.
 *   - `base64`: standard base64-encoded bytes.
 *   - `data_url`: a `data:` URL -- the MIME prefix is honored as
 *     `contentType` unless the caller overrides it explicitly.
 */
export function uploadString(
  ref: StorageReference,
  value: string,
  format: StringFormat = 'raw',
  metadata?: SettableMetadata,
  provenance?: EventProvenance,
): Promise<UploadResult> {
  guardNonRoot(ref, 'uploadString');
  const { bytes, inferredType } = decodeString(value, format);
  let resolvedContentType = defaultRawContentType(format);
  if (inferredType !== undefined) {
    resolvedContentType = inferredType;
  }
  if (metadata?.contentType !== undefined) {
    resolvedContentType = metadata.contentType;
  }
  const effective: SettableMetadata = {
    ...metadata,
    contentType: resolvedContentType,
  };
  return uploadBytes(ref, bytes, effective, provenance);
}

/**
 * Build the `StoredMetadata` record we'll persist alongside the
 * blob. Server-set fields are populated here in one place so
 * Slice 6's `getMetadata` reads a consistent shape.
 *
 * The rules check builds `request.resource` from this record before
 * the write lands. A client upload stores the default `contentDisposition`
 * when it sets none; an admin-plane write stores only what it sets (see
 * content-defaults.ts).
 */
export function buildStoredMetadata(args: {
  ref: StorageReference;
  blob: Blob;
  settable: SettableMetadata | undefined;
  now?: Date;
  md5Hash?: string;
}): StoredMetadata {
  const { ref, blob, settable } = args;
  const now = (args.now ?? new Date()).toISOString();
  // Provisional: the backend issues the generation the write stores.
  const generation = String(clockGeneration((args.now ?? new Date()).getTime()));
  const name = ref.name;
  const target = targetOf(operationStorageOf(ref));
  const client = planeOf(target) === 'client';
  let contentDisposition = settable?.contentDisposition;
  if (client) {
    contentDisposition = uploadContentDisposition(settable?.contentDisposition, ref.fullPath);
  }
  const stored: StoredMetadata = {
    fullPath: ref.fullPath,
    name,
    bucket: target.bucket,
    generation,
    metageneration: '1',
    timeCreated: now,
    updated: now,
    size: blob.size,
    // `??` does not fold an empty `blob.type` into the fallback; `||`
    // does. `Blob` returns `''` for "no type set" rather than
    // `undefined`, so without this an unhinted Uint8Array upload
    // would land with `contentType: ''` instead of the documented
    // `application/octet-stream` default.
    contentType: settable?.contentType || blob.type || OCTET,
    cacheControl: settable?.cacheControl,
    contentDisposition,
    contentEncoding: settable?.contentEncoding,
    contentLanguage: settable?.contentLanguage,
    customMetadata: cloneCustomMetadata(settable?.customMetadata),
  };
  if (args.md5Hash !== undefined) {
    stored.md5Hash = args.md5Hash;
  }
  return stored;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Normalize the user's input to a `Blob`. The `contentType` hint
 * (from caller-supplied `SettableMetadata`) takes precedence over
 * any intrinsic type on the source — matching Firebase's "caller
 * → blob.type → octet-stream" precedence (survey Section 4).
 *
 * The case where `data` is already a `Blob` and `contentTypeHint`
 * is undefined preserves the blob's intrinsic type, so users
 * passing `new Blob([...], { type: 'application/json' })` don't
 * lose the type info.
 */
const PRECOMPUTED_MD5_KEY = Symbol.for('pyric.storage.precomputed-md5');
const globalPrecomputedMd5 = globalThis as { [PRECOMPUTED_MD5_KEY]?: WeakMap<Blob, string> };
const PRECOMPUTED_MD5 = (globalPrecomputedMd5[PRECOMPUTED_MD5_KEY] ??= new WeakMap());

/** Attach a precomputed RFC 1321 base64 MD5 digest to a staged file-backed `Blob` so finishing never re-reads the file. */
export function attachPrecomputedMd5(blob: Blob, md5Base64: string): void {
  PRECOMPUTED_MD5.set(blob, md5Base64);
}

/** Read any precomputed base64 MD5 digest attached to `blob`. */
export function precomputedMd5Of(blob: Blob): string | undefined {
  return PRECOMPUTED_MD5.get(blob);
}

function toBlob(
  data: Blob | Uint8Array | ArrayBuffer,
  contentTypeHint: string | undefined,
): Blob {
  if (data instanceof Blob) {
    if (contentTypeHint && contentTypeHint !== data.type) {
      // Force the caller's hint by rewrapping. Same bytes, new type.
      const rewrapped = new Blob([data], { type: contentTypeHint });
      const existingMd5 = precomputedMd5Of(data);
      if (existingMd5 !== undefined) {
        attachPrecomputedMd5(rewrapped, existingMd5);
      }
      return rewrapped;
    }
    return data;
  }
  // Uint8Array / ArrayBuffer -> Blob. ArrayBuffer-passing through
  // the Blob constructor's BlobPart accepts both shapes natively.
  return new Blob([data as ArrayBuffer], { type: contentTypeHint ?? '' });
}

const MD5_SLICE_BYTES = 64 * 1024;

async function computePayloadMd5Base64(
  data: Blob | Uint8Array | ArrayBuffer,
  blob: Blob,
): Promise<string> {
  if (data instanceof Blob) {
    const precomputed = precomputedMd5Of(data);
    if (precomputed !== undefined) {
      return precomputed;
    }
    const hasher = createMd5Hasher();
    for (let offset = 0; offset < blob.size; offset += MD5_SLICE_BYTES) {
      const end = Math.min(offset + MD5_SLICE_BYTES, blob.size);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      hasher.update(chunk);
    }
    const digest = hasher.digest();
    const buf = digest.buffer.slice(
      digest.byteOffset,
      digest.byteOffset + digest.byteLength,
    ) as ArrayBuffer;
    return arrayBufferToBase64(buf);
  }
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }
  const digest = md5(bytes);
  const buf = digest.buffer.slice(
    digest.byteOffset,
    digest.byteOffset + digest.byteLength,
  ) as ArrayBuffer;
  return arrayBufferToBase64(buf);
}

/**
 * Decode an `uploadString` payload into bytes + inferred MIME.
 * `inferredType` is set only for `data_url` (which carries one
 * structurally); the other formats return `undefined` and let the
 * caller's metadata + the default-raw fallback win.
 */
export function decodeString(
  value: string,
  format: StringFormat,
): { bytes: Uint8Array; inferredType: string | undefined } {
  if (format === 'raw') {
    return { bytes: new TextEncoder().encode(value), inferredType: undefined };
  }
  if (format === 'base64') {
    return { bytes: base64ToBytes(value), inferredType: undefined };
  }
  if (format === 'base64url') {
    return { bytes: base64UrlToBytes(value), inferredType: undefined };
  }
  if (format !== 'data_url') {
    throw new StorageError(
      'unknown',
      'An unknown error occurred, please check the error payload for server response.',
    );
  }
  // data_url -- split on the first comma. Mime+params live before
  // the comma; payload (raw or `;base64`-prefixed) lives after.
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma === -1) {
    throw invalidFormat(
      'data_url',
      'data_url requires a string starting with "data:" and containing a comma.',
    );
  }
  const header = value.slice(5, comma); // strip leading "data:"
  const payload = value.slice(comma + 1);
  const isB64 = header.endsWith(';base64');
  let mime = header;
  if (isB64) {
    mime = header.slice(0, -7);
  }
  if (mime === '') {
    mime = 'application/octet-stream';
  }
  if (isB64) {
    return { bytes: base64ToBytes(payload), inferredType: mime };
  }
  // Upstream `percentEncodedBytes_` maps decode failures to
  // storage/invalid-format (string.test.ts: `data:,%%0`).
  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    throw invalidFormat('data_url', 'Malformed data URL.');
  }
  return { bytes: new TextEncoder().encode(decoded), inferredType: mime };
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const standard = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = standard.length % 4;
  let padded = standard;
  if (remainder === 2) {
    padded = `${standard}==`;
  } else if (remainder === 3) {
    padded = `${standard}=`;
  }
  return base64ToBytes(padded);
}

function base64ToBytes(b64: string): Uint8Array {
  // `atob` is universally available in both browsers and Bun.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function defaultRawContentType(_format: StringFormat): string {
  return OCTET;
}

function guardNonRoot(ref: StorageReference, op: string): void {
  if (ref.fullPath === '') {
    throw invalidRootOperation(op);
  }
}
