/**
 * Remote sandbox arm for `pyric-admin/storage`.
 *
 * Relays every data operation over the remote handle's worker channel with
 * `actAs: { mode: 'admin' }` pinned (rules-bypass semantics against the shared
 * object store). Bytes move over the host's HTTP byte route when available, or
 * as 4 MiB frames on a SharedWorker host.
 */

import { openAsBlob } from 'node:fs';
import { Readable, type Writable } from 'node:stream';
import { defineDeferredMembers } from 'pyric/app/internal';
import type { RemoteSandbox, RemoteSandboxChannel } from 'pyric/sandbox';
import { fetchFromByteRoute, uploadOverByteRoute } from 'pyric/storage/internal';

import type { PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import {
  DEFAULT_SANDBOX_BUCKET,
  assertDeleteFileOptions,
  byteRange,
  copyTargetOf,
  declaredByteLengthOf,
  normalizeBucketName,
  normalizeByteBounds,
  normalizeCopyOptions,
  normalizeDownloadOptions,
  normalizeFileObjectPath,
  normalizeResumableUploadOptions,
  normalizeSaveOptions,
  normalizeWriteStreamOptions,
  resolveDefaultBucketName,
  stubSignedUrl,
  toBytesAsync,
  tryNormalizeBucketName,
} from './argument-validation.js';
import { BUCKET_DEFERRED_MEMBERS, FILE_DEFERRED_MEMBERS } from './deferred-members.js';
import { deletedNamesFound, deleteListedFiles } from './delete-files.js';
import {
  normalizeListingQuery,
  type DeleteFilesOptions,
  type GetFilesOptions,
} from './file-query.js';
import { getFilesWithMetadata, pageNamesFound, type GetFilesResponse } from './get-files.js';
import {
  fileMetadataOf,
  patchOf,
  type FileMetadata,
  type FileMetadataUpdate,
  type HostMetadata,
} from './metadata-codec.js';
import { namesForQuery, type FolderListing } from './remote-names.js';
import type {
  Bucket,
  CopyDestination,
  CopyOptions,
  CreateReadStreamOptions,
  CreateResumableUploadOptions,
  CreateWriteStreamOptions,
  DownloadOptions,
  File,
  GetSignedUrlOptions,
  SaveOptions,
  Storage,
} from './types.js';
import {
  BUCKET_HANDLE_BRAND,
  DOWNLOAD_URL,
  FILE_HANDLE_BRAND,
  MAX_STORAGE_OBJECT_BYTES,
  base64Of,
  copyMetadataOf,
  dataUri,
  ignoreObjectNotFound,
  isBucketHandle,
  isFileHandle,
  isObjectNotFound,
  quotaExceeded,
  spooledWriteStream,
  uploadRequestOf,
  type DownloadUrlSource,
} from './upload-spool.js';

/** firebase-admin's rules-bypass lens, pinned on every relayed operation. */
const STORAGE_REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

/**
 * Raw per-part byte cap for storage payloads sent as frames. Mirrors
 * `@pyric/cli`'s `MAX_STORAGE_PART_BYTES`.
 */
const MAX_STORAGE_PART_BYTES = 4 * 1024 * 1024;

/** One remote `Storage` per admin `App` handle (handles only, never data). */
const remoteStorageByApp = new WeakMap<PyricAdminApp, Storage>();

export function getRemoteStorage(
  app: PyricAdminApp,
  sandbox: RemoteSandbox,
  configuredDefaultBucket: string | undefined,
): Storage {
  let storage = remoteStorageByApp.get(app);
  if (!storage) {
    storage = new RemoteStorage(app, sandbox.channel, configuredDefaultBucket);
    remoteStorageByApp.set(app, storage);
  }
  return storage;
}

/** Wire shape of the worker's `storage.getBytes` result. */
interface RemoteGetBytesResult {
  dataB64: string;
  contentType?: string;
  size: number;
}

/** How a relayed op names its bucket (`@pyric/cli`'s `StorageBucketWire`). */
interface BucketWire {
  bucket?: string;
  defaultBucket?: string;
}

class RemoteStorage implements Storage {
  readonly #app: PyricAdminApp;

  constructor(
    app: PyricAdminApp,
    private readonly channel: RemoteSandboxChannel,
    readonly configuredDefaultBucket: string | undefined,
  ) {
    this.#app = app;
  }

  assertActive(): void {
    assertAdminAppActive(this.#app);
  }

  bucket(name?: string): Bucket {
    this.assertActive();
    let bucketName: string;
    if (name === undefined) {
      bucketName = resolveDefaultBucketName(this.configuredDefaultBucket);
    } else {
      bucketName = normalizeBucketName(name);
    }
    return new RemoteBucket(bucketName, this.channel, this);
  }
}

class RemoteBucket implements Bucket {
  readonly [BUCKET_HANDLE_BRAND] = true;

  constructor(
    readonly name: string,
    private readonly channel: RemoteSandboxChannel,
    readonly storage: RemoteStorage,
  ) {}

  /**
   * How ops name this bucket: always send `bucket: this.name` (including explicit
   * `'pyric-default'` so callers with a custom `storageBucket` preserve explicit
   * `'pyric-default'` metadata and copy targets), and include `defaultBucket` when
   * the app configured a custom `storageBucket`.
   */
  get wire(): BucketWire {
    const wire: BucketWire = { bucket: this.name };
    const defaultName = tryNormalizeBucketName(this.storage.configuredDefaultBucket);
    if (defaultName !== undefined && defaultName !== DEFAULT_SANDBOX_BUCKET) {
      wire.defaultBucket = defaultName;
    }
    return wire;
  }

  file(path: string): File {
    this.storage.assertActive();
    return new RemoteFile(normalizeFileObjectPath(path), this, this.channel);
  }

  async getFiles(query: GetFilesOptions = {}): Promise<GetFilesResponse<File>> {
    this.storage.assertActive();
    const normalized = normalizeListingQuery<GetFilesOptions>(query, 'getFiles');
    const names = await this.namesFor(normalized, pageNamesFound(normalized));
    return getFilesWithMetadata(
      names,
      normalized,
      (name) => this.file(name),
      async (file) => (await file.getMetadata())[0],
    );
  }

  async deleteFiles(query: DeleteFilesOptions = {}): Promise<void> {
    this.storage.assertActive();
    const normalized = normalizeListingQuery<DeleteFilesOptions>(query, 'deleteFiles');
    const names = await this.namesFor(normalized, deletedNamesFound(normalized));
    await deleteListedFiles(names, normalized, (name) => this.file(name).delete());
  }

  private namesFor(query: GetFilesOptions, enough: (name: string) => boolean): Promise<string[]> {
    return namesForQuery(
      query,
      async (path) =>
        (await this.channel.op({
          method: 'storage.listAll',
          ...this.wire,
          path,
          actAs: STORAGE_REMOTE_ADMIN_LENS,
        })) as FolderListing,
      enough,
    );
  }
}

class RemoteFile implements File, DownloadUrlSource {
  readonly [FILE_HANDLE_BRAND] = true;
  metadata: Partial<FileMetadata> = {};

  constructor(
    readonly name: string,
    readonly bucket: RemoteBucket,
    readonly channel: RemoteSandboxChannel,
  ) {}

  async save(
    data: Buffer | string | Uint8Array,
    options: SaveOptions = {},
  ): Promise<void> {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeSaveOptions(options);
    const declaredBytes = declaredByteLengthOf(data);
    if (declaredBytes !== undefined && declaredBytes > MAX_STORAGE_OBJECT_BYTES) {
      throw quotaExceeded(declaredBytes, `save() payload for '${this.name}'`);
    }
    const bytes = await toBytesAsync(data);
    if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
      throw quotaExceeded(bytes.byteLength, `save() payload for '${this.name}'`);
    }
    await this.upload(new Blob([bytes as Uint8Array<ArrayBuffer>]), normalizedOptions);
  }

  async download(options: DownloadOptions = {}): Promise<[Buffer]> {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeDownloadOptions(options);
    const parts: Uint8Array[] = [];
    for await (const part of this.read(normalizedOptions)) {
      parts.push(part);
    }
    return [Buffer.concat(parts)];
  }

  createReadStream(options: CreateReadStreamOptions = {}): Readable {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeDownloadOptions(options);
    return Readable.from(this.read(normalizedOptions), { objectMode: false });
  }

  createWriteStream(options: CreateWriteStreamOptions = {}): Writable {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeWriteStreamOptions(options);
    return spooledWriteStream(async (spooled) => {
      this.bucket.storage.assertActive();
      const data = await openAsBlob(spooled);
      if (data.size > MAX_STORAGE_OBJECT_BYTES) {
        throw quotaExceeded(data.size, `createWriteStream() payload for '${this.name}'`);
      }
      await this.upload(data, normalizedOptions);
    });
  }

  async createResumableUpload(options?: CreateResumableUploadOptions): Promise<[string]> {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeResumableUploadOptions(options);
    const route = await this.channel.byteRoute?.();
    if (route === undefined) {
      throw new Error(
        'not implemented in pyric-admin/storage remote sandbox backend: resumable upload sessions (createResumableUpload) ' +
          'on a host without an HTTP byte route. Upload with file.save() or file.createWriteStream().',
      );
    }
    const uploadInput: CreateWriteStreamOptions = {};
    if (normalizedOptions.metadata !== undefined) {
      uploadInput.metadata = normalizedOptions.metadata;
    }
    const opPayload: { method: string } & Record<string, unknown> = {
      method: 'storage.createUploadSession',
      ...this.bucket.wire,
      path: this.name,
      ...uploadRequestOf(uploadInput),
      actAs: STORAGE_REMOTE_ADMIN_LENS,
    };
    if (normalizedOptions.origin !== undefined) {
      opPayload.origin = normalizedOptions.origin;
    }
    const { uploadUrl } = (await this.channel.op(opPayload)) as { uploadUrl: string };
    return [new URL(uploadUrl, route.baseUrl).href];
  }

  async copy(destination: CopyDestination, options: CopyOptions = {}): Promise<[File, FileMetadata]> {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeCopyOptions(options);
    const target = copyTargetOf(
      this,
      destination,
      this.bucket.storage,
      isBucketHandle,
      isFileHandle,
    );
    const remote = target instanceof RemoteFile && target.channel === this.channel;
    if (!remote) {
      throw new Error(
        'pyric-admin/storage: File.copy copies to a File from the same remote sandbox.',
      );
    }
    target.bucket.storage.assertActive();
    const destinationWire = target.bucket.wire;
    const op: { method: string } & Record<string, unknown> = {
      method: 'storage.copyObject',
      ...this.bucket.wire,
      path: this.name,
      destinationPath: target.name,
      patch: patchOf(copyMetadataOf(normalizedOptions), { strict: false }),
      actAs: STORAGE_REMOTE_ADMIN_LENS,
    };
    if (destinationWire.bucket !== undefined) {
      op.destinationBucket = destinationWire.bucket;
    }
    if (destinationWire.defaultBucket !== undefined) {
      op.destinationDefaultBucket = destinationWire.defaultBucket;
    }
    const full = (await this.missingAsNoSuchObject(this.channel.op(op))) as HostMetadata;
    return [target, fileMetadataOf(full)];
  }

  private async upload(data: Blob, options: CreateWriteStreamOptions): Promise<void> {
    const request = { ...this.bucket.wire, ...uploadRequestOf(options) };
    const route = await this.channel.byteRoute?.();
    if (route !== undefined) {
      await uploadOverByteRoute(this.channel, route, {
        path: this.name,
        data,
        ...request,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
      return;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength <= MAX_STORAGE_PART_BYTES) {
      await this.channel.op({
        method: 'storage.putBytes',
        path: this.name,
        dataB64: base64Of(bytes),
        ...request,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
      return;
    }
    const { uploadId } = (await this.channel.op({
      method: 'storage.beginUpload',
      path: this.name,
      size: bytes.byteLength,
      ...request,
      actAs: STORAGE_REMOTE_ADMIN_LENS,
    })) as { uploadId: string };
    try {
      for (
        let offset = 0, index = 0;
        offset < bytes.byteLength;
        offset += MAX_STORAGE_PART_BYTES, index += 1
      ) {
        await this.channel.op({
          method: 'storage.putPart',
          uploadId,
          partIndex: index,
          dataB64: base64Of(bytes.subarray(offset, offset + MAX_STORAGE_PART_BYTES)),
          actAs: STORAGE_REMOTE_ADMIN_LENS,
        });
      }
      await this.channel.op({
        method: 'storage.finishUpload',
        uploadId,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
    } catch (err) {
      try {
        await this.channel.op({
          method: 'storage.abortUpload',
          uploadId,
          actAs: STORAGE_REMOTE_ADMIN_LENS,
        });
      } catch {
        // secondary abort best effort
      }
      throw err;
    }
  }

  private async *read(options: DownloadOptions): AsyncGenerator<Uint8Array> {
    this.bucket.storage.assertActive();
    const metadata = (await this.missingAsNoSuchObject(
      this.channel.op({
        method: 'storage.getMetadata',
        ...this.bucket.wire,
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      }),
    )) as { bucket: string; fullPath: string; size: number; generation: string };
    const bounds = normalizeByteBounds(metadata.size, options);
    if (bounds === null) {
      return;
    }
    let normalizedOptions: DownloadOptions = {};
    if (bounds.start !== 0 || bounds.endExclusive !== metadata.size) {
      normalizedOptions = { start: bounds.start, end: bounds.endExclusive - 1 };
    }
    const route = await this.channel.byteRoute?.();
    if (route === undefined) {
      yield* this.readFrames(metadata, normalizedOptions);
      return;
    }
    const response = await this.missingAsNoSuchObject(
      fetchFromByteRoute(route, {
        bucket: metadata.bucket,
        ...this.bucket.wire,
        path: metadata.fullPath,
        start: normalizedOptions.start,
        end: normalizedOptions.end,
      }),
    );
    const body = response.body;
    if (body === null) {
      return;
    }
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *readFrames(
    metadata: { fullPath: string; size: number; generation: string },
    options: DownloadOptions,
  ): AsyncGenerator<Uint8Array> {
    if (metadata.size <= MAX_STORAGE_PART_BYTES) {
      const wire = (await this.missingAsNoSuchObject(
        this.channel.op({
          method: 'storage.getBytes',
          ...this.bucket.wire,
          path: metadata.fullPath,
          actAs: STORAGE_REMOTE_ADMIN_LENS,
        }),
      )) as RemoteGetBytesResult;
      yield byteRange(Buffer.from(wire.dataB64, 'base64'), options);
      return;
    }
    let endExclusive = metadata.size;
    if (options.end !== undefined) {
      endExclusive = Math.min(metadata.size, options.end + 1);
    }
    const startOffset = options.start ?? 0;
    for (let offset = startOffset; offset < endExclusive; offset += MAX_STORAGE_PART_BYTES) {
      const wire = (await this.missingAsNoSuchObject(
        this.channel.op({
          method: 'storage.getBytes',
          ...this.bucket.wire,
          path: metadata.fullPath,
          offset,
          length: Math.min(MAX_STORAGE_PART_BYTES, endExclusive - offset),
          expectedGeneration: metadata.generation,
          actAs: STORAGE_REMOTE_ADMIN_LENS,
        }),
      )) as RemoteGetBytesResult;
      yield Buffer.from(wire.dataB64, 'base64');
    }
  }

  async getMetadata(): Promise<[FileMetadata]> {
    this.bucket.storage.assertActive();
    const full = (await this.missingAsNoSuchObject(
      this.channel.op({
        method: 'storage.getMetadata',
        ...this.bucket.wire,
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      }),
    )) as HostMetadata;
    const out = fileMetadataOf(full);
    this.metadata = out;
    return [out];
  }

  async setMetadata(metadata: FileMetadataUpdate): Promise<[FileMetadata]> {
    this.bucket.storage.assertActive();
    const full = (await this.missingAsNoSuchObject(
      this.channel.op({
        method: 'storage.setMetadata',
        ...this.bucket.wire,
        path: this.name,
        patch: patchOf(metadata, { strict: true }),
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      }),
    )) as HostMetadata;
    const out = fileMetadataOf(full);
    this.metadata = out;
    return [out];
  }

  async [DOWNLOAD_URL](): Promise<string> {
    this.bucket.storage.assertActive();
    const { path } = (await this.missingAsNoSuchObject(
      this.channel.op({
        method: 'storage.getDownloadURL',
        ...this.bucket.wire,
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      }),
    )) as { path: string };
    const route = await this.channel.byteRoute?.();
    if (route !== undefined) {
      return new URL(path, route.baseUrl).href;
    }
    const [[metadata], [bytes]] = await Promise.all([this.getMetadata(), this.download()]);
    return dataUri(bytes, metadata.contentType);
  }

  private async missingAsNoSuchObject<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (err) {
      if (isObjectNotFound(err)) {
        throw new Error(`No such object: ${this.bucket.name}/${this.name}`);
      }
      throw err;
    }
  }

  async delete(options?: unknown): Promise<void> {
    this.bucket.storage.assertActive();
    assertDeleteFileOptions(options);
    await ignoreObjectNotFound(
      this.channel.op({
        method: 'storage.deleteObject',
        ...this.bucket.wire,
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      }),
    );
  }

  async exists(): Promise<[boolean]> {
    this.bucket.storage.assertActive();
    try {
      await this.channel.op({
        method: 'storage.getMetadata',
        ...this.bucket.wire,
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
      return [true];
    } catch (err) {
      if (isObjectNotFound(err)) {
        return [false];
      }
      throw err;
    }
  }

  async getSignedUrl(options: GetSignedUrlOptions): Promise<[string]> {
    this.bucket.storage.assertActive();
    return [stubSignedUrl(this.bucket.name, this.name, options)];
  }
}

defineDeferredMembers(RemoteBucket.prototype, 'pyric-admin/storage', 'Bucket', BUCKET_DEFERRED_MEMBERS);
defineDeferredMembers(RemoteFile.prototype, 'pyric-admin/storage', 'File', FILE_DEFERRED_MEMBERS);
