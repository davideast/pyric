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
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { getStorageService, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored, requestResourceFor } from './rules.js';
import { toFullMetadata, type SettableMetadata, type UploadResult } from './metadata.js';
import { invalidRootOperation, invalidFormat } from './errors.js';
import type { StoredMetadata } from './persistence.js';
import type { StorageReference } from './reference.js';

const OCTET = 'application/octet-stream';

/** `uploadString` format selector. */
export type StringFormat = 'raw' | 'base64' | 'data_url';

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
export async function uploadBytes(
  ref: StorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: SettableMetadata,
  provenance?: EventProvenance,
): Promise<UploadResult> {
  guardNonRoot(ref, 'uploadBytes');
  const target = targetOf(ref.storage);
  const operationProvenance = storageOperationProvenance(target, provenance);
  const blob = toBlob(data, metadata?.contentType);
  const stored = buildStoredMetadata({ ref, blob, settable: metadata });
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      // A write to a nonexistent object is a `create`; a write over an
      // existing one is an `update`. The resource-exists fact (`existing`)
      // makes the distinction the granular verbs need.
      method: existing ? 'update' : 'create',
      path: ref.fullPath,
      resource: requestResourceFor({
        size: stored.size,
        contentType: stored.contentType,
        customMetadata: stored.customMetadata,
      }),
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
  await service.backend.put(ref.fullPath, blob, stored);
  // Land the put on the unified Studio stream. Best-effort: a throw from
  // the emit path must not fail the upload the caller just completed.
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        service: 'storage',
        op: 'object_put',
        path: ref.fullPath,
        auth: target.context.auth,
        before: existing ?? undefined,
        after: stored,
        detail: {
          bucket: ref.bucket,
          size: stored.size,
          contentType: stored.contentType,
          overwrite: existing != null,
        },
      }),
      operationProvenance,
    );
  } catch {
    // Observational — never let event emission break a storage write.
  }
  return { ref, metadata: toFullMetadata(stored) };
}

/**
 * Upload a string in one of three formats:
 *
 *   - `raw` (default): UTF-8 text. Defaults `contentType` to
 *     `text/plain;charset=utf-8` if neither metadata nor the data
 *     specify one.
 *   - `base64`: standard base64-encoded bytes.
 *   - `data_url`: a `data:` URL — the MIME prefix is honored as
 *     `contentType` unless the caller overrides it explicitly.
 */
export async function uploadString(
  ref: StorageReference,
  value: string,
  format: StringFormat = 'raw',
  metadata?: SettableMetadata,
  provenance?: EventProvenance,
): Promise<UploadResult> {
  const { bytes, inferredType } = decodeString(value, format);
  const effective: SettableMetadata = {
    ...metadata,
    contentType: metadata?.contentType ?? inferredType ?? defaultRawContentType(format),
  };
  return uploadBytes(ref, bytes, effective, provenance);
}

/**
 * Build the `StoredMetadata` record we'll persist alongside the
 * blob. Server-set fields are populated here in one place so
 * Slice 6's `getMetadata` reads a consistent shape.
 *
 * Exported for the rare cases where Slice 8's rule pre-check needs
 * to materialize the about-to-write metadata to feed into the
 * evaluator (specifically `request.resource.size` /
 * `.contentType`).
 */
export function buildStoredMetadata(args: {
  ref: StorageReference;
  blob: Blob;
  settable: SettableMetadata | undefined;
  now?: Date;
}): StoredMetadata {
  const { ref, blob, settable } = args;
  const now = (args.now ?? new Date()).toISOString();
  const generation = generationFromTime(args.now ?? new Date());
  const name = ref.name;
  return {
    fullPath: ref.fullPath,
    name,
    bucket: ref.bucket,
    generation,
    metageneration: '1',
    timeCreated: now,
    updated: now,
    size: blob.size,
    // `??` doesn't fold an empty `blob.type` into the fallback; `||`
    // does. `Blob` returns `''` for "no type set" rather than
    // `undefined`, so without this an unhinted Uint8Array upload
    // would land with `contentType: ''` instead of the documented
    // `application/octet-stream` default.
    contentType: settable?.contentType || blob.type || OCTET,
    cacheControl: settable?.cacheControl,
    contentDisposition: settable?.contentDisposition,
    contentEncoding: settable?.contentEncoding,
    contentLanguage: settable?.contentLanguage,
    customMetadata: settable?.customMetadata,
  };
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
function toBlob(
  data: Blob | Uint8Array | ArrayBuffer,
  contentTypeHint: string | undefined,
): Blob {
  if (data instanceof Blob) {
    if (contentTypeHint && contentTypeHint !== data.type) {
      // Force the caller's hint by rewrapping. Same bytes, new type.
      return new Blob([data], { type: contentTypeHint });
    }
    return data;
  }
  // Uint8Array / ArrayBuffer → Blob. ArrayBuffer-passing through
  // the Blob constructor's BlobPart accepts both shapes natively.
  return new Blob([data as ArrayBuffer], { type: contentTypeHint ?? '' });
}

/**
 * Decode an `uploadString` payload into bytes + inferred MIME.
 * `inferredType` is set only for `data_url` (which carries one
 * structurally); the other formats return `undefined` and let the
 * caller's metadata + the default-raw fallback win.
 */
function decodeString(
  value: string,
  format: StringFormat,
): { bytes: Uint8Array; inferredType: string | undefined } {
  if (format === 'raw') {
    return { bytes: new TextEncoder().encode(value), inferredType: undefined };
  }
  if (format === 'base64') {
    return { bytes: base64ToBytes(value), inferredType: undefined };
  }
  if (format !== 'data_url') {
    // A JS caller can pass a string the `StringFormat` type rules out
    // (`'base64url'`, `'hex'`, …). Divergence, oracle-locked by
    // `storage-uploadstring-unknown-format.json`: prod ACCEPTS
    // `base64url` (uploads succeed) and throws `storage/unknown` for a
    // genuinely-unrecognized format. The sandbox instead throws
    // `storage/invalid-format` for anything outside the v1 scope's
    // `raw`/`base64`/`data_url`, naming the bad format rather than
    // mis-parsing it as a data_url. See storage#41 in COMPAT.md.
    throw invalidFormat(
      String(format),
      `unknown uploadString format — expected "raw", "base64", or "data_url".`,
    );
  }
  // data_url — split on the first comma. Mime+params live before
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
  const mime = (isB64 ? header.slice(0, -7) : header) || 'application/octet-stream';
  const bytes = isB64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  return { bytes, inferredType: mime };
}

function base64ToBytes(b64: string): Uint8Array {
  // `atob` is universally available in both browsers and Bun.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function defaultRawContentType(format: StringFormat): string {
  return format === 'raw' ? 'text/plain;charset=utf-8' : OCTET;
}

function generationFromTime(now: Date): string {
  // Generation is a stringified counter in production. We mint a
  // unique-enough value from the wallclock — collisions are
  // tolerable for the v1 scope (single-process IDB; no cross-tab
  // contention contract).
  return String(now.getTime());
}

function guardNonRoot(ref: StorageReference, op: string): void {
  if (ref.fullPath === '') {
    throw invalidRootOperation(op);
  }
}
