/**
 * The admin plane's object copy, as `@google-cloud/storage`'s `File.copy`
 * rewrites an object: within a bucket or into another one.
 */
import type { EventProvenance } from 'pyric/sandbox';
import { getStorageService, targetOf } from './service.js';
import { planeOf } from './content-defaults.js';
import { StorageError } from './errors.js';
import { getMetadata, type AdminMetadataPatch, type FullMetadata, type SettableMetadata } from './metadata.js';
import { uploadObject } from './upload.js';
import type { StorageReference } from './reference.js';

const COPIED_FIELDS = ['contentType', 'cacheControl', 'contentDisposition', 'contentEncoding', 'contentLanguage'] as const;

/**
 * Copy the object at `source` to `destination`, which may be in another
 * bucket. The copy keeps the source's settable fields, custom metadata and
 * download tokens; `patch` changes them on the copy only, where a `null`
 * custom key or `null` download tokens removes them. Both references must come
 * from the admin plane. Throws `storage/object-not-found` when the source is absent.
 */
export async function copyObject(
  source: StorageReference,
  destination: StorageReference,
  patch: AdminMetadataPatch = {},
  provenance?: EventProvenance,
): Promise<FullMetadata> {
  const adminPlane = planeOf(targetOf(source.storage)) === 'admin' && planeOf(targetOf(destination.storage)) === 'admin';
  if (!adminPlane) throw new StorageError('unauthorized', 'Only the admin plane copies objects (firebase-admin File.copy).');
  await getMetadata(source);
  const sourceTarget = targetOf(source.storage);
  const service = await getStorageService(source.storage);
  const object = await service.backend.getObject(source.fullPath, sourceTarget.bucket);
  const missing = object === undefined;
  if (missing) throw new StorageError('object-not-found', `Object '${source.fullPath}' does not exist.`);
  const stored = object!.metadata;
  const settable: SettableMetadata = {};
  for (const field of COPIED_FIELDS) {
    const value = patch.settable?.[field] ?? stored[field];
    if (value !== undefined) settable[field] = value;
  }
  const custom: Record<string, string> = { ...(stored.customMetadata ?? {}) };
  for (const [key, value] of Object.entries(patch.customMetadata ?? {})) {
    if (value === null) delete custom[key];
    else custom[key] = value;
  }
  const hasCustom = Object.keys(custom).length > 0;
  if (hasCustom) settable.customMetadata = custom;
  const tokens = patch.downloadTokens === undefined ? stored.downloadTokens : patch.downloadTokens ?? undefined;
  const result = await uploadObject(destination, object!.blob, settable, {
    ...(provenance !== undefined ? { provenance } : {}),
    ...(tokens !== undefined && tokens !== '' ? { downloadTokens: tokens } : {}),
  });
  return result.metadata;
}
