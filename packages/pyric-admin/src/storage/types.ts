/**
 * Public interfaces and option shapes for `pyric-admin/storage`.
 *
 * Mirrors the supported `firebase-admin/storage` and `@google-cloud/storage`
 * subset across both in-process and remote sandbox arms.
 */

import type { Readable, Writable } from 'node:stream';
import type { PyricAdminApp } from '../app/index.js';
import type { DeleteFilesOptions, GetFilesOptions } from './file-query.js';
import type { GetFilesResponse } from './get-files.js';
import type { FileMetadata, FileMetadataUpdate } from './metadata-codec.js';

/**
 * `pyric-admin/storage`'s sandbox `Storage` handle.
 *
 * The shared `bucket(name?)` shape is the contract: consumers code against it
 * without caring whether the local or remote sandbox is live.
 */
export interface Storage {
  /**
   * Get a {@link Bucket} handle. When `name` is omitted, returns the
   * sandbox default bucket (`'pyric-default'` unless configured on the app).
   */
  bucket(name?: string): Bucket;
}

/**
 * A storage bucket handle implemented by both local and remote sandbox paths.
 */
export interface Bucket {
  /** Name of the bucket. Stable across `file()` lookups. */
  readonly name: string;
  /** Get a {@link File} handle for `path`. The file may or may not exist. */
  file(path: string): File;
  /**
   * List the bucket's files, as `@google-cloud/storage` does: names starting
   * with `prefix`, rolled up at `delimiter`, paged by `maxResults` and
   * `pageToken`. Resolves `[files, nextQuery, apiResponse]`.
   */
  getFiles(query?: GetFilesOptions): Promise<GetFilesResponse<File>>;
  /**
   * Delete every file `getFiles(query)` would list across its pages. With
   * `force`, a failed delete does not stop the others, and the call rejects
   * with the array of errors.
   */
  deleteFiles(query?: DeleteFilesOptions): Promise<void>;
}

/**
 * A file handle within a bucket. Method shapes mirror
 * `@google-cloud/storage`'s `File` (return tuples for download, exists,
 * getSignedUrl, etc.).
 */
export interface File {
  /** Name (path) of the file within its bucket. */
  readonly name: string;
  /** Bucket the file belongs to. Same handle the `file()` call came from. */
  readonly bucket: Bucket;
  /** Last fetched or listed metadata (`{}` before `getFiles`, `getMetadata`, or `setMetadata`). */
  metadata: Partial<FileMetadata>;
  /**
   * Persist `data` at this file's path. Replaces any existing content
   * (no append semantics). `options.metadata` is stored alongside the bytes
   * and surfaces on later reads via `getMetadata()`.
   */
  save(data: Buffer | string | Uint8Array, options?: SaveOptions): Promise<void>;
  /**
   * Read the file's bytes, or the inclusive range `start..end` of them.
   * Returns a `[Buffer]` tuple to mirror `@google-cloud/storage`'s
   * `File.download`. Rejects if the file does not exist.
   */
  download(options?: DownloadOptions): Promise<[Buffer]>;
  /**
   * A readable stream of the file's bytes, or of the inclusive range
   * `start..end`. A missing file surfaces as the stream's error.
   */
  createReadStream(options?: CreateReadStreamOptions): Readable;
  /**
   * A writable stream whose bytes replace the file's content once the
   * stream finishes, as {@link File.save} does.
   */
  createWriteStream(options?: CreateWriteStreamOptions): Writable;
  /**
   * `@google-cloud/storage`'s resumable upload session: a URL that takes the
   * object's bytes from a browser, and creates the object with
   * `options.metadata` when the last byte arrives. A remote sandbox whose host
   * serves HTTP gives one. In process, and on a browser tab's SharedWorker
   * host, there is no HTTP host to take the bytes, so this rejects with a
   * not-implemented error there.
   */
  createResumableUpload(options?: CreateResumableUploadOptions): Promise<[string]>;
  /**
   * Copy the object, with its content type, custom metadata and download
   * tokens, to `destination`: a path in this bucket, a `gs://` URL, another
   * {@link Bucket} (same path), or another {@link File}. `options` change the
   * copy's metadata; a custom key set to `null` is left off the copy.
   * Resolves `[copy, copyMetadata]`.
   */
  copy(destination: CopyDestination, options?: CopyOptions): Promise<[File, FileMetadata]>;
  /** The file's metadata, as a `[metadata]` tuple. Rejects if the file does not exist. */
  getMetadata(): Promise<[FileMetadata]>;
  /**
   * Change the file's metadata: the named settable fields, and the custom
   * keys under `metadata`, where `null` removes a key and the others stay.
   * Removing `firebaseStorageDownloadTokens` revokes the file's download URL.
   */
  setMetadata(metadata: FileMetadataUpdate): Promise<[FileMetadata]>;
  /** Remove the file from its bucket; missing files are ignored (`ignoreNotFound: true`). */
  delete(): Promise<void>;
  /** `[true]` if the file exists, `[false]` otherwise. Tuple shape mirrors `@google-cloud/storage`. */
  exists(): Promise<[boolean]>;
  /**
   * Return a stub signed URL of the form
   * `pyric-sandbox-storage://${bucket}/${path}?expires=${expires}&action=${action}`.
   * The sandbox does NOT serve the URL; it is a deterministic placeholder.
   */
  getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
}

/** Options bag for {@link File.save}. Subset of `@google-cloud/storage`'s `SaveOptions`. */
export interface SaveOptions {
  /**
   * Metadata stored alongside the file: the settable fields `setMetadata`
   * takes, and custom keys under `metadata`. A `firebaseStorageDownloadTokens`
   * custom key sets the file's download tokens. Other fields are ignored.
   */
  metadata?: Record<string, unknown>;
  /**
   * Content type hint stored on the sandbox entry.
   * Convenience shortcut for `metadata.contentType`.
   */
  contentType?: string;
  /**
   * How `@google-cloud/storage` sends the bytes. The sandbox stores the
   * object in one write either way, so the stored object is the same.
   */
  resumable?: boolean;
}

/** Options bag for {@link File.download}. Subset of `@google-cloud/storage`'s `DownloadOptions`. */
export interface DownloadOptions {
  /** First byte to read, inclusive. */
  start?: number;
  /** Last byte to read, inclusive. */
  end?: number;
  /** The sandbox accepts but ignores `validation`. */
  validation?: 'md5' | 'crc32c' | boolean;
}

/** Options bag for {@link File.createReadStream}. Subset of `@google-cloud/storage`'s `CreateReadStreamOptions`. */
export type CreateReadStreamOptions = DownloadOptions;

/** Options bag for {@link File.createWriteStream}. Subset of `@google-cloud/storage`'s `CreateWriteStreamOptions`. */
export interface CreateWriteStreamOptions {
  /** Stored alongside the file, as {@link SaveOptions.metadata} is. */
  metadata?: Record<string, unknown>;
  /** Content type stored on the file. */
  contentType?: string;
}

/** Options bag for {@link File.createResumableUpload}. Subset of `@google-cloud/storage`'s `CreateResumableUploadOptions`. */
export interface CreateResumableUploadOptions {
  /** The object's metadata, as {@link SaveOptions.metadata} takes it. */
  metadata?: Record<string, unknown>;
  /** The page origin whose cross-origin requests the session URL answers. */
  origin?: string;
}

/** Where {@link File.copy} copies to. */
export type CopyDestination = string | Bucket | File;

/** Options bag for {@link File.copy}. Subset of `@google-cloud/storage`'s `CopyOptions`. */
export interface CopyOptions {
  contentType?: string | null;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  contentLanguage?: string | null;
  /** Custom keys for the copy, merged over the source's; `null` leaves a key off. */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Options bag for {@link File.getSignedUrl}. Mirrors `@google-cloud/storage`'s shape. */
export interface GetSignedUrlOptions {
  /** `'read' | 'write' | 'delete' | 'resumable'`. Sandbox stamps it into the URL only as a hint. */
  action: 'read' | 'write' | 'delete' | 'resumable';
  /**
   * Expiration. Accepts ms-since-epoch (number), ISO date string, or
   * `Date`. Sandbox normalizes to ms-since-epoch and embeds in the
   * stub URL's `expires=` query.
   */
  expires: number | string | Date;
}

/**
 * Input accepted by `getStorage`. Calling without an argument resolves the
 * default app from the `pyric-admin/app` registry, and throws `app/no-app`
 * when nothing is initialized.
 */
export type StorageApp = PyricAdminApp;
