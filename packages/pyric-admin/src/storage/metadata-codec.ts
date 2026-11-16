/**
 * Metadata translation helpers between `@google-cloud/storage` shapes and
 * Pyric's sandbox storage metadata records.
 */

import { defineOwnMetadataKey } from 'pyric/storage/internal';

/** The custom metadata key holding a file's download tokens, comma-separated. */
export const DOWNLOAD_TOKENS_KEY = 'firebaseStorageDownloadTokens';

/** Settable fields the sandbox keeps, besides custom metadata. */
export const SETTABLE_FIELDS = [
  'contentType',
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
] as const;

export type SettableField = (typeof SETTABLE_FIELDS)[number];

/** A file's metadata. Subset of `@google-cloud/storage`'s `FileMetadata`. */
export interface FileMetadata {
  name: string;
  bucket: string;
  generation: string;
  metageneration: string;
  /** Size in bytes, as a decimal string. */
  size: string;
  timeCreated: string;
  updated: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  md5Hash?: string;
  /** Custom metadata, including `firebaseStorageDownloadTokens` once the file has a download URL. Absent when there is none. */
  metadata?: Record<string, string>;
}

/** What `File.setMetadata` takes. Subset of `@google-cloud/storage`'s `FileMetadata`. */
export type FileMetadataUpdate = Partial<Record<SettableField, string | null>> & {
  /** Custom keys to set; `null` removes a key. Values are stored as strings. */
  metadata?: Record<string, string | number | boolean | null>;
};

export interface HostMetadata {
  bucket: string;
  fullPath: string;
  generation: string;
  metageneration: string;
  size: number;
  timeCreated: string;
  updated: string;
  md5Hash?: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: Record<string, string>;
  downloadTokens?: string;
}

/** A metadata change in the form hosts take: settable fields, custom keys, and the download tokens apart. */
export interface MetadataPatch {
  settable: Partial<Record<SettableField, string | null>>;
  customMetadata: Record<string, string | null>;
  downloadTokens?: string | null;
}

/** Metadata a new object is saved with: settable fields, custom keys, and the download tokens apart. */
export interface SavedMetadata {
  settable: Partial<Record<SettableField, string>>;
  custom: Record<string, string>;
  downloadTokens?: string;
}

/** A host's metadata in `@google-cloud/storage`'s shape: the download tokens become the custom key production uses. */
export function fileMetadataOf(host: HostMetadata): FileMetadata {
  const custom: Record<string, string> = {};
  if (host.customMetadata !== undefined) {
    for (const [key, value] of Object.entries(host.customMetadata)) {
      defineOwnMetadataKey(custom, key, value);
    }
  }
  if (host.downloadTokens) defineOwnMetadataKey(custom, DOWNLOAD_TOKENS_KEY, host.downloadTokens);
  const settable: Partial<Record<SettableField, string>> = {};
  for (const field of SETTABLE_FIELDS) {
    const value = host[field];
    if (value !== undefined) settable[field] = value;
  }
  const hasCustom = Object.keys(custom).length > 0;
  return {
    name: host.fullPath,
    bucket: host.bucket,
    generation: host.generation,
    metageneration: host.metageneration,
    size: String(host.size),
    timeCreated: host.timeCreated,
    updated: host.updated,
    ...settable,
    ...(host.md5Hash !== undefined ? { md5Hash: host.md5Hash } : {}),
    ...(hasCustom ? { metadata: custom } : {}),
  };
}

/**
 * Split `@google-cloud/storage`-shaped metadata into a {@link MetadataPatch}.
 * `setMetadata` is strict and refuses fields the sandbox does not keep;
 * `save` has always stored what it was given and ignores them.
 */
export function patchOf(
  metadata: FileMetadataUpdate | Record<string, unknown>,
  { strict }: { strict: boolean },
): MetadataPatch {
  const source = metadata as Record<string, unknown>;
  const unsupported = Object.keys(source).filter(
    (key) => key !== 'metadata' && !(SETTABLE_FIELDS as readonly string[]).includes(key),
  );
  if (strict && unsupported.length > 0) {
    throw new Error(
      `not implemented in pyric-admin/storage sandbox backend: setMetadata of ${unsupported.join(', ')}. ` +
        `The sandbox keeps ${SETTABLE_FIELDS.join(', ')}, and custom metadata under \`metadata\`.`,
    );
  }
  const patch: MetadataPatch = { settable: {}, customMetadata: {} };
  for (const field of SETTABLE_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' || value === null) patch.settable[field] = value;
  }
  const custom = source.metadata;
  const hasCustom = custom !== null && typeof custom === 'object';
  if (!hasCustom) return patch;
  for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
    if (value === undefined) continue;
    const next = value === null ? null : String(value);
    if (key === DOWNLOAD_TOKENS_KEY) patch.downloadTokens = next;
    else defineOwnMetadataKey(patch.customMetadata, key, next);
  }
  return patch;
}

/**
 * The metadata `save` and `createWriteStream` create an object with. It uses
 * {@link patchOf} so `firebaseStorageDownloadTokens` becomes the object's
 * download tokens on every path; a `null` key is not stored.
 */
export function savedMetadataOf(metadata: Record<string, unknown>): SavedMetadata {
  const patch = patchOf(metadata, { strict: false });
  const settable: Partial<Record<SettableField, string>> = {};
  for (const field of SETTABLE_FIELDS) {
    const value = patch.settable[field];
    if (typeof value === 'string') settable[field] = value;
  }
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch.customMetadata)) {
    if (value !== null) defineOwnMetadataKey(custom, key, value);
  }
  const tokens = patch.downloadTokens;
  return { settable, custom, ...(typeof tokens === 'string' ? { downloadTokens: tokens } : {}) };
}
