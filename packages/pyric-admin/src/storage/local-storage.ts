/**
 * In-process sandbox arm for `pyric-admin/storage`.
 *
 * Delegates to the per-sandbox `pyric/storage` admin plane (`getAdminStorageSandbox`)
 * so `pyric-admin/storage`, `pyric/storage`, and `captureFullState` share one
 * object store.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable, type Writable } from 'node:stream';
import { defineDeferredMembers } from 'pyric/app/internal';
import type { Sandbox } from 'pyric/sandbox';
import {
  deleteObject as storageDeleteObject,
  getMetadata as storageGetMetadata,
  ref as storageRef,
  type FirebaseStorage,
  type SettableMetadata,
} from 'pyric/storage';
import {
  copyObject,
  getAdminStorageSandbox,
  getStorageService,
  patchObjectMetadata,
  toFullMetadata,
  uploadObject,
} from 'pyric/storage/internal';

import type { SandboxAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import {
  DEFAULT_SANDBOX_BUCKET,
  assertDeleteFileOptions,
  byteRange,
  copyTargetOf,
  declaredByteLengthOf,
  normalizeBucketName,
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
import { deleteListedFiles } from './delete-files.js';
import {
  normalizeListingQuery,
  type DeleteFilesOptions,
  type GetFilesOptions,
} from './file-query.js';
import { getFilesWithMetadata, type GetFilesResponse } from './get-files.js';
import {
  fileMetadataOf,
  patchOf,
  savedMetadataOf,
  type FileMetadata,
  type FileMetadataUpdate,
  type HostMetadata,
} from './metadata-codec.js';
import { resolveUploadContentType } from './mime-type.js';
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
  copyMetadataOf,
  dataUri,
  ignoreObjectNotFound,
  isBucketHandle,
  isFileHandle,
  isObjectNotFound,
  noSuchObjectError,
  quotaExceeded,
  spooledWriteStream,
  type DownloadUrlSource,
} from './upload-spool.js';

interface SandboxStorageState {
  readonly dbName: string;
  primaryDefaultBucket: string | null;
  usedDefaultBucket: boolean;
  readonly explicitNamedBuckets: Set<string>;
  readonly buckets: Set<string>;
  pendingReset: Promise<void> | undefined;
}

/**
 * State and reset-handler registry keyed on `Sandbox` so a single `Sandbox`
 * shares its storage across every `getStorage` call and with `pyric/storage`.
 */
const SANDBOX_STATE = new WeakMap<Sandbox, SandboxStorageState>();

function canAdoptPrimaryDefaultBucket(
  state: SandboxStorageState,
  candidate: string | undefined,
): candidate is string {
  if (candidate === undefined || candidate === DEFAULT_SANDBOX_BUCKET) {
    return false;
  }
  if (state.primaryDefaultBucket !== null) {
    return false;
  }
  if (state.usedDefaultBucket) {
    return false;
  }
  if (state.explicitNamedBuckets.has(candidate)) {
    return false;
  }
  return true;
}

function ensureSandboxStorageState(
  sandbox: Sandbox,
  configuredDefaultBucket: string | undefined,
): SandboxStorageState {
  let state = SANDBOX_STATE.get(sandbox);
  if (!state) {
    state = {
      dbName: `pyric-admin-storage:${randomUUID()}`,
      primaryDefaultBucket: null,
      usedDefaultBucket: false,
      explicitNamedBuckets: new Set(),
      buckets: new Set([DEFAULT_SANDBOX_BUCKET]),
      pendingReset: undefined,
    };
    SANDBOX_STATE.set(sandbox, state);
    sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        const current = SANDBOX_STATE.get(sandbox);
        if (!current) {
          return;
        }
        const previous = current.pendingReset ?? Promise.resolve();
        const bucketsToReset = [...current.buckets];
        const nextReset = previous
          .then(async () => {
            await Promise.all(
              bucketsToReset.map(async (bucket) => {
                const handle = getAdminStorageSandbox(sandbox, {
                  dbName: current.dbName,
                  bucket,
                });
                const service = await getStorageService(handle);
                await service.backend.reset(bucket);
              }),
            );
          })
          .catch(() => {
            // Best-effort reset across open bucket handles
          });
        current.pendingReset = nextReset;
      }
    });
  }
  const normalizedDefault = tryNormalizeBucketName(configuredDefaultBucket);
  if (canAdoptPrimaryDefaultBucket(state, normalizedDefault)) {
    state.primaryDefaultBucket = normalizedDefault;
  }
  return state;
}

export function getSandboxStorage(
  app: SandboxAdminApp,
  configuredDefaultBucket: string | undefined,
): Storage {
  const sandbox = app.sandbox;
  const state = ensureSandboxStorageState(sandbox, configuredDefaultBucket);
  return new SandboxStorage(app, sandbox, state, configuredDefaultBucket);
}

class SandboxStorage implements Storage {
  readonly #app: SandboxAdminApp;

  constructor(
    app: SandboxAdminApp,
    readonly sandbox: Sandbox,
    readonly state: SandboxStorageState,
    readonly configuredDefaultBucket: string | undefined,
  ) {
    this.#app = app;
  }

  assertActive(): void {
    assertAdminAppActive(this.#app);
  }

  storeBucketOf(bucketName: string): string {
    if (
      bucketName === DEFAULT_SANDBOX_BUCKET ||
      bucketName === this.state.primaryDefaultBucket
    ) {
      return DEFAULT_SANDBOX_BUCKET;
    }
    return bucketName;
  }

  async waitForReset(): Promise<void> {
    while (this.state.pendingReset !== undefined) {
      const pending = this.state.pendingReset;
      await pending;
      if (this.state.pendingReset === pending) {
        this.state.pendingReset = undefined;
      }
    }
  }

  bucket(name?: string): Bucket {
    this.assertActive();
    let bucketName: string;
    if (name === undefined) {
      bucketName = resolveDefaultBucketName(this.configuredDefaultBucket);
    } else {
      bucketName = normalizeBucketName(name);
    }
    if (bucketName === DEFAULT_SANDBOX_BUCKET) {
      this.state.usedDefaultBucket = true;
    }
    const storeBucket = this.storeBucketOf(bucketName);
    if (storeBucket !== DEFAULT_SANDBOX_BUCKET) {
      this.state.explicitNamedBuckets.add(storeBucket);
    }
    this.state.buckets.add(storeBucket);
    return new SandboxBucket(bucketName, storeBucket, this);
  }
}

class SandboxBucket implements Bucket {
  readonly [BUCKET_HANDLE_BRAND] = true;

  constructor(
    readonly name: string,
    readonly storeBucket: string,
    readonly storage: SandboxStorage,
  ) {}

  adminStorage(): FirebaseStorage {
    this.storage.state.buckets.add(this.storeBucket);
    return getAdminStorageSandbox(this.storage.sandbox, {
      dbName: this.storage.state.dbName,
      bucket: this.storeBucket,
    });
  }

  file(path: string): File {
    this.storage.assertActive();
    return new SandboxFile(normalizeFileObjectPath(path), this);
  }

  async getFiles(query: GetFilesOptions = {}): Promise<GetFilesResponse<File>> {
    this.storage.assertActive();
    const normalized = normalizeListingQuery<GetFilesOptions>(query, 'getFiles');
    const byName = await this.storedUnder(normalized.prefix);
    return getFilesWithMetadata(
      [...byName.keys()],
      normalized,
      (name) => this.file(name),
      async (file) => byName.get(file.name),
    );
  }

  async deleteFiles(query: DeleteFilesOptions = {}): Promise<void> {
    this.storage.assertActive();
    const normalized = normalizeListingQuery<DeleteFilesOptions>(query, 'deleteFiles');
    const byName = await this.storedUnder(normalized.prefix);
    await deleteListedFiles([...byName.keys()], normalized, (name) => this.file(name).delete());
  }

  private async storedUnder(prefix = ''): Promise<Map<string, FileMetadata>> {
    await this.storage.waitForReset();
    const service = await getStorageService(this.adminStorage());
    const items = await service.backend.listByPrefix(prefix, this.storeBucket);
    const byName = new Map<string, FileMetadata>();
    for (const item of items) {
      const full = toFullMetadata(item, 'admin') as HostMetadata;
      byName.set(item.fullPath, fileMetadataOf({ ...full, bucket: this.name }));
    }
    return byName;
  }
}

class SandboxFile implements File, DownloadUrlSource {
  readonly [FILE_HANDLE_BRAND] = true;
  metadata: Partial<FileMetadata> = {};

  constructor(
    readonly name: string,
    readonly bucket: SandboxBucket,
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
    await this.bucket.storage.waitForReset();
    const saved = savedMetadataOf(normalizedOptions.metadata ?? {});
    const contentType = resolveUploadContentType(
      this.name,
      normalizedOptions.contentType,
      saved.settable.contentType,
    );
    const settable: SettableMetadata = { ...saved.settable };
    if (contentType !== undefined) {
      settable.contentType = contentType;
    } else {
      delete settable.contentType;
    }
    if (Object.keys(saved.custom).length > 0) {
      settable.customMetadata = saved.custom;
    }
    const uploadOpts: { downloadTokens?: string } = {};
    if (saved.downloadTokens !== undefined) {
      uploadOpts.downloadTokens = saved.downloadTokens;
    }
    await uploadObject(
      storageRef(this.bucket.adminStorage(), this.name),
      bytes,
      settable,
      uploadOpts,
    );
  }

  async getMetadata(): Promise<[FileMetadata]> {
    this.bucket.storage.assertActive();
    await this.bucket.storage.waitForReset();
    const full = (await this.missingAsNoSuchObject(
      storageGetMetadata(storageRef(this.bucket.adminStorage(), this.name)),
    )) as HostMetadata;
    const out = fileMetadataOf({ ...full, bucket: this.bucket.name });
    this.metadata = out;
    return [out];
  }

  async setMetadata(metadata: FileMetadataUpdate): Promise<[FileMetadata]> {
    this.bucket.storage.assertActive();
    await this.bucket.storage.waitForReset();
    const patch = patchOf(metadata, { strict: true });
    const full = (await this.missingAsNoSuchObject(
      patchObjectMetadata(storageRef(this.bucket.adminStorage(), this.name), patch),
    )) as HostMetadata;
    const out = fileMetadataOf({ ...full, bucket: this.bucket.name });
    this.metadata = out;
    return [out];
  }

  async [DOWNLOAD_URL](): Promise<string> {
    this.bucket.storage.assertActive();
    await this.bucket.storage.waitForReset();
    const r = storageRef(this.bucket.adminStorage(), this.name);
    const full = (await this.missingAsNoSuchObject(storageGetMetadata(r))) as HostMetadata;
    const token = (full.downloadTokens ?? '').split(',').find((existing) => existing !== '');
    if (token === undefined) {
      await patchObjectMetadata(r, { downloadTokens: randomUUID() });
    }
    const [bytes] = await this.download();
    return dataUri(bytes, full.contentType);
  }

  private async missingAsNoSuchObject<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (err) {
      if (isObjectNotFound(err)) {
        throw noSuchObjectError(this.bucket.name, this.name);
      }
      throw err;
    }
  }

  async download(options: DownloadOptions = {}): Promise<[Buffer]> {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeDownloadOptions(options);
    await this.bucket.storage.waitForReset();
    const adminStorage = this.bucket.adminStorage();
    const r = storageRef(adminStorage, this.name);
    const service = await getStorageService(adminStorage);
    const object = await service.backend.getObject(r.fullPath, this.bucket.storeBucket);
    if (!object) {
      throw noSuchObjectError(this.bucket.name, this.name);
    }
    const bytes = new Uint8Array(await object.blob.arrayBuffer());
    return [Buffer.from(byteRange(bytes, normalizedOptions))];
  }

  createReadStream(options: CreateReadStreamOptions = {}): Readable {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeDownloadOptions(options);
    const read = async function* (file: SandboxFile): AsyncGenerator<Uint8Array> {
      const [bytes] = await file.download(normalizedOptions);
      yield bytes;
    };
    return Readable.from(read(this), { objectMode: false });
  }

  createWriteStream(options: CreateWriteStreamOptions = {}): Writable {
    this.bucket.storage.assertActive();
    const normalizedOptions = normalizeWriteStreamOptions(options);
    return spooledWriteStream(async (spooled) =>
      this.save(await readFile(spooled), normalizedOptions),
    );
  }

  async createResumableUpload(options?: CreateResumableUploadOptions): Promise<[string]> {
    this.bucket.storage.assertActive();
    normalizeResumableUploadOptions(options);
    throw new Error(
      'not implemented in pyric-admin/storage sandbox backend: resumable upload sessions (createResumableUpload). ' +
        'The in-process sandbox has no HTTP host to take the bytes; upload with file.save() or file.createWriteStream().',
    );
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
    const local =
      target instanceof SandboxFile &&
      target.bucket.storage.sandbox === this.bucket.storage.sandbox;
    if (!local) {
      throw new Error(
        'pyric-admin/storage: File.copy copies to a File from the same getStorage() sandbox.',
      );
    }
    target.bucket.storage.assertActive();
    await this.bucket.storage.waitForReset();
    const patch = patchOf(copyMetadataOf(normalizedOptions), { strict: false });
    const full = (await this.missingAsNoSuchObject(
      copyObject(
        storageRef(this.bucket.adminStorage(), this.name),
        storageRef(target.bucket.adminStorage(), target.name),
        patch,
      ),
    )) as HostMetadata;
    return [target, fileMetadataOf({ ...full, bucket: target.bucket.name })];
  }

  async delete(options?: unknown): Promise<void> {
    this.bucket.storage.assertActive();
    assertDeleteFileOptions(options);
    await this.bucket.storage.waitForReset();
    await ignoreObjectNotFound(
      storageDeleteObject(storageRef(this.bucket.adminStorage(), this.name)),
    );
  }

  async exists(): Promise<[boolean]> {
    this.bucket.storage.assertActive();
    await this.bucket.storage.waitForReset();
    const adminStorage = this.bucket.adminStorage();
    const r = storageRef(adminStorage, this.name);
    const service = await getStorageService(adminStorage);
    const stored = await service.backend.getMetadata(r.fullPath, this.bucket.storeBucket);
    return [stored !== undefined];
  }

  async getSignedUrl(options: GetSignedUrlOptions): Promise<[string]> {
    this.bucket.storage.assertActive();
    return [stubSignedUrl(this.bucket.name, this.name, options)];
  }
}

defineDeferredMembers(SandboxBucket.prototype, 'pyric-admin/storage', 'Bucket', BUCKET_DEFERRED_MEMBERS);
defineDeferredMembers(SandboxFile.prototype, 'pyric-admin/storage', 'File', FILE_DEFERRED_MEMBERS);
