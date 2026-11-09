/**
 * Metadata-only session data extraction for client `firebase/storage` calls.
 *
 * Privacy and memory invariants (`#2542`):
 *   - Never reads, copies, decodes, or retains raw uploaded or downloaded byte
 *     buffers (`Blob`, `ArrayBuffer`, `Uint8Array`, base64 strings, or streams).
 *   - Scrubs secret-named `customMetadata` keys and secret-shaped values to
 *     `'[REDACTED]'` via `@pyric/cli/bridge/client` (`storage-policy.ts`).
 *   - Allowlists Firebase/GCS Storage download URL origins and strips all query
 *     credentials (`token=`, `access_token=`, signed-URL params, SAS params).
 *   - Bounds `list` / `listAll` discovery deltas to `<= 250` combined entries.
 */
import {
  FORBIDDEN_STORAGE_KEYS,
  MAX_STORAGE_CUSTOM_METADATA_BYTES,
  MAX_STORAGE_CUSTOM_METADATA_KEYS,
  MAX_STORAGE_LIST_ENTRIES,
  MAX_STORAGE_METADATA_STRING_CHARS,
  MAX_STORAGE_OBJECT_PATH_CHARS,
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
  isValidStorageBucketName,
  sanitizeObservedStorageDownloadUrl,
  sanitizeStorageMetadataEntry,
} from '@pyric/cli/bridge/client';
import type { ObservedSite } from './observe.js';
import {
  sessionDeltaOf,
  skipCountsOf,
  skipDeltaOf,
  type ObservedSessionDelta,
  type ObservedStorageListItem,
  type ObservedStorageObjectInput,
  type ObservedStorageSessionOp,
} from './session-data.js';
import { UNREAD_BUCKET } from './storage.js';

const UPLOAD_METHODS = new Set(['uploadBytes', 'uploadBytesResumable', 'uploadString']);
const LIST_REQUEST_HAS_PAGE_TOKEN = Symbol('pyric.storage.listRequestHasPageToken');

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return text.length;
}

export function normalizeStorageBucket(raw: unknown): string {
  if (typeof raw !== 'string') return UNREAD_BUCKET;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return UNREAD_BUCKET;
  if (trimmed === UNREAD_BUCKET) return UNREAD_BUCKET;
  let cleaned = trimmed;
  if (cleaned.startsWith('gs://')) {
    cleaned = cleaned.slice(5);
    const slash = cleaned.indexOf('/');
    if (slash !== -1) cleaned = cleaned.slice(0, slash);
  }
  const lowered = cleaned.toLowerCase();
  if (!isValidStorageBucketName(lowered)) return UNREAD_BUCKET;
  return lowered;
}

function trimSlashes(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length > MAX_STORAGE_OBJECT_PATH_CHARS) return undefined;
  const hasControl = raw.includes('\u0000') || raw.includes('\r') || raw.includes('\n');
  if (hasControl) return undefined;
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasValidSegments(trimmed: string): boolean {
  for (const seg of trimmed.split('/')) {
    const invalid = seg.length === 0 || seg === '.' || seg === '..' || FORBIDDEN_STORAGE_KEYS.has(seg);
    if (invalid) return false;
  }
  return true;
}

export function normalizeStorageObjectPath(raw: unknown): string | undefined {
  const trimmed = trimSlashes(raw);
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (!hasValidSegments(trimmed)) return undefined;
  return trimmed;
}

export function normalizeStoragePrefix(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return '';
  const trimmed = trimSlashes(raw);
  if (trimmed === undefined) return undefined;
  if (trimmed.length === 0) return '';
  if (!hasValidSegments(trimmed)) return undefined;
  return trimmed;
}

export function scrubStorageCustomMetadata(
  raw: unknown,
): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  let totalBytes = 2;
  for (const [key, val] of Object.entries(raw)) {
    if (count >= MAX_STORAGE_CUSTOM_METADATA_KEYS) break;
    const validEntry =
      key.length > 0 &&
      key.length <= 256 &&
      !FORBIDDEN_STORAGE_KEYS.has(key) &&
      typeof val === 'string' &&
      val.length <= MAX_STORAGE_METADATA_STRING_CHARS;
    if (!validEntry) continue;
    const scrubbedVal = sanitizeStorageMetadataEntry(key, val);
    const entryBytes = utf8Bytes(key) + utf8Bytes(scrubbedVal) + 6;
    if (totalBytes + entryBytes > MAX_STORAGE_CUSTOM_METADATA_BYTES) break;
    out[key] = scrubbedVal;
    totalBytes += entryBytes;
    count += 1;
  }
  return out;
}

export function sanitizeStorageDownloadUrl(raw: unknown): string | undefined {
  return sanitizeObservedStorageDownloadUrl(raw);
}

function asRecord(value: unknown): Fields | undefined {
  if (isRecord(value)) return value;
  return undefined;
}

function asUnknownArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

export type MutableStorageObjectInput = {
  -readonly [K in keyof ObservedStorageObjectInput]: ObservedStorageObjectInput[K];
};

export function extractBaseStorageMetadataFields(raw: Fields): MutableStorageObjectInput {
  const out: MutableStorageObjectInput = {};

  if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0) {
    out.size = Math.floor(raw.size);
  } else if (typeof raw.size === 'string' && /^\d+$/.test(raw.size)) {
    const parsedSize = Number(raw.size);
    if (Number.isSafeInteger(parsedSize)) out.size = parsedSize;
  }

  for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
    const val = raw[field];
    if (val === null) {
      out[field] = null;
    } else if (typeof val === 'string' && val.length <= MAX_STORAGE_METADATA_STRING_CHARS) {
      out[field] = val;
    }
  }

  for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
    const val = raw[field];
    if (typeof val === 'string' && val.length <= MAX_STORAGE_METADATA_STRING_CHARS) {
      out[field] = val;
    }
  }

  return out;
}

function extractClientMetadataInput(raw: unknown): ObservedStorageObjectInput | undefined {
  if (!isRecord(raw)) return undefined;
  const out = extractBaseStorageMetadataFields(raw);

  if ('customMetadata' in raw) {
    const custom = scrubStorageCustomMetadata(raw.customMetadata);
    if (custom !== undefined) out.customMetadata = custom;
  }

  return out;
}

function hasFullMetadataResource(raw: Fields): boolean {
  return (
    typeof raw.generation === 'string' ||
    typeof raw.timeCreated === 'string' ||
    typeof raw.size === 'number'
  );
}

function selectResultBucketSource(
  metaRecord: Fields | undefined,
  refRecord: Fields | undefined,
  site: ObservedSite,
): unknown {
  if (typeof metaRecord?.bucket === 'string' && metaRecord.bucket.length > 0) {
    return metaRecord.bucket;
  }
  if (typeof refRecord?.bucket === 'string' && refRecord.bucket.length > 0) {
    return refRecord.bucket;
  }
  return site.bucket;
}

function selectResultObjectPathSource(
  metaRecord: Fields | undefined,
  refRecord: Fields | undefined,
  site: ObservedSite,
): unknown {
  if (typeof metaRecord?.fullPath === 'string' && metaRecord.fullPath.length > 0) {
    return metaRecord.fullPath;
  }
  if (typeof refRecord?.fullPath === 'string' && refRecord.fullPath.length > 0) {
    return refRecord.fullPath;
  }
  return site.path;
}

function resolveResultBucketAndPath(
  site: ObservedSite,
  metaRecord: Fields | undefined,
  refRecord: Fields | undefined,
): { bucket: string; fullPath: string } | undefined {
  const rawBucket = selectResultBucketSource(metaRecord, refRecord, site);
  const rawPath = selectResultObjectPathSource(metaRecord, refRecord, site);
  const fullPath = normalizeStorageObjectPath(rawPath);
  if (fullPath === undefined) return undefined;
  return { bucket: normalizeStorageBucket(rawBucket), fullPath };
}

export function buildStorageUpsertOp(
  bucket: string,
  fullPath: string,
  metadata: ObservedStorageObjectInput,
  replaceMetadata: boolean,
): ObservedStorageSessionOp {
  const op: {
    kind: 'upsert';
    bucket: string;
    fullPath: string;
    metadata: ObservedStorageObjectInput;
    replaceMetadata?: boolean;
  } = { kind: 'upsert', bucket, fullPath, metadata };
  if (replaceMetadata) op.replaceMetadata = true;
  return op;
}

function selectUploadMetadata(
  metaRecord: Fields | undefined,
  writeData: unknown,
): ObservedStorageObjectInput {
  const fromResponse = extractClientMetadataInput(metaRecord);
  if (fromResponse !== undefined) return fromResponse;
  const fromWriteData = extractClientMetadataInput(writeData);
  if (fromWriteData !== undefined) return fromWriteData;
  return {};
}

function captureUploadResult(site: ObservedSite, result: unknown): ObservedSessionDelta | undefined {
  const resultRecord = asRecord(result);
  const metaRecord = asRecord(resultRecord?.metadata);
  const refRecord = asRecord(resultRecord?.ref);
  const target = resolveResultBucketAndPath(site, metaRecord, refRecord);
  if (target === undefined) return undefined;

  const metadata = selectUploadMetadata(metaRecord, site.writeData);
  const replaceMetadata = metaRecord !== undefined && hasFullMetadataResource(metaRecord);
  return sessionDeltaOf({
    storage: [buildStorageUpsertOp(target.bucket, target.fullPath, metadata, replaceMetadata)],
  });
}

function captureFullMetadataResult(
  site: ObservedSite,
  result: unknown,
  allowWriteFallback: boolean,
): ObservedSessionDelta | undefined {
  const metaRecord = asRecord(result);
  const target = resolveResultBucketAndPath(site, metaRecord, undefined);
  if (target === undefined) return undefined;

  let metadata = extractClientMetadataInput(metaRecord);
  if (metadata === undefined && allowWriteFallback) {
    metadata = extractClientMetadataInput(site.writeData);
  }
  if (metadata === undefined) return undefined;

  const replaceMetadata = metaRecord !== undefined && hasFullMetadataResource(metaRecord);
  return sessionDeltaOf({
    storage: [buildStorageUpsertOp(target.bucket, target.fullPath, metadata, replaceMetadata)],
  });
}

function captureListResult(site: ObservedSite, result: unknown): ObservedSessionDelta | undefined {
  if (!isRecord(result)) return undefined;
  const prefix = normalizeStoragePrefix(site.path);
  if (prefix === undefined) return skipDeltaOf('unsupported');

  const rawPrefixes = asUnknownArray(result.prefixes);
  const rawItems = asUnknownArray(result.items);
  const validPrefixes: string[] = [];
  let inferredBucket: string | undefined;

  for (const entry of rawPrefixes) {
    if (!isRecord(entry)) continue;
    if (inferredBucket === undefined && typeof entry.bucket === 'string') {
      inferredBucket = entry.bucket;
    }
    const childPrefix = normalizeStorageObjectPath(entry.fullPath);
    if (childPrefix !== undefined) validPrefixes.push(childPrefix);
  }

  const validItems: ObservedStorageListItem[] = [];
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue;
    if (inferredBucket === undefined && typeof entry.bucket === 'string') {
      inferredBucket = entry.bucket;
    }
    const itemPath = normalizeStorageObjectPath(entry.fullPath);
    if (itemPath !== undefined) validItems.push({ fullPath: itemPath });
  }

  const totalEntries = validPrefixes.length + validItems.length;
  const keptPrefixes = validPrefixes.slice(0, MAX_STORAGE_LIST_ENTRIES);
  const remainingSlots = Math.max(0, MAX_STORAGE_LIST_ENTRIES - keptPrefixes.length);
  const keptItems = validItems.slice(0, remainingSlots);
  const truncatedCount = Math.max(0, totalEntries - (keptPrefixes.length + keptItems.length));

  let bucketSource = site.bucket;
  if (bucketSource === UNREAD_BUCKET && inferredBucket !== undefined) {
    bucketSource = inferredBucket;
  }
  const bucket = normalizeStorageBucket(bucketSource);
  const hasNextPageToken =
    typeof result.nextPageToken === 'string' && result.nextPageToken.length > 0;
  const isSinglePageClientList =
    site.name === 'list' && !listRequestHadPageToken(site) && !hasNextPageToken;
  const isCompletePage = site.name === 'listAll' || isSinglePageClientList;
  const isUnpaginatedComplete = isCompletePage && truncatedCount === 0;
  const listOp: {
    kind: 'list';
    bucket: string;
    prefix: string;
    prefixes: string[];
    items: ObservedStorageListItem[];
    complete?: boolean;
  } = { kind: 'list', bucket, prefix, prefixes: keptPrefixes, items: keptItems };
  if (isUnpaginatedComplete) listOp.complete = true;

  return sessionDeltaOf({
    storage: [listOp],
    skipped: skipCountsOf(0, 0, truncatedCount),
  });
}

function captureDownloadUrlResult(site: ObservedSite, result: unknown): ObservedSessionDelta | undefined {
  const fullPath = normalizeStorageObjectPath(site.path);
  if (fullPath === undefined) return undefined;
  const downloadUrl = sanitizeStorageDownloadUrl(result);
  if (downloadUrl === undefined) return skipDeltaOf('unsupported');
  const bucket = normalizeStorageBucket(site.bucket);
  return sessionDeltaOf({
    storage: [{ kind: 'downloadUrl', bucket, fullPath, downloadUrl }],
  });
}

function listRequestHadPageToken(site: ObservedSite): boolean {
  return Reflect.get(site, LIST_REQUEST_HAS_PAGE_TOKEN) === true;
}

/** Records whether a client `list(ref, options)` request supplied a pagination `pageToken`. */
export function attachStorageCallHint(
  context: Record<PropertyKey, unknown>,
  name: string,
  args: readonly unknown[],
): void {
  if (name !== 'list') return;
  const options = args[1];
  if (!isRecord(options)) return;
  const pageToken = options.pageToken;
  if (pageToken !== undefined && pageToken !== null && pageToken !== '') {
    context[LIST_REQUEST_HAS_PAGE_TOKEN] = true;
  }
}

/** Session delta known from arguments before resolution (`deleteObject`). */
export function storageSessionContext(
  name: string,
  bucket: string,
  path: string | undefined,
): ObservedSessionDelta | undefined {
  if (name !== 'deleteObject') return undefined;
  const fullPath = normalizeStorageObjectPath(path);
  if (fullPath === undefined) return undefined;
  return sessionDeltaOf({
    storage: [{ kind: 'delete', bucket: normalizeStorageBucket(bucket), fullPath }],
  });
}

/** Session delta extracted from a resolved client `firebase/storage` result. */
export function storageSessionResult(
  site: ObservedSite,
  result: unknown,
): ObservedSessionDelta | undefined {
  if (UPLOAD_METHODS.has(site.name)) return captureUploadResult(site, result);
  if (site.name === 'getMetadata') return captureFullMetadataResult(site, result, false);
  if (site.name === 'updateMetadata') return captureFullMetadataResult(site, result, true);
  if (site.name === 'list' || site.name === 'listAll') return captureListResult(site, result);
  if (site.name === 'getDownloadURL') return captureDownloadUrlResult(site, result);
  return undefined;
}
