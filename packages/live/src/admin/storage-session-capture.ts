/**
 * Metadata-only session data extraction for Admin `@google-cloud/storage`
 * calls (`firebase-admin/storage`).
 *
 * Privacy and memory invariants (`#2542`, ADR 0024):
 *   - Never retains raw `Buffer` / `Uint8Array` / string upload payloads,
 *     local `Bucket.upload` file contents, `File.download` bytes, or
 *     `getSignedUrl` URLs — not even transiently across call lifetimes.
 *   - Extracts numeric byte lengths and metadata options eagerly at call start
 *     (`adminStorageSessionContext`), cleans up correlation entries on both
 *     resolution and rejection, and never touches `site.subject`.
 *   - Copies custom metadata (`metadata.metadata` / `resource.metadata`)
 *     verbatim while enforcing shared key/byte limits and `__proto__` safety.
 *   - Marks `Bucket.getFiles` listings `complete: true` only when unpaginated
 *     and unfiltered (`matchGlob`, `startOffset`, `endOffset`, `versions`,
 *     `softDeleted`), setting `recursive: true` when no `delimiter` applies.
 */
import {
  MAX_STORAGE_LIST_ENTRIES,
  MAX_STORAGE_METADATA_STRING_CHARS,
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
} from '@pyric/cli/bridge/client';
import type { ObservedSite, RejectionReading, ResultReading } from '../observe.js';
import {
  sessionDeltaOf,
  skipCountsOf,
  skipDeltaOf,
  type ObservedSessionDelta,
  type ObservedStorageListItem,
  type ObservedStorageObjectInput,
  type ObservedStorageSessionOp,
} from '../session-data.js';
import {
  buildStorageUpsertOp,
  copyStorageCustomMetadata,
  extractBaseStorageMetadataFields,
  normalizeStorageBucket,
  normalizeStorageObjectPath,
  normalizeStoragePrefix,
  type MutableStorageObjectInput,
} from '../storage-session-capture.js';

interface CopyTargetHint {
  readonly bucket?: string;
  readonly path?: string;
}

interface GetFilesQueryHint {
  readonly hasInvalidQueryShape: boolean;
  readonly prefix: string | undefined;
  readonly isUnfilteredCompleteCandidate: boolean;
  readonly recursive: boolean;
}

interface PendingAdminStorageCall {
  readonly methodName: string;
  readonly bucket: string | undefined;
  readonly path: string | undefined;
  readonly fileRef: unknown;
  readonly saveByteLength: number | undefined;
  readonly saveOptionsMeta: ObservedStorageObjectInput | undefined;
  readonly copyTargetHint: CopyTargetHint | undefined;
  readonly getFilesQueryHint: GetFilesQueryHint | undefined;
}

const PENDING_ADMIN_CALLS = new WeakMap<ObservedSessionDelta, PendingAdminStorageCall>();

function isObjectOrFn(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propOf(target: unknown, key: string): unknown {
  if (!isObjectOrFn(target)) return undefined;
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

function stringProp(target: unknown, key: string): string | undefined {
  const val = propOf(target, key);
  if (typeof val === 'string') return val;
  return undefined;
}

function firstNonEmptyString(candidates: readonly (string | undefined)[]): string | undefined {
  for (const item of candidates) {
    if (item !== undefined && item.length > 0) return item;
  }
  return undefined;
}

export function numericByteLengthOf(data: unknown): number | undefined {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(value)) return value;
  return undefined;
}

function tupleItem(value: unknown, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  return undefined;
}

function asUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function extractGcsObjectMetadata(raw: unknown): ObservedStorageObjectInput | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out = extractBaseStorageMetadataFields(raw);

  let rawCustom: unknown;
  let hasCustom = false;
  if ('metadata' in raw && (raw.metadata === null || isPlainRecord(raw.metadata))) {
    rawCustom = raw.metadata;
    hasCustom = true;
  } else if (
    'customMetadata' in raw &&
    (raw.customMetadata === null || isPlainRecord(raw.customMetadata))
  ) {
    rawCustom = raw.customMetadata;
    hasCustom = true;
  }
  if (hasCustom) {
    const copied = copyStorageCustomMetadata(rawCustom);
    if (copied !== undefined) out.customMetadata = copied;
  }
  return out;
}

export function extractAdminWriteOptionsMetadata(
  optionsArg: unknown,
): ObservedStorageObjectInput | undefined {
  if (!isPlainRecord(optionsArg)) return undefined;
  const out: MutableStorageObjectInput = {};

  if (isPlainRecord(optionsArg.metadata)) {
    const nested = extractGcsObjectMetadata(optionsArg.metadata);
    if (nested !== undefined) {
      for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
        if (nested[field] !== undefined) out[field] = nested[field];
      }
      if (nested.customMetadata !== undefined) out.customMetadata = nested.customMetadata;
    }
  }
  if (
    typeof optionsArg.contentType === 'string' &&
    optionsArg.contentType.length <= MAX_STORAGE_METADATA_STRING_CHARS
  ) {
    out.contentType = optionsArg.contentType;
  }
  if (optionsArg.gzip === true && out.contentEncoding === undefined) {
    out.contentEncoding = 'gzip';
  }
  return out;
}

function mergeInputFields(
  primary: ObservedStorageObjectInput | undefined,
  fallback: ObservedStorageObjectInput | undefined,
): ObservedStorageObjectInput {
  const merged: MutableStorageObjectInput = {};
  const applyFrom = (src: ObservedStorageObjectInput | undefined): void => {
    if (src === undefined) return;
    if (src.size !== undefined) merged.size = src.size;
    for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
      if (src[field] !== undefined) merged[field] = src[field];
    }
    for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
      if (src[field] !== undefined) merged[field] = src[field];
    }
    if (src.customMetadata !== undefined) merged.customMetadata = src.customMetadata;
  };
  applyFrom(fallback);
  applyFrom(primary);
  return merged;
}

function hasFullGcsResource(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.generation === 'string' ||
    typeof raw.timeCreated === 'string' ||
    raw.size !== undefined
  );
}

export function captureAdminWriteStreamDelta(
  bucket: string | undefined,
  path: string | undefined,
  fileRef: unknown,
  writtenBytes: number | undefined,
  optionsMeta: ObservedStorageObjectInput | undefined,
): ObservedSessionDelta | undefined {
  const fullPath = normalizeStorageObjectPath(path);
  if (fullPath === undefined) return undefined;
  const selfMetaRaw = propOf(fileRef, 'metadata');
  const fromSelf = extractGcsObjectMetadata(selfMetaRaw);
  const fallbackBase: MutableStorageObjectInput = {};
  if (writtenBytes !== undefined) fallbackBase.size = writtenBytes;
  const fallback = mergeInputFields(optionsMeta, fallbackBase);
  const metadata = mergeInputFields(fromSelf, fallback);
  const replaceMetadata = isPlainRecord(selfMetaRaw) && hasFullGcsResource(selfMetaRaw);
  return sessionDeltaOf({
    storage: [
      buildStorageUpsertOp(normalizeStorageBucket(bucket), fullPath, metadata, replaceMetadata),
    ],
  });
}

function selectMetadataTupleSource(value: unknown, fileRef: unknown): unknown {
  if (Array.isArray(value) && isPlainRecord(value[0])) return value[0];
  if (isPlainRecord(value)) return value;
  return propOf(fileRef, 'metadata');
}

function captureMetadataTuple(
  pending: PendingAdminStorageCall,
  value: unknown,
): ObservedSessionDelta | undefined {
  const metaSource = selectMetadataTupleSource(value, pending.fileRef);
  const rawBucket = firstNonEmptyString([stringProp(metaSource, 'bucket'), pending.bucket]);
  const rawPath = firstNonEmptyString([stringProp(metaSource, 'name'), pending.path]);
  const fullPath = normalizeStorageObjectPath(rawPath);
  if (fullPath === undefined) return undefined;

  const metadata = extractGcsObjectMetadata(metaSource);
  if (metadata === undefined) return undefined;
  const replaceMetadata = isPlainRecord(metaSource) && hasFullGcsResource(metaSource);
  return sessionDeltaOf({
    storage: [
      buildStorageUpsertOp(normalizeStorageBucket(rawBucket), fullPath, metadata, replaceMetadata),
    ],
  });
}

function extractCopyTargetHint(
  destArg: unknown,
  srcBucket: string | undefined,
  srcPath: string | undefined,
): CopyTargetHint {
  if (typeof destArg === 'string') {
    const hint: { bucket?: string; path: string } = { path: destArg };
    if (srcBucket !== undefined) hint.bucket = srcBucket;
    return hint;
  }
  if (!isObjectOrFn(destArg)) return {};
  const destOwnerBucket = propOf(destArg, 'bucket');
  if (isObjectOrFn(destOwnerBucket)) {
    const out: { bucket?: string; path?: string } = {};
    const bucketName = stringProp(destOwnerBucket, 'name');
    const fileName = stringProp(destArg, 'name');
    if (bucketName !== undefined) out.bucket = bucketName;
    if (fileName !== undefined) out.path = fileName;
    return out;
  }
  const out: { bucket?: string; path?: string } = {};
  const bucketName = stringProp(destArg, 'name');
  if (bucketName !== undefined) out.bucket = bucketName;
  if (srcPath !== undefined) out.path = srcPath;
  return out;
}

function selectCopyResourceMetadata(apiResp: unknown, destFile: unknown): unknown {
  const nestedResource = propOf(apiResp, 'resource');
  if (isPlainRecord(nestedResource)) return nestedResource;
  if (isPlainRecord(apiResp)) return apiResp;
  return propOf(destFile, 'metadata');
}

function isRelocatedStorageObject(
  srcBucket: string,
  srcPath: string | undefined,
  destBucket: string,
  destPath: string,
): srcPath is string {
  if (srcPath === undefined) return false;
  return srcBucket !== destBucket || srcPath !== destPath;
}

function captureCopyOrMove(
  pending: PendingAdminStorageCall,
  value: unknown,
  removeSource: boolean,
): ObservedSessionDelta | undefined {
  const destFile = tupleItem(value, 0);
  const apiResp = tupleItem(value, 1);
  const resourceCandidate = selectCopyResourceMetadata(apiResp, destFile);
  const rawBucket = firstNonEmptyString([
    stringProp(resourceCandidate, 'bucket'),
    stringProp(propOf(destFile, 'bucket'), 'name'),
    pending.copyTargetHint?.bucket,
    pending.bucket,
  ]);
  const rawPath = firstNonEmptyString([
    stringProp(resourceCandidate, 'name'),
    stringProp(destFile, 'name'),
    pending.copyTargetHint?.path,
  ]);
  const fullPath = normalizeStorageObjectPath(rawPath);
  if (fullPath === undefined) return undefined;
  const bucket = normalizeStorageBucket(rawBucket);

  const metadata = extractGcsObjectMetadata(resourceCandidate) ?? {};
  const replaceMetadata = isPlainRecord(resourceCandidate) && hasFullGcsResource(resourceCandidate);
  const ops: ObservedStorageSessionOp[] = [
    buildStorageUpsertOp(bucket, fullPath, metadata, replaceMetadata),
  ];

  if (removeSource) {
    const srcBucket = normalizeStorageBucket(pending.bucket);
    const srcPath = normalizeStorageObjectPath(pending.path);
    if (isRelocatedStorageObject(srcBucket, srcPath, bucket, fullPath)) {
      ops.push({ kind: 'delete', bucket: srcBucket, fullPath: srcPath });
    }
  }
  return sessionDeltaOf({ storage: ops });
}

function captureBucketUpload(
  pending: PendingAdminStorageCall,
  value: unknown,
): ObservedSessionDelta | undefined {
  const uploadedFile = tupleItem(value, 0);
  const apiResp = tupleItem(value, 1);
  let metaSource: unknown = propOf(uploadedFile, 'metadata');
  if (isPlainRecord(apiResp)) metaSource = apiResp;
  const rawBucket = firstNonEmptyString([
    stringProp(metaSource, 'bucket'),
    stringProp(propOf(uploadedFile, 'bucket'), 'name'),
    pending.bucket,
  ]);
  const rawPath = firstNonEmptyString([
    stringProp(metaSource, 'name'),
    stringProp(uploadedFile, 'name'),
    pending.path,
  ]);
  const fullPath = normalizeStorageObjectPath(rawPath);
  if (fullPath === undefined) return undefined;

  const metadata = extractGcsObjectMetadata(metaSource) ?? {};
  const replaceMetadata = isPlainRecord(metaSource) && hasFullGcsResource(metaSource);
  return sessionDeltaOf({
    storage: [
      buildStorageUpsertOp(normalizeStorageBucket(rawBucket), fullPath, metadata, replaceMetadata),
    ],
  });
}

function hasNarrowingGetFilesFilter(query: Record<string, unknown> | undefined): boolean {
  if (query === undefined) return false;
  return (
    query.matchGlob !== undefined ||
    query.startOffset !== undefined ||
    query.endOffset !== undefined ||
    query.includeTrailingDelimiter !== undefined ||
    query.versions === true ||
    query.softDeleted === true ||
    query.autoPaginate === false ||
    query.maxResults !== undefined ||
    query.pageToken !== undefined
  );
}

function extractGetFilesQueryHint(queryArg: unknown): GetFilesQueryHint {
  if (queryArg !== undefined && !isPlainRecord(queryArg)) {
    return {
      hasInvalidQueryShape: true,
      prefix: undefined,
      isUnfilteredCompleteCandidate: false,
      recursive: false,
    };
  }
  const query = asPlainRecord(queryArg);
  const prefix = normalizeStoragePrefix(query?.prefix);
  const hasNarrowingFilter = hasNarrowingGetFilesFilter(query);
  const hasDelimiter = typeof query?.delimiter === 'string' && query.delimiter.length > 0;
  const hasNonSlashDelimiter = hasDelimiter && query?.delimiter !== '/';
  return {
    hasInvalidQueryShape: false,
    prefix,
    isUnfilteredCompleteCandidate: !hasNarrowingFilter && !hasNonSlashDelimiter,
    recursive: !hasDelimiter,
  };
}

function extractRawPrefixes(apiResp: Record<string, unknown> | undefined): unknown[] {
  if (apiResp !== undefined && Array.isArray(apiResp.prefixes)) {
    return apiResp.prefixes;
  }
  return [];
}

function captureGetFiles(
  pending: PendingAdminStorageCall,
  value: unknown,
): ObservedSessionDelta | undefined {
  const hint = pending.getFilesQueryHint;
  if (hint === undefined || hint.hasInvalidQueryShape || hint.prefix === undefined) {
    return skipDeltaOf('unsupported');
  }

  const tuple = asUnknownArray(value);
  const files = asUnknownArray(tuple[0]);
  const nextQuery = tuple[1];
  const apiResp = asPlainRecord(tuple[2]);
  const rawPrefixes = extractRawPrefixes(apiResp);

  const validPrefixes: string[] = [];
  for (const entry of rawPrefixes) {
    const normalized = normalizeStorageObjectPath(entry);
    if (normalized !== undefined) validPrefixes.push(normalized);
  }

  const validItems: ObservedStorageListItem[] = [];
  for (const fileObj of files) {
    const itemPath = normalizeStorageObjectPath(stringProp(fileObj, 'name'));
    if (itemPath === undefined) continue;
    const fileMeta = extractGcsObjectMetadata(propOf(fileObj, 'metadata'));
    const item: { fullPath: string; metadata?: ObservedStorageObjectInput } = { fullPath: itemPath };
    if (fileMeta !== undefined && Object.keys(fileMeta).length > 0) item.metadata = fileMeta;
    validItems.push(item);
  }

  const totalEntries = validPrefixes.length + validItems.length;
  const keptPrefixes = validPrefixes.slice(0, MAX_STORAGE_LIST_ENTRIES);
  const remainingSlots = Math.max(0, MAX_STORAGE_LIST_ENTRIES - keptPrefixes.length);
  const keptItems = validItems.slice(0, remainingSlots);
  const truncatedCount = Math.max(0, totalEntries - (keptPrefixes.length + keptItems.length));

  const bucket = normalizeStorageBucket(pending.bucket);
  const hasNextPageToken = isPlainRecord(nextQuery) && typeof nextQuery.pageToken === 'string';
  const isComplete =
    hint.isUnfilteredCompleteCandidate && !hasNextPageToken && truncatedCount === 0;
  const listOp: {
    kind: 'list';
    bucket: string;
    prefix: string;
    prefixes: string[];
    items: ObservedStorageListItem[];
    complete?: boolean;
    recursive?: boolean;
  } = { kind: 'list', bucket, prefix: hint.prefix, prefixes: keptPrefixes, items: keptItems };
  if (isComplete) {
    listOp.complete = true;
    if (hint.recursive) listOp.recursive = true;
  }

  return sessionDeltaOf({
    storage: [listOp],
    skipped: skipCountsOf(0, 0, truncatedCount),
  });
}

function hasRangeDeleteFilter(query: Record<string, unknown> | undefined): boolean {
  if (query === undefined) return false;
  return 'startOffset' in query || 'endOffset' in query || 'matchGlob' in query;
}

function contextDeleteDelta(
  methodName: string,
  bucket: string | undefined,
  path: string | undefined,
  args: readonly unknown[],
): ObservedSessionDelta | undefined {
  if (methodName === 'delete') {
    const fullPath = normalizeStorageObjectPath(path);
    if (fullPath === undefined) return undefined;
    return sessionDeltaOf({
      storage: [{ kind: 'delete', bucket: normalizeStorageBucket(bucket), fullPath }],
    });
  }
  const queryArg = args[0];
  if (queryArg !== undefined && !isPlainRecord(queryArg)) return skipDeltaOf('unsupported');
  const query = asPlainRecord(queryArg);
  if (hasRangeDeleteFilter(query)) return skipDeltaOf('unsupported');
  const prefix = normalizeStoragePrefix(query?.prefix);
  if (prefix === undefined) return skipDeltaOf('unsupported');
  return sessionDeltaOf({
    storage: [{ kind: 'deletePrefix', bucket: normalizeStorageBucket(bucket), prefix }],
  });
}

/**
 * Extracts numeric sizes and metadata options eagerly without holding raw
 * payload `args`, keying correlation on `sessionData` (`site.subject` stays
 * untouched).
 */
export function adminStorageSessionContext(
  methodName: string,
  bucket: string | undefined,
  path: string | undefined,
  args: readonly unknown[],
  self: unknown,
): { sessionData?: ObservedSessionDelta } {
  if (methodName === 'delete' || methodName === 'deleteFiles') {
    const deleteDelta = contextDeleteDelta(methodName, bucket, path, args);
    if (deleteDelta === undefined) return {};
    return { sessionData: deleteDelta };
  }
  const needsResultCapture =
    methodName === 'save' ||
    ((methodName === 'getMetadata' || methodName === 'setMetadata') && path !== undefined) ||
    methodName === 'copy' ||
    methodName === 'move' ||
    methodName === 'moveFileAtomic' ||
    methodName === 'rename' ||
    methodName === 'upload' ||
    methodName === 'getFiles';
  if (!needsResultCapture) return {};

  const token: ObservedSessionDelta = {};
  let saveByteLength: number | undefined;
  let saveOptionsMeta: ObservedStorageObjectInput | undefined;
  if (methodName === 'save') {
    saveByteLength = numericByteLengthOf(args[0]);
    saveOptionsMeta = extractAdminWriteOptionsMetadata(args[1]);
  }
  let copyTargetHint: CopyTargetHint | undefined;
  if (
    methodName === 'copy' ||
    methodName === 'move' ||
    methodName === 'moveFileAtomic' ||
    methodName === 'rename'
  ) {
    copyTargetHint = extractCopyTargetHint(args[0], bucket, path);
  }
  let getFilesQueryHint: GetFilesQueryHint | undefined;
  if (methodName === 'getFiles') {
    getFilesQueryHint = extractGetFilesQueryHint(args[0]);
  }

  PENDING_ADMIN_CALLS.set(token, { methodName, bucket, path, fileRef: self, saveByteLength, saveOptionsMeta, copyTargetHint, getFilesQueryHint });
  return { sessionData: token };
}

/** Releases the pending metadata correlation entry when an Admin call rejects. */
export function adminStorageRejection(site: ObservedSite): RejectionReading {
  if (site.sessionData !== undefined) {
    PENDING_ADMIN_CALLS.delete(site.sessionData);
  }
  return {};
}

/** Extracts metadata-only Storage session deltas from a resolved `@google-cloud/storage` call. */
export function adminStorageResult(site: ObservedSite, value: unknown): ResultReading {
  if (site.sessionData === undefined) return {};
  const pending = PENDING_ADMIN_CALLS.get(site.sessionData);
  if (pending === undefined) return {};
  PENDING_ADMIN_CALLS.delete(site.sessionData);

  let sessionData: ObservedSessionDelta | undefined;
  switch (pending.methodName) {
    case 'save':
      sessionData = captureAdminWriteStreamDelta(pending.bucket, pending.path, pending.fileRef, pending.saveByteLength, pending.saveOptionsMeta);
      break;
    case 'getMetadata':
    case 'setMetadata':
      sessionData = captureMetadataTuple(pending, value);
      break;
    case 'copy':
      sessionData = captureCopyOrMove(pending, value, false);
      break;
    case 'move':
    case 'moveFileAtomic':
    case 'rename':
      sessionData = captureCopyOrMove(pending, value, true);
      break;
    case 'upload':
      sessionData = captureBucketUpload(pending, value);
      break;
    case 'getFiles':
      sessionData = captureGetFiles(pending, value);
      break;
    default:
      sessionData = undefined;
  }

  if (sessionData === undefined) return {};
  return { sessionData };
}
