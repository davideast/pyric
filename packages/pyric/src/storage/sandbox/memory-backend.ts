/**
 * In-memory StorageBackend implementation used in environments without IndexedDB
 * or when IndexedDB cannot be opened.
 */

import { computeStorageEtag } from '../digests.js';
import { higherGeneration, raisedMark, type GenerationIssuer } from '../generation.js';
import {
  DEFAULT_BUCKET,
  assertMatchingSize,
  assertPriorAt,
  parseStorageKey,
  toStorageKey,
  type StorageBackend,
  type StoredMetadata,
  type StoredObject,
} from '../persistence.js';
import { ScopedStorageBackend } from './scoped-backend.js';
import { InMemoryUploadStaging } from './upload-staging.js';

export class InMemoryStorageBackend implements StorageBackend {
  private readonly blobs = new Map<string, Blob>();
  private readonly metadata = new Map<string, StoredMetadata>();
  private readonly highWater = new Map<string, string>();
  private readonly staging = new InMemoryUploadStaging();
  private _defaultBucket: string | undefined;

  constructor(defaultBucket?: string) {
    this._defaultBucket = defaultBucket;
  }

  async put(path: string, blob: Blob, metadata: StoredMetadata, issue?: GenerationIssuer): Promise<StoredObject | undefined> {
    const bucket = metadata.bucket || this._defaultBucket || DEFAULT_BUCKET;
    if (!this._defaultBucket) {
      this._defaultBucket = bucket;
    }
    assertMatchingSize(blob, metadata);
    if (!metadata.bucket) {
      metadata.bucket = bucket;
    }
    const key = toStorageKey(bucket, path);
    const replaced = this.objectAt(key);
    const mark = this.highWater.get(key);
    if (issue !== undefined) {
      metadata.generation = issue(higherGeneration(replaced?.metadata.generation, mark));
      metadata.etag = computeStorageEtag(metadata.generation, metadata.metageneration);
    } else if (metadata.etag === undefined) {
      metadata.etag = computeStorageEtag(metadata.generation, metadata.metageneration);
    }
    this.blobs.set(key, blob);
    this.metadata.set(key, metadata);
    this.highWater.set(key, raisedMark(mark, metadata.generation));
    return replaced;
  }

  private objectAt(key: string): StoredObject | undefined {
    const blob = this.blobs.get(key);
    const metadata = this.metadata.get(key);
    const missingObject = blob === undefined || metadata === undefined;
    if (missingObject) return undefined;
    return { blob, metadata };
  }

  async deleteIfGeneration(path: string, generation: string, bucket?: string): Promise<boolean> {
    return this.replaceIfGeneration(path, generation, undefined, bucket);
  }

  async replaceIfGeneration(path: string, generation: string, prior: StoredObject | undefined, bucket?: string): Promise<boolean> {
    const target = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (prior !== undefined) assertPriorAt(prior, target, path);
    const key = toStorageKey(target, path);
    const replaced = this.metadata.get(key)?.generation !== generation;
    if (replaced) return false;
    this.blobs.delete(key);
    this.metadata.delete(key);
    if (prior === undefined) return true;
    this.blobs.set(key, prior.blob);
    this.metadata.set(key, prior.metadata);
    return true;
  }

  async getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    if (bucket) {
      return this.blobs.get(toStorageKey(bucket, path));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = this.blobs.get(toStorageKey(targetBucket, path));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = this.blobs.get(toStorageKey(DEFAULT_BUCKET, path));
      if (def !== undefined) return def;
    }
    for (const [key, blob] of this.blobs.entries()) {
      const parsed = parseStorageKey(key);
      if (parsed && parsed.path === path) {
        return blob;
      }
    }
    return undefined;
  }

  async getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined> {
    if (bucket) {
      return this.metadata.get(toStorageKey(bucket, path));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = this.metadata.get(toStorageKey(targetBucket, path));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = this.metadata.get(toStorageKey(DEFAULT_BUCKET, path));
      if (def !== undefined) return def;
    }
    for (const [key, meta] of this.metadata.entries()) {
      const parsed = parseStorageKey(key);
      if (parsed && parsed.path === path) {
        return meta;
      }
    }
    return undefined;
  }

  async getObject(path: string, bucket?: string): Promise<StoredObject | undefined> {
    return this.objectAt(toStorageKey(bucket ?? this._defaultBucket ?? DEFAULT_BUCKET, path));
  }

  async putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const b = bucket ?? metadata.bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (!metadata.bucket) metadata.bucket = b;
    this.metadata.set(toStorageKey(b, path), metadata);
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    this.blobs.delete(toStorageKey(targetBucket, path));
    this.metadata.delete(toStorageKey(targetBucket, path));
  }

  async listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const keyPrefix = `${targetBucket}/${prefix}`;
    const results: StoredMetadata[] = [];
    const keys = Array.from(this.metadata.keys()).sort();
    for (const key of keys) {
      if (key.startsWith(keyPrefix)) {
        const meta = this.metadata.get(key);
        if (meta) results.push(meta);
      }
    }
    return results;
  }

  async reset(bucket?: string): Promise<void> {
    if (!bucket) {
      this.blobs.clear();
      this.metadata.clear();
      this._defaultBucket = undefined;
      return;
    }
    const bucketPrefix = `${bucket}/`;
    for (const key of Array.from(this.blobs.keys())) {
      if (key.startsWith(bucketPrefix)) {
        this.blobs.delete(key);
      }
    }
    for (const key of Array.from(this.metadata.keys())) {
      if (key.startsWith(bucketPrefix)) {
        this.metadata.delete(key);
      }
    }
  }

  async beginUpload(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const b = bucket || this._defaultBucket || DEFAULT_BUCKET;
    return this.staging.beginUpload(b, path, size, contentType, customMetadata);
  }

  async putPart(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number }> {
    return this.staging.putPart(uploadId, partIndex, bytes);
  }

  async readUpload(uploadId: string): Promise<Blob> {
    return this.staging.readUpload(uploadId);
  }

  async abortUpload(uploadId: string): Promise<void> {
    this.staging.abortUpload(uploadId);
  }

  close(): void {}

  scoped(bucket: string): StorageBackend {
    return new ScopedStorageBackend(this, bucket);
  }
}
