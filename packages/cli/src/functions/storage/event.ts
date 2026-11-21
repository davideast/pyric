/**
 * CloudEvent v1.0 and `StorageObjectData` encoder for `firebase-functions/v2/storage`
 * (`7.2.5`), matching Google Cloud Storage Eventarc JSON payloads and
 * `lib/v2/providers/storage.js` handler + v1-compat expectations.
 */
import { createHash } from 'node:crypto';
import { defineOwnMetadataKey } from 'pyric/storage/internal';
import type { DiscoveredStorageTrigger, StorageEventType } from './discovery.js';

const DOWNLOAD_TOKENS_METADATA_KEY = 'firebaseStorageDownloadTokens';
const EMPTY_MD5_BASE64 = '1B2M2Y8AsgTpgAmY7PhCfg==';
const EMPTY_CRC32C_BASE64 = 'AAAAAA==';

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) !== 0) {
        crc = 0x82f63b78 ^ (crc >>> 1);
      } else {
        crc = crc >>> 1;
      }
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

export interface StorageObjectSnapshot {
  fullPath: string;
  bucket: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  timeDeleted?: string;
  size: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: Record<string, string>;
  downloadTokens?: string;
  md5Hash?: string;
  crc32c?: string;
  etag?: string;
  storageClass?: string;
}

export interface StorageCloudEventOptions {
  id: string;
  time: string;
  location: string;
  eventType: StorageEventType;
  bucket?: string;
}

export type StorageExecutionResult =
  | { status: 'fulfilled'; event: Record<string, unknown>; result: unknown }
  | { status: 'rejected'; event: Record<string, unknown>; error: unknown };

/**
 * Compute RFC 3720 / Google Cloud Storage 4-byte big-endian Castagnoli CRC32C
 * encoded in standard RFC 4648 base64.
 */
export function computeCrc32cBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return EMPTY_CRC32C_BASE64;
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] ?? 0;
    const lookup = CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = lookup ^ (crc >>> 8);
  }
  const finalized = (crc ^ 0xffffffff) >>> 0;
  const bigEndian = Buffer.from([
    (finalized >>> 24) & 0xff,
    (finalized >>> 16) & 0xff,
    (finalized >>> 8) & 0xff,
    finalized & 0xff,
  ]);
  return bigEndian.toString('base64');
}

/** Compute RFC 4648 base64 MD5 digest of `bytes`. */
export function computeMd5Base64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return EMPTY_MD5_BASE64;
  return createHash('md5').update(bytes).digest('base64');
}

function computeStorageEtag(generation: string, metageneration: string): string {
  return Buffer.from(`${generation}:${metageneration}`, 'utf8').toString('base64');
}

function buildCustomMetadataMap(
  customMetadata: Record<string, string> | undefined,
  downloadTokens: string | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (customMetadata !== undefined) {
    for (const [key, value] of Object.entries(customMetadata)) {
      defineOwnMetadataKey(merged, key, String(value));
    }
  }
  if (typeof downloadTokens === 'string' && downloadTokens.length > 0) {
    defineOwnMetadataKey(merged, DOWNLOAD_TOKENS_METADATA_KEY, downloadTokens);
  }
  if (Object.keys(merged).length === 0) return undefined;
  return merged;
}

/**
 * Build an upstream-faithful `StorageObjectData` JSON payload from a Pyric
 * Storage snapshot. `name` is always `object.fullPath` (never basename), and
 * `size`, `generation`, and `metageneration` are decimal strings per the
 * CloudEvent JSON schema.
 */
export function buildStorageObjectData(
  object: StorageObjectSnapshot,
  bucketOverride?: string,
): Record<string, unknown> {
  const bucket = bucketOverride ?? object.bucket;
  const name = object.fullPath;
  const generation = String(object.generation);
  const metageneration = String(object.metageneration);
  const size = String(object.size);
  const storageClass = object.storageClass ?? 'STANDARD';
  let contentType = 'application/octet-stream';
  if (typeof object.contentType === 'string' && object.contentType.length > 0) {
    contentType = object.contentType;
  }
  const md5Hash = object.md5Hash ?? EMPTY_MD5_BASE64;
  const crc32c = object.crc32c ?? EMPTY_CRC32C_BASE64;
  const etag = object.etag ?? computeStorageEtag(generation, metageneration);
  const encodedBucket = encodeURIComponent(bucket);
  const encodedName = encodeURIComponent(name);
  const encodedGeneration = encodeURIComponent(generation);

  const data: Record<string, unknown> = {
    kind: 'storage#object',
    id: `${bucket}/${name}/${generation}`,
    selfLink: `https://www.googleapis.com/storage/v1/b/${encodedBucket}/o/${encodedName}`,
    mediaLink:
      `https://storage.googleapis.com/download/storage/v1/b/${encodedBucket}/o/${encodedName}` +
      `?generation=${encodedGeneration}&alt=media`,
    name,
    bucket,
    generation,
    metageneration,
    contentType,
    timeCreated: object.timeCreated,
    updated: object.updated,
    timeStorageClassUpdated: object.timeCreated,
    storageClass,
    size,
    md5Hash,
    crc32c,
    etag,
  };

  if (object.timeDeleted !== undefined) {
    data.timeDeleted = object.timeDeleted;
  }
  if (object.contentEncoding !== undefined) {
    data.contentEncoding = object.contentEncoding;
  }
  if (object.contentDisposition !== undefined) {
    data.contentDisposition = object.contentDisposition;
  }
  if (object.cacheControl !== undefined) {
    data.cacheControl = object.cacheControl;
  }
  if (object.contentLanguage !== undefined) {
    data.contentLanguage = object.contentLanguage;
  }

  const metadata = buildCustomMetadataMap(object.customMetadata, object.downloadTokens);
  if (metadata !== undefined) {
    data.metadata = metadata;
  }

  return data;
}

/** Build the complete v2 CloudEvent envelope for a Storage trigger delivery. */
export function buildStorageCloudEvent(
  object: StorageObjectSnapshot,
  options: StorageCloudEventOptions,
): Record<string, unknown> {
  const bucket = options.bucket ?? object.bucket;
  const data = buildStorageObjectData(object, bucket);
  return {
    specversion: '1.0',
    id: options.id,
    source: `//storage.googleapis.com/projects/_/buckets/${bucket}`,
    subject: `objects/${object.fullPath}`,
    type: options.eventType,
    time: options.time,
    bucket,
    location: options.location,
    data,
  };
}

/** Invoke the real `firebase-functions/v2/storage` wrapper with the encoded CloudEvent. */
export async function executeStorageTrigger(
  trigger: DiscoveredStorageTrigger,
  object: StorageObjectSnapshot,
  options: StorageCloudEventOptions,
): Promise<StorageExecutionResult> {
  const event = buildStorageCloudEvent(object, options);
  try {
    const result = await trigger.callable(event);
    return { status: 'fulfilled', event, result };
  } catch (error) {
    return { status: 'rejected', event, error };
  }
}
