/**
 * Metadata types + helpers.
 *
 * Type definitions land in Slice 5 (used by `uploadBytes` for its
 * `SettableMetadata` argument and `UploadResult.metadata` return);
 * the public `getMetadata` / `updateMetadata` operations land in
 * Slice 6 on the back of these same types.
 *
 * The shapes mirror `firebase/storage`'s `FullMetadata` and
 * `SettableMetadata` (survey Section 5) so consumer code typechecks
 * against either implementation. One intentional difference, and one field
 * that depends on the host:
 *
 * - `ref` is omitted from `FullMetadata`. The JS SDK populates it
 *   lazily; we don't need that machinery for the v1 scope.
 * - `downloadTokens` is kept when a host that serves bytes over HTTP mints
 *   one; elsewhere `getDownloadURL` returns a `data:` URI and none exists.
 */
import { emitSandboxEvent, getClock, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { operationStorageOf } from './sandbox/cross-bucket-target.js';
import { getStorageService, storageAuth, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored, requestResourceFor } from './sandbox/rules-resources.js';
import { clientContentEncoding, planeOf, type StoragePlane } from './content-defaults.js';
import { computeStorageEtag } from './digests.js';
import { objectNotFound, invalidRootOperation } from './errors.js';
import type { StoredMetadata } from './persistence.js';
import type { StorageReference } from './reference.js';

/**
 * Client-settable fields. Passed to `uploadBytes` /
 * `uploadString` / `updateMetadata`. Every field is optional -- the
 * upload pipeline fills any unsupplied client fields with sane
 * defaults (e.g. `contentType` falls back to `application/octet-stream`).
 */
export interface SettableMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: { [key: string]: string };
}

/**
 * Object metadata accepted at upload time, mirroring `firebase/storage`'s
 * `UploadMetadata`.
 */
export interface UploadMetadata extends SettableMetadata {
  md5Hash?: string | undefined;
}

/**
 * Server-set + client-settable fields read back from
 * `uploadBytes` / `getMetadata` / `updateMetadata`. Server-set
 * fields (`bucket`, `fullPath`, `name`, `generation`,
 * `metageneration`, `timeCreated`, `updated`, `size`) are populated
 * by the upload pipeline; client-settable fields round-trip from
 * `SettableMetadata`.
 */
export interface FullMetadata extends UploadMetadata {
  bucket: string;
  fullPath: string;
  name: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  size: number;
}

/** Return shape of `uploadBytes` / `uploadString`. */
export interface UploadResult {
  metadata: FullMetadata;
  ref: StorageReference;
}

/** Define an own enumerable property without triggering prototype setters (e.g. `"__proto__"`). */
export function defineOwnMetadataKey<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Shallow-clone `customMetadata` so caller mutations and stored records stay isolated. */
export function cloneCustomMetadata(
  customMetadata: { [key: string]: string } | undefined,
): { [key: string]: string } | undefined {
  if (customMetadata === undefined) return undefined;
  const cloned: Record<string, string> = {};
  for (const [key, value] of Object.entries(customMetadata)) {
    defineOwnMetadataKey(cloned, key, value);
  }
  return cloned;
}

/** Shallow-clone settable metadata and its nested `customMetadata` map when present. */
export function cloneSettableMetadata<T extends { customMetadata?: { [key: string]: string } }>(
  metadata: T | undefined,
): T | undefined {
  if (metadata === undefined) return undefined;
  const customMetadata = cloneCustomMetadata(metadata.customMetadata);
  if (customMetadata === undefined) return { ...metadata };
  return { ...metadata, customMetadata };
}

/**
 * Project a `StoredMetadata` (persistence-layer shape) onto the public
 * `FullMetadata` a caller on `plane` reads. A client reads an unset
 * `contentEncoding` as `identity`, as the Firebase Storage endpoint reports
 * it; the admin plane reads the stored record as is.
 */
export function toFullMetadata(
  stored: StoredMetadata,
  plane: StoragePlane,
  bucket = stored.bucket,
): FullMetadata {
  const { customMetadata: rawCustomMetadata, crc32c: _crc32c, etag: _etag, ...rest } = stored;
  const custom = cloneCustomMetadata(rawCustomMetadata);
  const out: FullMetadata = { ...rest, bucket };
  if (plane !== 'admin') {
    out.contentEncoding = clientContentEncoding(stored.contentEncoding);
  }
  if (custom !== undefined) {
    out.customMetadata = custom;
  }
  return out;
}

/**
 * Apply a `SettableMetadata` patch onto an existing
 * `StoredMetadata`, replacing only the client-settable fields. The
 * server-set fields (`bucket`, `fullPath`, `name`, `generation`,
 * `timeCreated`, `size`, `md5Hash`) are preserved. `metageneration`
 * is bumped, and `updated` is refreshed to the call moment -- both
 * are server-tracked but driven by client-initiated changes.
 *
 * Used by `updateMetadata` in Slice 6. Defined here in Slice 5 so
 * the types stay close to the rest of the metadata model.
 */
function mergePatchCustomMetadata(
  base: { [key: string]: string } | undefined,
  patch: { [key: string]: string } | null | undefined,
): { [key: string]: string } | undefined {
  if (patch === undefined) {
    return cloneCustomMetadata(base);
  }
  if (patch === null) {
    return undefined;
  }
  const merged: Record<string, string> = cloneCustomMetadata(base) ?? {};
  for (const [key, value] of Object.entries(patch as Record<string, string | null>)) {
    if (value === null) {
      delete merged[key];
    } else if (typeof value === 'string') {
      defineOwnMetadataKey(merged, key, value);
    }
  }
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

function applyMetadataPatch(
  base: StoredMetadata,
  patch: SettableMetadata,
  now: Date = new Date(),
): StoredMetadata {
  const metageneration = bump(base.metageneration);
  const next: StoredMetadata = {
    ...base,
    metageneration,
    etag: computeStorageEtag(base.generation, metageneration),
    updated: now.toISOString(),
  };
  const rawPatch = patch as AdminSettableMetadataPatch;
  for (const field of ADMIN_SETTABLE_FIELDS) {
    const value = rawPatch[field];
    if (value === null) {
      delete next[field];
    } else if (value !== undefined) {
      next[field] = value;
    }
  }
  const mergedCustom = mergePatchCustomMetadata(
    base.customMetadata,
    patch.customMetadata as { [key: string]: string } | null | undefined,
  );
  if (mergedCustom !== undefined) {
    next.customMetadata = mergedCustom;
  } else {
    delete next.customMetadata;
  }
  return next;
}

/** Bump a base-10 numeric string by 1; `'5'` -> `'6'`. */
function bump(value: string): string {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return '1';
  return String(parsed + 1);
}

// --- Public operations (Slice 6) -----------------------------------

/**
 * Read the full metadata record at `ref`. Throws when no object
 * exists at the path (`storage/object-not-found`).
 *
 * Mirrors `firebase/storage`'s `getMetadata`. Returns the same
 * `FullMetadata` shape `uploadBytes` produced -- server-set fields
 * pinned at upload time, client-settable fields whatever the latest
 * write left them as.
 */
export function getMetadata(ref: StorageReference): Promise<FullMetadata> {
  guardNonRoot(ref, 'getMetadata');
  return readObjectMetadata(ref);
}

async function readObjectMetadata(ref: StorageReference): Promise<FullMetadata> {
  const operationStorage = operationStorageOf(ref);
  const target = targetOf(operationStorage);
  const operationProvenance = storageOperationProvenance(target);
  const service = await getStorageService(operationStorage);
  const stored = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: storageAuth(target),
      method: 'get',
      path: ref.fullPath,
    },
    resource: resourceFromStored(stored),
  }, target, operationProvenance);
  if (!stored) {
    throw objectNotFound(ref.fullPath);
  }
  return toFullMetadata(stored, planeOf(target), ref.bucket);
}

/**
 * Update the client-settable metadata at `ref`. Server-set fields
 * (`bucket`, `fullPath`, `name`, `generation`, `timeCreated`,
 * `size`, `md5Hash`) are preserved; `metageneration` bumps and
 * `updated` refreshes. The blob is untouched.
 *
 * Pass `undefined` for a field to leave the previous value in place, or
 * `null` to explicitly clear a writable field or `customMetadata` entry/map.
 *
 * `provenance` (host-only): op {@link EventProvenance} bound at ISSUE time,
 * threaded EXPLICITLY onto the emitted `metadata_update` event. Emit runs
 * after the backend awaits, escaping the sandbox's synchronous
 * ambient-provenance window -- see the note on `uploadBytes`.
 */
export function updateMetadata(
  ref: StorageReference,
  patch: SettableMetadata,
  provenance?: EventProvenance,
): Promise<FullMetadata> {
  guardNonRoot(ref, 'updateMetadata');
  return rewriteMetadata(ref, 'updateMetadata', (existing, now) => applyMetadataPatch(existing, patch, now), provenance);
}

/** Settable object metadata fields for an admin patch (`null` clears a previously set value). */
export interface AdminSettableMetadataPatch {
  contentType?: string | null;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  contentLanguage?: string | null;
}

const ADMIN_SETTABLE_FIELDS = [
  'contentType',
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
] as const;

/**
 * What the admin plane changes in one metadata write, as firebase-admin's
 * `File.setMetadata` does.
 */
export interface AdminMetadataPatch {
  /** Settable fields to replace; `null` clears a field. Custom metadata is merged through `customMetadata`. */
  settable?: AdminSettableMetadataPatch;
  /** Custom keys to set; `null` removes a key. Keys not named stay. */
  customMetadata?: { [key: string]: string | null };
  /** The object's download tokens, or `null` to remove them, which revokes their URLs. */
  downloadTokens?: string | null;
}

/**
 * Merge `patch` into an object's metadata in one write. Rules apply as for
 * `updateMetadata`; the admin plane's handle bypasses them.
 */
export async function patchObjectMetadata(
  ref: StorageReference,
  patch: AdminMetadataPatch,
  provenance?: EventProvenance,
): Promise<FullMetadata> {
  return rewriteMetadata(ref, 'setMetadata', (existing, now) => {
    const metageneration = bump(existing.metageneration);
    const next: StoredMetadata = {
      ...existing,
      metageneration,
      etag: computeStorageEtag(existing.generation, metageneration),
      updated: now.toISOString(),
    };
    const settable = patch.settable;
    if (settable !== undefined) {
      for (const field of ADMIN_SETTABLE_FIELDS) {
        const value = settable[field];
        if (value === null) {
          delete next[field];
        } else if (value !== undefined) {
          next[field] = value;
        }
      }
    }
    const custom = cloneCustomMetadata(existing.customMetadata) ?? {};
    for (const [key, value] of Object.entries(patch.customMetadata ?? {})) {
      if (value === null) {
        delete custom[key];
      } else {
        defineOwnMetadataKey(custom, key, value);
      }
    }
    const hasCustom = Object.keys(custom).length > 0;
    if (hasCustom) next.customMetadata = custom;
    else delete next.customMetadata;
    // `null` removes the tokens, which revokes their URLs.
    const tokens = patch.downloadTokens;
    if (tokens === null) delete next.downloadTokens;
    else if (tokens !== undefined) next.downloadTokens = tokens;
    return next;
  }, provenance);
}

/**
 * Replace an object's metadata with `change(existing)`: `update` rules see the
 * changed view, the backend writes it, and one `metadata_update` event records
 * it. Throws `storage/object-not-found` when the object is absent.
 */
async function rewriteMetadata(
  ref: StorageReference,
  operation: string,
  change: (existing: StoredMetadata, now: Date) => StoredMetadata,
  provenance?: EventProvenance,
): Promise<FullMetadata> {
  guardNonRoot(ref, operation);
  const operationStorage = operationStorageOf(ref);
  const target = targetOf(operationStorage);
  const operationProvenance = storageOperationProvenance(target, provenance);
  const service = await getStorageService(operationStorage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  const next = existing ? change(existing, getClock(target.sandbox).date()) : undefined;
  enforceRules(service, {
    request: {
      auth: storageAuth(target),
      // The operation always targets an existing object (it throws
      // object-not-found below when absent), so the verb is `update`.
      method: 'update',
      path: ref.fullPath,
      // The changed view drives `request.resource`, with the stored
      // metageneration: production shows the rule the version before this
      // write advances it.
      resource: existing && next
        ? requestResourceFor({ ...next, metageneration: existing.metageneration }, 'metadataUpdate')
        : undefined,
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
  if (!existing || !next) {
    throw objectNotFound(ref.fullPath);
  }
  await service.backend.putMetadata(ref.fullPath, next);
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        at: getClock(target.sandbox).now(),
        service: 'storage',
        op: 'metadata_update',
        path: ref.fullPath,
        auth: storageAuth(target),
        before: existing,
        after: next,
        detail: { bucket: target.bucket },
      }),
      operationProvenance,
    );
  } catch {
    // Observational -- never let event emission break a metadata update.
  }
  return toFullMetadata(next, planeOf(target), ref.bucket);
}

function guardNonRoot(ref: StorageReference, op: string): void {
  if (ref.fullPath === '') {
    throw invalidRootOperation(op);
  }
}
