/**
 * Reading a bucket out, and writing one back.
 *
 * Storage stays out of the sandbox's record bundle: it owns its own durability
 * through IndexedDB, and blobs are not JSON. So every part of the surface that
 * saves or replaces sandbox state has to walk the bucket itself, and this is
 * the one walk they share. A checkpoint captures it, a fixture exports it, a
 * scoped reset clears it, and the in-process server's sidecar file is the same
 * records written to disk.
 *
 * It is a leaf: it knows the SDK and nothing about the server, the surface's
 * context, or where any of this is stored.
 */
import {
  ref as storageRef,
  uploadBytes,
  listAll,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  DEFAULT_BUCKET,
  getAdminStorageSandbox,
  getStorageService,
  nameStorageBucket,
  targetOf,
  type StorageBackend,
} from 'pyric/storage/internal';
import { BY_REFERENCE_ALTERNATIVE, assertInlineStorageFits, type InlineStorageDocument } from 'pyric/sandbox/internal';

const STORAGE_SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

function heldNamedStorageBuckets(sandbox: object): string[] {
  const holder = globalThis as {
    [STORAGE_SERVICE_CACHES_KEY]?: {
      scopedServices?: WeakMap<object, Map<string, unknown>>;
    };
  };
  const scoped = holder[STORAGE_SERVICE_CACHES_KEY]?.scopedServices?.get(sandbox);
  if (scoped === undefined) return [];
  return [...scoped.keys()].sort();
}

/** Settable standard HTTP/Storage metadata fields carried on seeded and exported objects. */
export interface OptionalStorageObjectHeaders {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
}

/** Copy defined standard Storage object header fields without introducing `undefined` keys. */
export function copyStorageObjectHeaders(
  source: OptionalStorageObjectHeaders,
  target: OptionalStorageObjectHeaders,
): void {
  if (source.contentType !== undefined) target.contentType = source.contentType;
  if (source.cacheControl !== undefined) target.cacheControl = source.cacheControl;
  if (source.contentDisposition !== undefined) target.contentDisposition = source.contentDisposition;
  if (source.contentEncoding !== undefined) target.contentEncoding = source.contentEncoding;
  if (source.contentLanguage !== undefined) target.contentLanguage = source.contentLanguage;
}

/** One stored object, in the shape a capture holds it. */
export interface StorageObjectRecord extends OptionalStorageObjectHeaders {
  bucket?: string;
  path: string;
  contentBase64: string;
  metadata: Record<string, unknown>;
}

/**
 * Every object path in the bucket. `listAll` reports one level, so the walk
 * descends into each prefix it returns.
 */
export async function listStoredPaths(storage: FirebaseStorage): Promise<string[]> {
  const paths: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    const listing = await listAll(storageRef(storage, prefix));
    for (const item of listing.items) paths.push(item.fullPath);
    for (const child of listing.prefixes) pending.push(child.fullPath);
  }
  paths.sort();
  return paths;
}

/** Where a fixture export's Storage ends up, and what to use past the inline limit. */
export const FIXTURE_EXPORT_DOCUMENT: InlineStorageDocument = {
  document: 'A fixture export',
  instead: BY_REFERENCE_ALTERNATIVE,
};

interface PreparedBucketExport {
  readonly backend: StorageBackend;
  readonly bucket: string;
  readonly paths: readonly string[];
  readonly recordBucket?: string;
}

async function prepareBucketExports(storage: FirebaseStorage): Promise<PreparedBucketExport[]> {
  const rootTarget = targetOf(storage);
  const handles: Array<{ handle: FirebaseStorage; recordBucket?: string }> = [{ handle: storage }];
  if (rootTarget.bucket === DEFAULT_BUCKET) {
    for (const bucketName of heldNamedStorageBuckets(rootTarget.sandbox)) {
      if (bucketName === '' || bucketName === DEFAULT_BUCKET) continue;
      const rawNamed = getAdminStorageSandbox(rootTarget.sandbox, { bucket: bucketName });
      const namedHandle = nameStorageBucket(rawNamed, bucketName);
      handles.push({ handle: namedHandle, recordBucket: bucketName });
    }
  }
  const prepared: PreparedBucketExport[] = [];
  for (const entry of handles) {
    const service = await getStorageService(entry.handle);
    const { bucket } = targetOf(entry.handle);
    const paths = await listStoredPaths(entry.handle);
    prepared.push({
      backend: service.backend,
      bucket,
      paths,
      recordBucket: entry.recordBucket,
    });
  }
  return prepared;
}

/**
 * Read every object out of the bucket (and any named buckets opened on the
 * same sandbox when exporting from the default handle) into records. Each
 * object's bytes and metadata are read as one pair from the same write, so an
 * overwrite during the export cannot pair one write's content type with
 * another's bytes. An object deleted after the listing is left out.
 *
 * The records carry their bytes inline, so the total is checked against the
 * inline limit from the listed sizes before a byte is read, and again as the
 * bytes are read, refused in the name of `target`.
 */
export async function exportStorage(
  storage: FirebaseStorage,
  target: InlineStorageDocument,
): Promise<StorageObjectRecord[]> {
  const buckets = await prepareBucketExports(storage);
  let listedBytes = 0;
  for (const source of buckets) {
    for (const path of source.paths) {
      const listedMeta = await source.backend.getMetadata(path, source.bucket);
      if (listedMeta !== undefined) listedBytes += listedMeta.size;
    }
  }
  assertInlineStorageFits(listedBytes, target);
  const records: StorageObjectRecord[] = [];
  let readBytes = 0;
  for (const source of buckets) {
    for (const path of source.paths) {
      const object = await source.backend.getObject(path, source.bucket);
      const deletedSinceListing = object === undefined;
      if (deletedSinceListing) continue;
      const { blob, metadata } = object;
      readBytes += blob.size;
      // An overwrite after the listing can grow an object; refuse before encoding it.
      assertInlineStorageFits(readBytes, target);
      const customMetadata = metadata.customMetadata ?? {};
      const contentBase64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
      const record: StorageObjectRecord = {
        path,
        contentBase64,
        metadata: customMetadata,
      };
      if (source.recordBucket !== undefined) {
        record.bucket = source.recordBucket;
      }
      copyStorageObjectHeaders(metadata, record);
      records.push(record);
    }
  }
  return records;
}

/** Write every record into its bucket. Returns the number of objects restored. */
export async function restoreStorage(
  storage: FirebaseStorage,
  records: readonly StorageObjectRecord[],
): Promise<number> {
  const rootTarget = targetOf(storage);
  for (const record of records) {
    let targetStorage = storage;
    if (
      record.bucket !== undefined &&
      record.bucket !== '' &&
      record.bucket !== DEFAULT_BUCKET
    ) {
      const rawNamed = getAdminStorageSandbox(rootTarget.sandbox, { bucket: record.bucket });
      targetStorage = nameStorageBucket(rawNamed, record.bucket);
    }
    const decoded = Buffer.from(record.contentBase64, 'base64');
    const bytes = Uint8Array.from(decoded);
    const settable: OptionalStorageObjectHeaders & {
      customMetadata?: Record<string, string>;
    } = {};
    copyStorageObjectHeaders(record, settable);
    const custom = toCustomMetadata(record.metadata);
    if (custom !== null) settable.customMetadata = custom;
    await uploadBytes(storageRef(targetStorage, record.path), bytes, settable);
  }
  return records.length;
}

/** Storage custom metadata is a string map; anything else is dropped rather than coerced. */
export function toCustomMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> | null {
  const entries: Record<string, string> = {};
  let found = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') continue;
    entries[key] = value;
    found = true;
  }
  if (!found) return null;
  return entries;
}
