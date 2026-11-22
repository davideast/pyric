import { DOC_VALUE_ENCODING } from '../../firestore/internal/value-codec.js';
import { checksumDocs, type BucketRecord } from './chunk-format.js';

export function cloneRawEntry(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Retains raw bucket entries for Firestore documents that were skipped as
 * unreadable during `deserializeFromBuckets(..., { skipInvalidDocuments: true })`,
 * so subsequent flushes of their bucket carry those entries forward unchanged
 * until the document is explicitly overwritten, deleted, or cleared.
 */
export class SkippedDocuments {
  private readonly byBucket = new Map<string, Map<string, unknown>>();
  private readonly bucketOfPath = new Map<string, string>();

  remember(bucketId: string, path: string, rawDocument: unknown): void {
    const priorBucket = this.bucketOfPath.get(path);
    if (priorBucket !== undefined && priorBucket !== bucketId) {
      const priorEntries = this.byBucket.get(priorBucket);
      priorEntries?.delete(path);
      if (priorEntries !== undefined && priorEntries.size === 0) {
        this.byBucket.delete(priorBucket);
      }
    }
    let entries = this.byBucket.get(bucketId);
    if (entries === undefined) {
      entries = new Map<string, unknown>();
      this.byBucket.set(bucketId, entries);
    }
    entries.set(path, cloneRawEntry(rawDocument));
    this.bucketOfPath.set(path, bucketId);
  }

  forget(path: string): string | undefined {
    const bucketId = this.bucketOfPath.get(path);
    if (bucketId === undefined) return undefined;
    this.bucketOfPath.delete(path);
    const entries = this.byBucket.get(bucketId);
    if (entries !== undefined) {
      entries.delete(path);
      if (entries.size === 0) {
        this.byBucket.delete(bucketId);
      }
    }
    return bucketId;
  }

  clear(): void {
    this.byBucket.clear();
    this.bucketOfPath.clear();
  }

  entriesForBucket(bucketId: string): ReadonlyMap<string, unknown> | undefined {
    return this.byBucket.get(bucketId);
  }

  applyToSerializedRecords(records: Map<string, unknown>): void {
    for (const [bucketId, entries] of this.byBucket) {
      if (entries.size === 0) continue;
      let bucket = records.get(bucketId) as BucketRecord | undefined;
      if (bucket === undefined) {
        bucket = { docs: {}, encoding: DOC_VALUE_ENCODING };
        records.set(bucketId, bucket);
      }
      const docs = bucket.docs as Record<string, unknown>;
      for (const [path, rawDoc] of entries) {
        if (!Object.hasOwn(docs, path)) {
          docs[path] = cloneRawEntry(rawDoc);
        }
      }
      bucket.checksum = checksumDocs(docs);
    }
  }
}
