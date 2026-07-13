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
 * against either implementation. Two intentional differences:
 *
 * - `ref` is omitted from `FullMetadata`. The JS SDK populates it
 *   lazily; we don't need that machinery for the v1 scope.
 * - `downloadTokens` is omitted. Sandbox `getDownloadURL` returns a page-local
 *   object URL, so it has no Firebase download token to expose.
 */
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import type { EventProvenance } from 'pyric/sandbox';
import { getStorageService, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';
import { resourceFromStored, requestResourceFor } from './rules.js';
import { objectNotFound, invalidRootOperation } from './errors.js';
import type { StoredMetadata } from './persistence.js';
import type { StorageReference } from './reference.js';

/**
 * Client-settable fields. Passed to `uploadBytes` /
 * `uploadString` / `updateMetadata`. Every field is optional — the
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
 * Server-set + client-settable fields read back from
 * `uploadBytes` / `getMetadata` / `updateMetadata`. Server-set
 * fields (`bucket`, `fullPath`, `name`, `generation`,
 * `metageneration`, `timeCreated`, `updated`, `size`) are populated
 * by the upload pipeline; client-settable fields round-trip from
 * `SettableMetadata`.
 */
export interface FullMetadata extends SettableMetadata {
  bucket: string;
  fullPath: string;
  name: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  size: number;
  md5Hash?: string;
}

/** Return shape of `uploadBytes` / `uploadString`. */
export interface UploadResult {
  metadata: FullMetadata;
  ref: StorageReference;
}

/**
 * Project a `StoredMetadata` (persistence-layer shape) onto the
 * public `FullMetadata`. Currently a 1:1 cast — the shapes match —
 * but kept as a function so future divergence (e.g. lazy `ref`
 * computation) has a single seam.
 */
export function toFullMetadata(stored: StoredMetadata): FullMetadata {
  return { ...stored };
}

/**
 * Apply a `SettableMetadata` patch onto an existing
 * `StoredMetadata`, replacing only the client-settable fields. The
 * server-set fields (`bucket`, `fullPath`, `name`, `generation`,
 * `timeCreated`, `size`, `md5Hash`) are preserved. `metageneration`
 * is bumped, and `updated` is refreshed to the call moment — both
 * are server-tracked but driven by client-initiated changes.
 *
 * Used by `updateMetadata` in Slice 6. Defined here in Slice 5 so
 * the types stay close to the rest of the metadata model.
 */
export function applyMetadataPatch(
  base: StoredMetadata,
  patch: SettableMetadata,
  now: Date = new Date(),
): StoredMetadata {
  return {
    ...base,
    // Client-settable fields are REPLACED wholesale per Firebase
    // semantics; passing `undefined` removes the field.
    contentType: patch.contentType ?? base.contentType,
    cacheControl: patch.cacheControl ?? base.cacheControl,
    contentDisposition: patch.contentDisposition ?? base.contentDisposition,
    contentEncoding: patch.contentEncoding ?? base.contentEncoding,
    contentLanguage: patch.contentLanguage ?? base.contentLanguage,
    customMetadata: patch.customMetadata ?? base.customMetadata,
    metageneration: bump(base.metageneration),
    updated: now.toISOString(),
  };
}

/** Bump a base-10 numeric string by 1; `'5'` → `'6'`. */
export function bump(value: string): string {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return '1';
  return String(parsed + 1);
}

// ─── Public operations (Slice 6) ───────────────────────────────────

/**
 * Read the full metadata record at `ref`. Throws when no object
 * exists at the path (`storage/object-not-found`).
 *
 * Mirrors `firebase/storage`'s `getMetadata`. Returns the same
 * `FullMetadata` shape `uploadBytes` produced — server-set fields
 * pinned at upload time, client-settable fields whatever the latest
 * write left them as.
 */
export async function getMetadata(ref: StorageReference): Promise<FullMetadata> {
  guardNonRoot(ref, 'getMetadata');
  const target = targetOf(ref.storage);
  const operationProvenance = storageOperationProvenance(target);
  const service = await getStorageService(ref.storage);
  const stored = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      method: 'get',
      path: ref.fullPath,
    },
    resource: resourceFromStored(stored),
  }, target, operationProvenance);
  if (!stored) {
    throw objectNotFound(ref.fullPath);
  }
  return toFullMetadata(stored);
}

/**
 * Update the client-settable metadata at `ref`. Server-set fields
 * (`bucket`, `fullPath`, `name`, `generation`, `timeCreated`,
 * `size`, `md5Hash`) are preserved; `metageneration` bumps and
 * `updated` refreshes. The blob is untouched.
 *
 * Pass `undefined` for a field to leave the previous value in
 * place. To explicitly clear a field, the JS SDK accepts `null` —
 * we don't model that in the v1 scope to keep the patch logic simple.
 * Documented for Slice 9's deferred-features section.
 *
 * `provenance` (host-only): op {@link EventProvenance} bound at ISSUE time,
 * threaded EXPLICITLY onto the emitted `metadata_update` event. Emit runs
 * after the backend awaits, escaping the sandbox's synchronous
 * ambient-provenance window — see the note on `uploadBytes`.
 */
export async function updateMetadata(
  ref: StorageReference,
  patch: SettableMetadata,
  provenance?: EventProvenance,
): Promise<FullMetadata> {
  guardNonRoot(ref, 'updateMetadata');
  const target = targetOf(ref.storage);
  const operationProvenance = storageOperationProvenance(target, provenance);
  const service = await getStorageService(ref.storage);
  const existing = await service.backend.getMetadata(ref.fullPath);
  enforceRules(service, {
    request: {
      auth: target.context.auth,
      // updateMetadata always targets an existing object (it throws
      // object-not-found below when absent), so the verb is `update`.
      method: 'update',
      path: ref.fullPath,
      // The patched view drives `request.resource` for size /
      // contentType / metadata rule checks. Custom metadata is
      // REPLACED wholesale on a patch (see `applyMetadataPatch`), so
      // the about-to-write `request.resource.metadata` is the patch's
      // custom metadata when supplied, else the existing value.
      resource: existing
        ? requestResourceFor({
            size: existing.size,
            contentType: patch.contentType ?? existing.contentType,
            customMetadata: patch.customMetadata ?? existing.customMetadata,
          })
        : undefined,
    },
    resource: resourceFromStored(existing),
  }, target, operationProvenance);
  if (!existing) {
    throw objectNotFound(ref.fullPath);
  }
  const next = applyMetadataPatch(existing, patch);
  await service.backend.putMetadata(ref.fullPath, next);
  try {
    emitSandboxEvent(
      target.sandbox,
      makeServiceMutationEvent({
        service: 'storage',
        op: 'metadata_update',
        path: ref.fullPath,
        auth: target.context.auth,
        before: existing,
        after: next,
        detail: { bucket: ref.bucket },
      }),
      operationProvenance,
    );
  } catch {
    // Observational — never let event emission break a metadata update.
  }
  return toFullMetadata(next);
}

function guardNonRoot(ref: StorageReference, op: string): void {
  if (ref.fullPath === '') {
    throw invalidRootOperation(op);
  }
}
