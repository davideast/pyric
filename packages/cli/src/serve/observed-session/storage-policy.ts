/**
 * Shared observed Cloud Storage wire contracts, secret-metadata scrubbing, and
 * download-URL sanitization policy across `@pyric/live`, `@pyric/cli`, and
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

export const REDACTED_STORAGE_METADATA_VALUE = '[REDACTED]';

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

const SECRET_METADATA_SUBSTRING =
  /(?:firebase[_-]?storage[_-]?download[_-]?tokens|passphrase|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization|bearer|signature|session|cookie|jwt|oauth)/i;

const SECRET_SHORT_TOKEN_BOUNDARY =
  /(?:(?:^|[_-])(?:pass|auth|sig)(?:$|[_-]|[A-Z0-9])|[a-z](?:Pass|Auth|Sig)(?:$|[_-]|[A-Z0-9]))/;

const SECRET_AUTH_HEADER_VALUE = /^\s*(?:bearer|basic)\s+\S+/i;
const SECRET_JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'key',
  'api_key',
  'apikey',
  'x-goog-signature',
  'x-goog-credential',
  'x-goog-algorithm',
  'x-goog-date',
  'x-goog-expires',
  'x-goog-signedheaders',
  'x-goog-encryption-key',
  'x-goog-encryption-key-sha256',
  'googleaccessid',
  'signature',
  'expires',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-algorithm',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-signedheaders',
  'x-amz-security-token',
  'sig',
  'se',
  'sp',
  'sv',
  'sr',
  'st',
  'spr',
  'upload_id',
]);

const CREDENTIAL_QUERY_PATTERN =
  /(?:token|secret|signature|credential|password|passphrase|cookie|session|jwt)/i;

export function isSecretStorageMetadataKey(key: string): boolean {
  return SECRET_METADATA_SUBSTRING.test(key) || SECRET_SHORT_TOKEN_BOUNDARY.test(key);
}

export function isSecretStorageMetadataValue(value: string): boolean {
  const trimmed = value.trim();
  return SECRET_AUTH_HEADER_VALUE.test(trimmed) || SECRET_JWT_VALUE.test(trimmed);
}

export function sanitizeStorageMetadataEntry(key: string, value: string): string {
  const shouldRedact = isSecretStorageMetadataKey(key) || isSecretStorageMetadataValue(value);
  if (shouldRedact) return REDACTED_STORAGE_METADATA_VALUE;
  return value;
}

export function scrubStorageCustomMetadataRecord(
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key)) continue;
    out[key] = sanitizeStorageMetadataEntry(key, value);
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

function isStorageUrlCredentialParam(key: string): boolean {
  const lower = key.toLowerCase();
  return CREDENTIAL_QUERY_KEYS.has(lower) || CREDENTIAL_QUERY_PATTERN.test(lower);
}

/**
 * Validates a Storage download URL against the Firebase/GCS origin allowlist
 * and strips all query credentials (`token=`, `access_token=`, signed-URL
 * parameters, SAS parameters, and URL fragments) before retention.
 */
export function sanitizeObservedStorageDownloadUrl(raw: unknown): string | undefined {
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

  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (isStorageUrlCredentialParam(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}
