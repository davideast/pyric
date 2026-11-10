/**
 * Validates and bounds `ObservedSessionDelta.storage` entries arriving over
 * `/__pyric/live/observe` (`delta-validation.ts` owns Firestore and RTDB).
 *
 * Enforces strict per-op key allowlists, path hygiene, prototype-safe
 * `customMetadata` copying (`storage-policy.ts`), and Firebase/GCS download URL
 * origin allowlisting before anything enters `ObservedStorageCatalog`.
 */
import { FORBIDDEN_KEYS, byteLengthOf, isPlainObject } from './json-values.js';
import {
  MAX_STORAGE_CUSTOM_METADATA_BYTES,
  MAX_STORAGE_CUSTOM_METADATA_KEYS,
  MAX_STORAGE_LIST_ENTRIES,
  MAX_STORAGE_METADATA_STRING_CHARS,
  MAX_STORAGE_OBJECT_PATH_CHARS,
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
  copyStorageCustomMetadataRecord,
  isValidStorageBucketName,
  validateObservedStorageDownloadUrl,
  type ObservedStorageListItem,
  type ObservedStorageObjectInput,
  type ObservedStorageSessionOp,
} from './storage-policy.js';
import { UNREAD_BUCKET } from './wire.js';

const MAX_STORAGE_OBJECT_BYTES = 256 * 1024;

const KNOWN_METADATA_KEYS = new Set<string>([
  'size',
  ...STORAGE_NULLABLE_STRING_FIELDS,
  ...STORAGE_IMMUTABLE_STRING_FIELDS,
  'customMetadata',
]);

const UPSERT_OP_KEYS = new Set(['kind', 'bucket', 'fullPath', 'metadata', 'replaceMetadata']);
const LIST_OP_KEYS = new Set(['kind', 'bucket', 'prefix', 'prefixes', 'items', 'complete', 'recursive']);
const DOWNLOAD_URL_OP_KEYS = new Set(['kind', 'bucket', 'fullPath', 'downloadUrl']);
const DELETE_OP_KEYS = new Set(['kind', 'bucket', 'fullPath']);
const DELETE_PREFIX_OP_KEYS = new Set(['kind', 'bucket', 'prefix']);

type StorageValidationFailureReason = 'oversized' | 'unsupported';

class StorageDeltaValidationError extends Error {
  readonly reason: StorageValidationFailureReason;
  constructor(reason: StorageValidationFailureReason, message: string) {
    super(message);
    this.name = 'StorageDeltaValidationError';
    this.reason = reason;
  }
}

function unsupported(message: string): StorageDeltaValidationError {
  return new StorageDeltaValidationError('unsupported', message);
}

function oversized(message: string): StorageDeltaValidationError {
  return new StorageDeltaValidationError('oversized', message);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBoundedMetadataString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STORAGE_METADATA_STRING_CHARS;
}

function assertOptionalBoolean(value: unknown, label: string): void {
  const valid = value === undefined || typeof value === 'boolean';
  if (!valid) {
    throw unsupported(`Invalid ${label}: expected boolean when provided.`);
  }
}

function assertAllowedKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw unsupported(`Invalid ${label}.${key}: unexpected field.`);
    }
  }
}

function readStorageBucket(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw unsupported(`Invalid ${label}: expected string bucket name.`);
  }
  if (raw === UNREAD_BUCKET) return raw;
  const cleaned = raw.trim();
  if (!isValidStorageBucketName(cleaned)) {
    throw unsupported(`Invalid ${label}: malformed Storage bucket '${raw}'.`);
  }
  return cleaned;
}

function normalizeSlashTrimmed(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw unsupported(`Invalid ${label}: expected string path.`);
  }
  if (raw.length > MAX_STORAGE_OBJECT_PATH_CHARS) {
    throw oversized(`Invalid ${label}: Storage path exceeds ${MAX_STORAGE_OBJECT_PATH_CHARS} chars.`);
  }
  const hasControlChars = raw.includes('\u0000') || raw.includes('\r') || raw.includes('\n');
  if (hasControlChars) {
    throw unsupported(`Invalid ${label}: Storage path contains control characters.`);
  }
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

function assertValidSegments(trimmed: string, label: string): void {
  const segments = trimmed.split('/');
  for (const seg of segments) {
    const isInvalidSegment =
      seg.length === 0 || seg === '.' || seg === '..' || FORBIDDEN_KEYS.has(seg);
    if (isInvalidSegment) {
      throw unsupported(`Invalid ${label}: Storage path contains invalid segment '${seg}'.`);
    }
  }
}

export function readStorageObjectPath(raw: unknown, label: string): string {
  const trimmed = normalizeSlashTrimmed(raw, label);
  if (trimmed.length === 0) {
    throw unsupported(`Invalid ${label}: expected non-empty Storage object path.`);
  }
  assertValidSegments(trimmed, label);
  return trimmed;
}

export function readStoragePrefix(raw: unknown, label: string): string {
  const trimmed = normalizeSlashTrimmed(raw, label);
  if (trimmed.length === 0) return '';
  assertValidSegments(trimmed, label);
  return trimmed;
}

function readCustomMetadataField(
  raw: unknown,
  label: string,
): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isPlainObject(raw)) {
    throw unsupported(`Invalid ${label}: expected plain string map.`);
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_STORAGE_CUSTOM_METADATA_KEYS) {
    throw oversized(
      `Invalid ${label}: more than ${MAX_STORAGE_CUSTOM_METADATA_KEYS} customMetadata keys.`,
    );
  }
  const plain: Record<string, string> = {};
  for (const [key, value] of entries) {
    const validKey = key.length > 0 && key.length <= 256 && !FORBIDDEN_KEYS.has(key);
    if (!validKey) {
      throw unsupported(`Invalid ${label}: invalid customMetadata key '${key}'.`);
    }
    if (!isBoundedMetadataString(value)) {
      throw unsupported(`Invalid ${label}.${key}: expected bounded string.`);
    }
    Object.defineProperty(plain, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (byteLengthOf(plain) > MAX_STORAGE_CUSTOM_METADATA_BYTES) {
    throw oversized(
      `Invalid ${label}: customMetadata exceeds ${MAX_STORAGE_CUSTOM_METADATA_BYTES} bytes.`,
    );
  }
  return copyStorageCustomMetadataRecord(plain);
}

function readObjectMetadataInput(raw: unknown, label: string): ObservedStorageObjectInput {
  if (!isPlainObject(raw)) {
    throw unsupported(`Invalid ${label}: expected metadata object.`);
  }
  assertAllowedKeys(raw, KNOWN_METADATA_KEYS, label);
  const out: {
    size?: number;
    contentType?: string | null;
    cacheControl?: string | null;
    contentDisposition?: string | null;
    contentEncoding?: string | null;
    contentLanguage?: string | null;
    md5Hash?: string;
    generation?: string;
    metageneration?: string;
    timeCreated?: string;
    updated?: string;
    customMetadata?: Record<string, string> | null;
  } = {};

  if (raw.size !== undefined) {
    if (!isNonNegativeNumber(raw.size)) {
      throw unsupported(`Invalid ${label}.size: expected non-negative number.`);
    }
    out.size = Math.floor(raw.size);
  }
  for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
    const val = raw[field];
    if (val === undefined) continue;
    if (val === null) {
      out[field] = null;
      continue;
    }
    if (!isBoundedMetadataString(val)) {
      throw unsupported(`Invalid ${label}.${field}: expected string or null.`);
    }
    out[field] = val;
  }
  for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
    const val = raw[field];
    if (val === undefined) continue;
    if (!isBoundedMetadataString(val)) {
      throw unsupported(`Invalid ${label}.${field}: expected string.`);
    }
    out[field] = val;
  }
  const custom = readCustomMetadataField(raw.customMetadata, `${label}.customMetadata`);
  if (custom !== undefined) out.customMetadata = custom;
  return out;
}

function readListItem(raw: unknown, label: string): ObservedStorageListItem {
  if (!isPlainObject(raw)) {
    throw unsupported(`Invalid ${label}: expected list item object.`);
  }
  for (const key of Object.keys(raw)) {
    const known = key === 'fullPath' || key === 'metadata';
    if (!known) throw unsupported(`Invalid ${label}.${key}: unexpected field.`);
  }
  const fullPath = readStorageObjectPath(raw.fullPath, `${label}.fullPath`);
  const item: { fullPath: string; metadata?: ObservedStorageObjectInput } = { fullPath };
  if (raw.metadata !== undefined) {
    item.metadata = readObjectMetadataInput(raw.metadata, `${label}.metadata`);
  }
  return item;
}

function readStorageListOp(
  raw: Record<string, unknown>,
  label: string,
  bucket: string,
): ObservedStorageSessionOp {
  assertAllowedKeys(raw, LIST_OP_KEYS, label);
  const prefix = readStoragePrefix(raw.prefix, `${label}.prefix`);
  if (!Array.isArray(raw.prefixes) || !Array.isArray(raw.items)) {
    throw unsupported(`Invalid ${label}: expected prefixes and items arrays.`);
  }
  const rawPrefixes = raw.prefixes;
  const rawItems = raw.items;
  if (rawPrefixes.length + rawItems.length > MAX_STORAGE_LIST_ENTRIES) {
    throw oversized(
      `Invalid ${label}: list exceeds ${MAX_STORAGE_LIST_ENTRIES} combined prefixes and items.`,
    );
  }
  assertOptionalBoolean(raw.complete, `${label}.complete`);
  assertOptionalBoolean(raw.recursive, `${label}.recursive`);
  const prefixes = rawPrefixes.map((entry, idx) =>
    readStorageObjectPath(entry, `${label}.prefixes[${idx}]`),
  );
  const items = rawItems.map((entry, idx) => readListItem(entry, `${label}.items[${idx}]`));
  const op: {
    kind: 'list';
    bucket: string;
    prefix: string;
    prefixes: string[];
    items: ObservedStorageListItem[];
    complete?: boolean;
    recursive?: boolean;
  } = { kind: 'list', bucket, prefix, prefixes, items };
  if (raw.complete === true) op.complete = true;
  if (raw.recursive === true) op.recursive = true;
  return op;
}

export function readStorageOp(raw: unknown, index: number): ObservedStorageSessionOp {
  const label = `sessionData.storage[${index}]`;
  if (!isPlainObject(raw)) {
    throw unsupported(`Invalid ${label}: expected object.`);
  }
  if (byteLengthOf(raw) > MAX_STORAGE_OBJECT_BYTES) {
    throw oversized(`Invalid ${label}: exceeds ${MAX_STORAGE_OBJECT_BYTES} bytes.`);
  }
  const bucket = readStorageBucket(raw.bucket, `${label}.bucket`);
  switch (raw.kind) {
    case 'upsert': {
      assertAllowedKeys(raw, UPSERT_OP_KEYS, label);
      const fullPath = readStorageObjectPath(raw.fullPath, `${label}.fullPath`);
      const metadata = readObjectMetadataInput(raw.metadata, `${label}.metadata`);
      assertOptionalBoolean(raw.replaceMetadata, `${label}.replaceMetadata`);
      const op: {
        kind: 'upsert';
        bucket: string;
        fullPath: string;
        metadata: ObservedStorageObjectInput;
        replaceMetadata?: boolean;
      } = { kind: 'upsert', bucket, fullPath, metadata };
      if (raw.replaceMetadata === true) op.replaceMetadata = true;
      return op;
    }
    case 'list':
      return readStorageListOp(raw, label, bucket);
    case 'downloadUrl': {
      assertAllowedKeys(raw, DOWNLOAD_URL_OP_KEYS, label);
      const fullPath = readStorageObjectPath(raw.fullPath, `${label}.fullPath`);
      const downloadUrl = validateObservedStorageDownloadUrl(raw.downloadUrl);
      if (downloadUrl === undefined) {
        throw unsupported(
          `Invalid ${label}.downloadUrl: expected allowlisted Firebase/GCS download URL.`,
        );
      }
      return { kind: 'downloadUrl', bucket, fullPath, downloadUrl };
    }
    case 'delete':
      assertAllowedKeys(raw, DELETE_OP_KEYS, label);
      return {
        kind: 'delete',
        bucket,
        fullPath: readStorageObjectPath(raw.fullPath, `${label}.fullPath`),
      };
    case 'deletePrefix':
      assertAllowedKeys(raw, DELETE_PREFIX_OP_KEYS, label);
      return {
        kind: 'deletePrefix',
        bucket,
        prefix: readStoragePrefix(raw.prefix, `${label}.prefix`),
      };
    default:
      throw unsupported(
        `Invalid ${label}.kind: expected 'upsert', 'list', 'downloadUrl', 'delete', or 'deletePrefix'.`,
      );
  }
}
