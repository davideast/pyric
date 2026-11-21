/**
 * Shared internal primitives for in-process and remote `pyric-admin/storage`
 * handles: handle brands, object-not-found predicates, size cap errors,
 * `data:` URI encoding, and temporary file write-stream spooling.
 */

import { createWriteStream as createFileWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { savedMetadataOf } from './metadata-codec.js';
import { resolveUploadContentType } from './mime-type.js';
import type { Bucket, CopyOptions, CreateWriteStreamOptions, File } from './types.js';

/** Maximum whole-object size supported by the sandbox backend (512 MiB). */
export const MAX_STORAGE_OBJECT_BYTES = 512 * 1024 * 1024;

/** Internal symbol dispatching `getDownloadURL(file)` to each arm's implementation. */
export const DOWNLOAD_URL = Symbol('pyric-admin/storage download URL');

export interface DownloadUrlSource {
  [DOWNLOAD_URL](): Promise<string>;
}

/** Brand marking `SandboxBucket` and `RemoteBucket` instances. */
export const BUCKET_HANDLE_BRAND = Symbol('pyric-admin/storage bucket handle');

/** Brand marking `SandboxFile` and `RemoteFile` instances. */
export const FILE_HANDLE_BRAND = Symbol('pyric-admin/storage file handle');

export function isBucketHandle(candidate: unknown): candidate is Bucket {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    BUCKET_HANDLE_BRAND in candidate
  );
}

export function isFileHandle(candidate: unknown): candidate is File {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    FILE_HANDLE_BRAND in candidate
  );
}

/** Is this error `pyric/storage` or the worker's `storage/object-not-found`? */
export function isObjectNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  return (err as { code?: unknown }).code === 'storage/object-not-found';
}

export async function ignoreObjectNotFound(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (err) {
    if (!isObjectNotFound(err)) {
      throw err;
    }
  }
}

/** Missing-object rejection (`code: 404`), matching `@google-cloud/storage` `ApiError`. */
export function noSuchObjectError(
  bucketName: string,
  objectName: string,
): Error & { code: number } {
  const err = new Error(`No such object: ${bucketName}/${objectName}`) as Error & {
    code: number;
  };
  err.code = 404;
  return err;
}

/** Over-cap rejection (code `storage/quota-exceeded`), mirroring the worker host's message shape. */
export function quotaExceeded(sizeBytes: number, what: string): Error & { code: string } {
  const err = new Error(
    `pyric-admin/storage: ${what} is ${sizeBytes} bytes -- over the ` +
      `${MAX_STORAGE_OBJECT_BYTES / (1024 * 1024)} MiB maximum storage object cap (MAX_STORAGE_OBJECT_BYTES).`,
  ) as Error & { code: string };
  err.code = 'storage/quota-exceeded';
  return err;
}

/** {@link CopyOptions} as the metadata `save` takes: settable fields, and custom keys under `metadata`. */
export function copyMetadataOf(options: CopyOptions): Record<string, unknown> {
  const { metadata, ...settable } = options;
  const out: Record<string, unknown> = { ...settable };
  if (metadata !== undefined) {
    out.metadata = metadata;
  }
  return out;
}

/** What an upload sends besides its bytes: settable fields and custom metadata, with download tokens apart. */
export function uploadRequestOf(
  options: CreateWriteStreamOptions,
  objectName?: string,
): {
  contentType?: string;
  metadata?: Record<string, unknown>;
  downloadTokens?: string;
} {
  const out: {
    contentType?: string;
    metadata?: Record<string, unknown>;
    downloadTokens?: string;
  } = {};
  let saved: ReturnType<typeof savedMetadataOf> | undefined;
  if (options.metadata !== undefined) {
    saved = savedMetadataOf(options.metadata);
  }
  let resolvedContentType: string | undefined;
  if (objectName !== undefined) {
    resolvedContentType = resolveUploadContentType(
      objectName,
      options.contentType,
      saved?.settable.contentType,
    );
  } else if (options.contentType !== undefined) {
    resolvedContentType = options.contentType;
  }
  if (resolvedContentType !== undefined) {
    out.contentType = resolvedContentType;
  }
  if (saved !== undefined) {
    const metaOut: Record<string, unknown> = { ...saved.settable };
    if (resolvedContentType !== undefined) {
      metaOut.contentType = resolvedContentType;
    } else if (objectName !== undefined) {
      delete metaOut.contentType;
    }
    if (Object.keys(saved.custom).length > 0) {
      metaOut.metadata = saved.custom;
    }
    out.metadata = metaOut;
    if (saved.downloadTokens !== undefined) {
      out.downloadTokens = saved.downloadTokens;
    }
  }
  return out;
}

/** `bytes` as base64, for a wire frame or `data:` URI. */
export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** A `data:` URI carrying `bytes`, the download URL where no host serves them over HTTP. */
export function dataUri(bytes: Uint8Array, contentType: string | undefined): string {
  const resolvedType = contentType ?? 'application/octet-stream';
  return `data:${resolvedType};base64,${base64Of(bytes)}`;
}

/**
 * A writable stream that spools its bytes to a temporary file and, once it
 * finishes, hands that file to `commit`. The file is removed either way.
 */
export function spooledWriteStream(commit: (spooled: string) => Promise<void>): Writable {
  let directory: string | undefined;
  let sink: WriteStream | undefined;
  return new Writable({
    construct(callback) {
      mkdtemp(join(tmpdir(), 'pyric-admin-upload-')).then((created) => {
        directory = created;
        sink = createFileWriteStream(join(created, 'object'));
        sink.on('error', () => {});
        callback();
      }, callback);
    },
    write(chunk: Buffer, _encoding, callback) {
      if (sink === undefined) {
        callback(new Error('Upload spool stream not initialized.'));
        return;
      }
      sink.write(chunk, callback);
    },
    final(callback) {
      const activeSink = sink;
      const activeDir = directory;
      if (activeSink === undefined || activeDir === undefined) {
        callback(new Error('Upload spool stream not initialized.'));
        return;
      }
      activeSink.end(() => {
        commit(join(activeDir, 'object')).then(() => callback(), callback);
      });
    },
    destroy(error, callback) {
      sink?.destroy();
      const created = directory;
      if (created === undefined) {
        callback(error);
        return;
      }
      rm(created, { recursive: true, force: true }).finally(() => callback(error));
    },
  });
}
