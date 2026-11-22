/**
 * Bucket-scoped view over an underlying StorageBackend.
 */

import type { GenerationIssuer } from '../generation.js';
import type { StorageBackend, StoredMetadata, StoredObject } from '../persistence.js';
import type { StorageReferenceRecord } from './persistence-state.js';

function withBucket(metadata: StoredMetadata, bucket: string): StoredMetadata {
  if (metadata.bucket) {
    return metadata;
  }
  return { ...metadata, bucket };
}

export class ScopedStorageBackend implements StorageBackend {
  constructor(
    private readonly underlying: StorageBackend,
    readonly bucket: string,
  ) {}

  get replacedObjectsOnDisk(): boolean | undefined {
    return this.underlying.replacedObjectsOnDisk;
  }

  async put(path: string, blob: Blob, metadata: StoredMetadata, issue?: GenerationIssuer): Promise<StoredObject | undefined> {
    const meta = withBucket(metadata, this.bucket);
    const replaced = await this.underlying.put(path, blob, meta, issue);
    // The underlying backend sets the generation and finalized etag on its copy.
    metadata.generation = meta.generation;
    if (meta.etag !== undefined) {
      metadata.etag = meta.etag;
    }
    return replaced;
  }

  deleteIfGeneration(path: string, generation: string, bucket?: string): Promise<boolean> {
    return this.underlying.deleteIfGeneration(path, generation, bucket ?? this.bucket);
  }

  replaceIfGeneration(path: string, generation: string, prior: StoredObject | undefined, bucket?: string): Promise<boolean> {
    return this.underlying.replaceIfGeneration(path, generation, prior, bucket ?? this.bucket);
  }

  references(bucket?: string): Promise<StorageReferenceRecord[]> {
    if (this.underlying.references) {
      return this.underlying.references(bucket ?? this.bucket);
    }
    throw new Error('The underlying storage backend keeps no object files to refer to.');
  }

  putReference(path: string, reference: { sha256: string; size: number }, mime: string, metadata: StoredMetadata): Promise<void> {
    const meta = withBucket(metadata, this.bucket);
    if (this.underlying.putReference) {
      return this.underlying.putReference(path, reference, mime, meta);
    }
    throw new Error('The underlying storage backend keeps no object files to refer to.');
  }

  getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    return this.underlying.getBlob(path, bucket ?? this.bucket);
  }

  getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined> {
    return this.underlying.getMetadata(path, bucket ?? this.bucket);
  }

  getObject(path: string, bucket?: string): Promise<StoredObject | undefined> {
    return this.underlying.getObject(path, bucket ?? this.bucket);
  }

  putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const meta = withBucket(metadata, this.bucket);
    return this.underlying.putMetadata(path, meta, bucket ?? this.bucket);
  }

  delete(path: string, bucket?: string): Promise<void> {
    return this.underlying.delete(path, bucket ?? this.bucket);
  }

  listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    return this.underlying.listByPrefix(prefix, bucket ?? this.bucket);
  }

  reset(bucket?: string): Promise<void> {
    return this.underlying.reset(bucket ?? this.bucket);
  }

  beginUpload(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const b = bucket ?? this.bucket;
    if (this.underlying.beginUpload) {
      return this.underlying.beginUpload(b, path, size, contentType, customMetadata);
    }
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  putPart(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number } | void> {
    if (this.underlying.putPart) {
      return this.underlying.putPart(uploadId, partIndex, bytes);
    }
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  readUpload(uploadId: string): Promise<Blob> {
    if (this.underlying.readUpload) {
      return this.underlying.readUpload(uploadId);
    }
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  abortUpload(uploadId: string): Promise<void> {
    if (this.underlying.abortUpload) {
      return this.underlying.abortUpload(uploadId);
    }
    return Promise.resolve();
  }

  close(): void {
    this.underlying.close();
  }

  scoped(bucket: string): StorageBackend {
    if (bucket === this.bucket) {
      return this;
    }
    if (this.underlying.scoped) {
      return this.underlying.scoped(bucket);
    }
    return new ScopedStorageBackend(this.underlying, bucket);
  }
}
