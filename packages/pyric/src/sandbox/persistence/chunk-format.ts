/**
 * v3 chunked persistence format (pure functions).
 *
 * The v1/v2 format serialized the ENTIRE keyspace into one JSON string blob
 * (serialize.ts). At scale that blob exceeds V8's max string length (a 50k-vector
 * dataset is ~1.5GB of JSON), so it is structurally impossible, not just slow.
 *
 * v3 partitions the firestore doc map into BUCKET_COUNT records by a stable hash
 * of the doc path, plus one `meta` record (version + services). Each record is a
 * STRUCTURED-CLONE-SAFE object (marker-encoded docs, the same markers the v2 codec
 * emits via `toJSON`), so a backend can store it natively (IndexedDB) without ever
 * building a single keyspace-sized string. Write-behind flushes touch only the
 * buckets a write changed.
 *
 * FORMAT CONTRACT: BUCKET_COUNT and {@link pathToBucketId} are part of the v3
 * on-disk contract. Changing either is a format migration once real data exists.
 * (Float32Array vector encoding is a later, backward-compatible refinement on the
 * per-bucket record shape.)
 */
import { rehydrateDocValue } from '../../firestore/internal/value-codec.js';
import { deserializeSnapshot } from './serialize.js';

export const CHUNK_FORMAT_VERSION = 3 as const;
export const BUCKET_COUNT = 256;
export const META_RECORD_ID = 'meta';

/**
 * Stable FNV-1a hash of a doc path to a bucket id ('00'..'ff'). Deterministic and
 * environment-independent (no engine hash-iteration-order dependence), so the same
 * path always lands in the same bucket across hosts and reloads.
 */
export function pathToBucketId(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in uint32 via shift-sum.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h % BUCKET_COUNT).toString(16).padStart(2, '0');
}

/** A firestore bucket record: marker-encoded docs keyed by full path. */
export interface BucketRecord {
  docs: Record<string, Record<string, unknown>>;
  /** FNV checksum of `docs`, set on write and verified on read so a corrupt
   *  bucket is quarantined (skipped) rather than restored as garbage. */
  checksum?: number;
}

/** The single meta record: format version + persisted service state. */
export interface MetaRecord {
  version: typeof CHUNK_FORMAT_VERSION;
  savedAt: number;
  services: Record<string, unknown>;
}

/** Marker-encode a doc to a structured-clone-safe plain tree (reuses the wrapper
 *  `toJSON` markers via a per-doc round-trip; small per-doc strings, never one
 *  keyspace blob). */
function encodeDoc(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

/** FNV-1a checksum of a bucket's docs, for corruption detection on read. */
function checksumDocs(docs: Record<string, Record<string, unknown>>): number {
  const s = JSON.stringify(docs);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Partition a firestore doc map into v3 records: one bucket record per occupied
 * bucket plus the `meta` record. The returned map's keys are record ids; values
 * are structured-clone-safe.
 */
export function serializeToBuckets(
  firestore: Record<string, Record<string, unknown>>,
  services: Record<string, unknown>,
  savedAt: number,
): Map<string, BucketRecord | MetaRecord> {
  const records = new Map<string, BucketRecord | MetaRecord>();
  records.set(META_RECORD_ID, { version: CHUNK_FORMAT_VERSION, savedAt, services });
  for (const [path, data] of Object.entries(firestore)) {
    const id = pathToBucketId(path);
    let bucket = records.get(id) as BucketRecord | undefined;
    if (!bucket) {
      bucket = { docs: {} };
      records.set(id, bucket);
    }
    bucket.docs[path] = encodeDoc(data);
  }
  // Checksum each bucket so a corrupt record is detected + quarantined on read.
  for (const [id, rec] of records) {
    if (id === META_RECORD_ID) continue;
    (rec as BucketRecord).checksum = checksumDocs((rec as BucketRecord).docs);
  }
  return records;
}

/** Tag for a v3 record bundle (a single committable JSON of all records). */
export const V3_BUNDLE_FORMAT = 'pyric-v3-records';

/**
 * Bundle v3 records into one committable JSON string, for single-blob stores
 * (serve's exportable `.pyric/state` file, an HTTP state endpoint). Inverse of
 * {@link parseBundle}. This deliberately collapses the chunking into one blob:
 * it is the single-artifact EXPORT shape, not the scale path (that is the
 * record-shaped backend).
 */
export function bundleRecords(records: ReadonlyMap<string, unknown>): string {
  return JSON.stringify({ format: V3_BUNDLE_FORMAT, records: Object.fromEntries(records) });
}

/**
 * Parse a v3 bundle blob back into records. Returns an empty map for an
 * unrecognized blob (e.g. a legacy v2 single-blob snapshot); migrate-on-open (a
 * later commit) handles converting a v2 blob to v3 records.
 */
export function parseBundle(blob: string): Map<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return new Map();
  }
  const obj = parsed as { format?: unknown; records?: unknown } | null;
  if (
    obj &&
    typeof obj === 'object' &&
    obj.format === V3_BUNDLE_FORMAT &&
    typeof obj.records === 'object' &&
    obj.records !== null
  ) {
    return new Map(Object.entries(obj.records as Record<string, unknown>));
  }
  // Not a v3 bundle: maybe a legacy v2 single-snapshot blob (a committable file
  // or IDB record from before chunking). Migrate it to v3 records on read.
  return migrateV2ToRecords(blob) ?? new Map();
}

/**
 * Migrate a legacy v2 single-snapshot blob (the pre-chunking format: one
 * `JSON.stringify` of the whole keyspace) to v3 records. Returns null when
 * `blob` is not a recognizable v1/v2 snapshot. Used on read so existing
 * persisted state survives the format change (migrate-on-open).
 */
export function migrateV2ToRecords(
  blob: string,
): Map<string, BucketRecord | MetaRecord> | null {
  let snap;
  try {
    snap = deserializeSnapshot(blob);
  } catch {
    return null;
  }
  return serializeToBuckets(snap.firestore, snap.services, 0);
}

/** Reassemble a firestore snapshot + services from v3 records (any iterable of
 *  [recordId, record] pairs). Rehydrates wrapper types from their markers. */
export function deserializeFromBuckets(
  records: Iterable<[string, unknown]>,
): { firestore: Record<string, Record<string, unknown>>; services: Record<string, unknown> } {
  const firestore: Record<string, Record<string, unknown>> = {};
  let services: Record<string, unknown> = {};
  for (const [id, rec] of records) {
    if (id === META_RECORD_ID) {
      const meta = rec as Partial<MetaRecord> | null;
      if (meta && typeof meta.services === 'object' && meta.services !== null) {
        services = meta.services;
      }
      continue;
    }
    const bucket = rec as Partial<BucketRecord> | null;
    if (!bucket || typeof bucket.docs !== 'object' || bucket.docs === null) continue;
    // C5: verify the bucket's checksum (when present). A mismatch means the
    // record was corrupted in storage; quarantine it (skip + warn) rather than
    // restore garbage. Records without a checksum (pre-checksum v3) are accepted.
    if (
      typeof bucket.checksum === 'number' &&
      checksumDocs(bucket.docs as Record<string, Record<string, unknown>>) !== bucket.checksum
    ) {
      console.warn(`[sandbox/persistence] checksum mismatch for bucket '${id}'; skipping corrupt bucket`);
      continue;
    }
    for (const [path, data] of Object.entries(bucket.docs)) {
      firestore[path] = rehydrateDocValue(data) as Record<string, unknown>;
    }
  }
  return { firestore, services };
}
