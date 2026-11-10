/**
 * Shared observed Cloud Storage wire contracts, key-hygiene copy helpers, and
 * download-URL origin validation policy across `@pyric/live`, `@pyric/cli`, and
 * `@pyric/studio`.
 *
 * Pure and zero-dependency so browser bundles (`@pyric/cli/bridge/client`) and
 * the Node live host enforce identical rules without drift.
 */

export interface ObservedStorageObjectInput {
  readonly size?: number;
  readonly contentType?: string | null;
  readonly cacheControl?: string | null;
  readonly contentDisposition?: string | null;
  readonly contentEncoding?: string | null;
  readonly contentLanguage?: string | null;
  readonly md5Hash?: string;
  readonly generation?: string;
  readonly metageneration?: string;
  readonly timeCreated?: string;
  readonly updated?: string;
  readonly customMetadata?: Record<string, string> | null;
}

export interface ObservedStorageListItem {
  readonly fullPath: string;
  readonly metadata?: ObservedStorageObjectInput;
}

export type ObservedStorageSessionOp =
  | {
      readonly kind: 'upsert';
      readonly bucket: string;
      readonly fullPath: string;
      readonly metadata: ObservedStorageObjectInput;
      readonly replaceMetadata?: boolean;
    }
  | {
      readonly kind: 'list';
      readonly bucket: string;
      readonly prefix: string;
      readonly prefixes: readonly string[];
      readonly items: readonly ObservedStorageListItem[];
      readonly complete?: boolean;
      readonly recursive?: boolean;
    }
  | {
      readonly kind: 'downloadUrl';
      readonly bucket: string;
      readonly fullPath: string;
      readonly downloadUrl: string;
    }
  | {
      readonly kind: 'delete';
      readonly bucket: string;
      readonly fullPath: string;
    }
  | {
      readonly kind: 'deletePrefix';
      readonly bucket: string;
      readonly prefix: string;
    };

export interface ObservedStorageObjectMetadata {
  readonly bucket: string;
  readonly fullPath: string;
  readonly name: string;
  readonly size?: number;
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly contentLanguage?: string;
  readonly md5Hash?: string;
  readonly generation?: string;
  readonly metageneration?: string;
  readonly timeCreated?: string;
  readonly updated?: string;
  readonly customMetadata?: Record<string, string>;
  readonly downloadUrl?: string;
}

export interface ObservedStorageBucketSnapshot {
  readonly prefixes: readonly string[];
  readonly objects: Record<string, ObservedStorageObjectMetadata>;
  readonly deleted?: readonly string[];
}

export const FORBIDDEN_STORAGE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const MAX_STORAGE_CUSTOM_METADATA_KEYS = 64;
export const MAX_STORAGE_CUSTOM_METADATA_BYTES = 16 * 1024;
export const MAX_STORAGE_METADATA_STRING_CHARS = 2048;
export const MAX_STORAGE_OBJECT_PATH_CHARS = 1024;
const MAX_STORAGE_DOWNLOAD_URL_CHARS = 2048;
export const MAX_STORAGE_LIST_ENTRIES = 250;

const STORAGE_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

export function isValidStorageBucketName(bucket: string): boolean {
  if (FORBIDDEN_STORAGE_KEYS.has(bucket)) return false;
  return STORAGE_BUCKET_NAME_PATTERN.test(bucket);
}

export function selectPreferredStorageBucket(
  bucketNames: Iterable<string>,
  projectId: string,
): string | null {
  const names = [...bucketNames];
  if (names.length === 0) return null;
  if (projectId.length > 0) {
    const firebasestorage = `${projectId}.firebasestorage.app`;
    if (names.includes(firebasestorage)) return firebasestorage;
    const appspot = `${projectId}.appspot.com`;
    if (names.includes(appspot)) return appspot;
  }
  return names[0] ?? null;
}

export const STORAGE_NULLABLE_STRING_FIELDS = [
  'contentType',
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
] as const;

export const STORAGE_IMMUTABLE_STRING_FIELDS = [
  'md5Hash',
  'generation',
  'metageneration',
  'timeCreated',
  'updated',
] as const;

/**
 * Copies a `customMetadata` string map verbatim onto a fresh plain object while
 * omitting prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
 */
export function copyStorageCustomMetadataRecord(
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key)) continue;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function isFirebaseStorageSubdomain(hostname: string): boolean {
  const suffix = '.firebasestorage.app';
  const hasSuffix = hostname.endsWith(suffix) && hostname.length > suffix.length;
  if (!hasSuffix) return false;
  return !hostname.startsWith('.');
}

function isLocalLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isAllowedStorageDownloadUrlOrigin(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (isLocalLoopbackHost(hostname)) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  if (url.protocol !== 'https:' || url.port !== '') return false;
  if (hostname === 'firebasestorage.googleapis.com') return true;
  if (hostname === 'storage.googleapis.com') return true;
  return isFirebaseStorageSubdomain(hostname);
}

/**
 * Validates a Storage download URL against the Firebase/GCS/loopback origin
 * allowlist and length cap, returning the URL verbatim (including `token=`,
 * signed query parameters, and fragments).
 */
export function validateObservedStorageDownloadUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const withinBounds = trimmed.length > 0 && trimmed.length <= MAX_STORAGE_DOWNLOAD_URL_CHARS;
  if (!withinBounds) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const hasEmbeddedCredentials = parsed.username !== '' || parsed.password !== '';
  if (hasEmbeddedCredentials) return undefined;
  if (!isAllowedStorageDownloadUrlOrigin(parsed)) return undefined;

  return parsed.toString();
}
