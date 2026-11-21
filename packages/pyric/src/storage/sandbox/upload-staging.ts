/**
 * In-memory chunked upload part staging shared by memory and IndexedDB Storage backends.
 */

interface StagedPartUpload {
  uploadId: string;
  bucket: string;
  path: string;
  size: number;
  contentType: string;
  customMetadata?: Record<string, string>;
  parts: Map<number, Uint8Array>;
  createdAt: number;
}

function createUploadId(): string {
  const hasRandomUuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  if (hasRandomUuid) {
    return crypto.randomUUID();
  }
  return `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class InMemoryUploadStaging {
  private readonly uploads = new Map<string, StagedPartUpload>();

  beginUpload(
    bucket: string,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): string {
    const uploadId = createUploadId();
    this.uploads.set(uploadId, {
      uploadId,
      bucket,
      path,
      size,
      contentType,
      customMetadata,
      parts: new Map(),
      createdAt: Date.now(),
    });
    return uploadId;
  }

  putPart(uploadId: string, partIndex: number, bytes: Uint8Array): { bytesReceived: number } {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      const err = new Error(`storage/object-not-found: Upload '${uploadId}' not found.`) as Error & { code: string };
      err.code = 'storage/object-not-found';
      throw err;
    }
    upload.parts.set(partIndex, bytes);
    let bytesReceived = 0;
    for (const part of upload.parts.values()) {
      bytesReceived += part.byteLength;
    }
    return { bytesReceived };
  }

  readUpload(uploadId: string): Blob {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      const err = new Error(`storage/object-not-found: Upload '${uploadId}' not found.`) as Error & { code: string };
      err.code = 'storage/object-not-found';
      throw err;
    }
    let totalLength = 0;
    const sortedIndices = Array.from(upload.parts.keys()).sort((a, b) => a - b);
    const orderedParts: Uint8Array<ArrayBuffer>[] = [];
    for (const idx of sortedIndices) {
      const part = upload.parts.get(idx);
      if (part === undefined) continue;
      totalLength += part.byteLength;
      orderedParts.push(part as Uint8Array<ArrayBuffer>);
    }
    if (totalLength !== upload.size) {
      const err = new Error(
        `storage/invalid-argument: Uploaded bytes (${totalLength}) did not match declared size (${upload.size}).`,
      ) as Error & { code: string };
      err.code = 'storage/invalid-argument';
      throw err;
    }
    return new Blob(orderedParts, { type: upload.contentType });
  }

  abortUpload(uploadId: string): void {
    this.uploads.delete(uploadId);
  }
}
