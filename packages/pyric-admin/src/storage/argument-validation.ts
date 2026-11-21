/**
 * Input validation and normalization for `pyric-admin/storage`, keeping both
 * the in-process `Sandbox` and `RemoteSandbox` arms aligned with
 * `firebase-admin/storage` (`v13.10.0`) and `@google-cloud/storage` (`v7.21.0`).
 */

import type {
  Bucket,
  CopyDestination,
  CopyOptions,
  DownloadOptions,
  File,
  GetSignedUrlOptions,
  SaveOptions,
  Storage,
} from './types.js';

/** Default sandbox bucket name shared with `pyric/storage`. */
export const DEFAULT_SANDBOX_BUCKET = 'pyric-default';

const GS_COPY_URL_RE = /^gs:\/\/([a-z0-9_.-]+)\/(.+)$/;

const BUCKET_INVALID_MESSAGE =
  'Bucket name not specified or invalid. Specify a valid bucket name via the ' +
  'storageBucket option when initializing the app, or specify the bucket name ' +
  'explicitly when calling the bucket() method.';

function storageInvalidArgument(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = 'storage/invalid-argument';
  return err;
}

export function tryNormalizeBucketName(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const stripped = raw.replace(/^gs:\/\//, '').replace(/\/+$/, '');
  if (stripped.length === 0) return undefined;
  return stripped;
}

export function resolveDefaultBucketName(configuredBucket: string | undefined): string {
  if (configuredBucket === undefined) {
    return DEFAULT_SANDBOX_BUCKET;
  }
  return normalizeBucketName(configuredBucket);
}

/**
 * Validate and normalize a bucket name (`gs://` prefix and trailing `/`
 * stripped) matching `firebase-admin/storage` (`validator.isNonEmptyString`)
 * and `@google-cloud/storage` (`new Bucket`).
 */
export function normalizeBucketName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw storageInvalidArgument(BUCKET_INVALID_MESSAGE);
  }
  const stripped = raw.replace(/^gs:\/\//, '').replace(/\/+$/, '');
  if (stripped.length === 0) {
    throw storageInvalidArgument(BUCKET_INVALID_MESSAGE);
  }
  return stripped;
}

/**
 * Validate and coerce a `Bucket.file(path)` object name matching
 * `@google-cloud/storage` (`Bucket.prototype.file`).
 */
export function normalizeFileObjectPath(rawPath: unknown): string {
  if (!Boolean(rawPath)) {
    throw new Error('A file name must be specified.');
  }
  return String(rawPath);
}

export function assertDeleteFileOptions(options: unknown): void {
  if (typeof options === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.delete returns a promise; the callback form is not supported.',
    );
  }
  if (options === null) {
    throw new TypeError('Cannot read properties of null (reading "ignoreNotFound").');
  }
}

export interface NormalizedSaveOptions {
  readonly contentType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly resumable?: boolean;
}

export function normalizeSaveOptions(rawOptions: unknown): NormalizedSaveOptions {
  if (typeof rawOptions === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.save returns a promise; the callback form is not supported.',
    );
  }
  if (rawOptions === null) {
    throw new TypeError('Cannot read properties of null (reading "metadata").');
  }
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  const opts = rawOptions as SaveOptions & Record<string, unknown>;
  if (opts.metadata !== undefined && opts.metadata !== null && typeof opts.metadata !== 'object') {
    throw new TypeError('Cannot create property "contentType" on primitive metadata value.');
  }
  let metadata: Record<string, unknown> | undefined;
  if (
    opts.metadata !== undefined &&
    opts.metadata !== null &&
    typeof opts.metadata === 'object' &&
    !Array.isArray(opts.metadata)
  ) {
    metadata = opts.metadata;
  }
  let contentType: string | undefined;
  if (typeof opts.contentType === 'string') {
    contentType = opts.contentType;
  }
  let resumable: boolean | undefined;
  if (typeof opts.resumable === 'boolean') {
    resumable = opts.resumable;
  }
  return { contentType, metadata, resumable };
}

export function normalizeWriteStreamOptions(rawOptions: unknown): NormalizedSaveOptions {
  if (typeof rawOptions === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.createWriteStream returns a stream; the callback form is not supported.',
    );
  }
  if (rawOptions !== undefined && (rawOptions === null || typeof rawOptions !== 'object')) {
    throw new TypeError('Options argument to createWriteStream() must be an object.');
  }
  return normalizeSaveOptions(rawOptions ?? {});
}

export interface NormalizedResumableUploadOptions {
  readonly metadata?: Record<string, unknown>;
  readonly origin?: string;
}

export function normalizeResumableUploadOptions(
  rawOptions: unknown,
): NormalizedResumableUploadOptions {
  if (typeof rawOptions === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.createResumableUpload returns a promise; the callback form is not supported.',
    );
  }
  if (rawOptions === null) {
    throw new TypeError('Cannot read properties of null (reading "metadata").');
  }
  if (rawOptions === undefined || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  const opts = rawOptions as Record<string, unknown>;
  let metadata: Record<string, unknown> | undefined;
  if (opts.metadata !== null && typeof opts.metadata === 'object' && !Array.isArray(opts.metadata)) {
    metadata = opts.metadata as Record<string, unknown>;
  }
  let origin: string | undefined;
  if (typeof opts.origin === 'string') {
    origin = opts.origin;
  }
  return { metadata, origin };
}

/**
 * Normalize `Buffer | string | Uint8Array | Iterable<string | Uint8Array>` into
 * a fresh `Uint8Array`, matching `@google-cloud/storage` `File.prototype.save`.
 */
export function declaredByteLengthOf(data: unknown): number | undefined {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }
  if (data !== null && typeof data === 'object' && 'byteLength' in data) {
    const raw = (data as { byteLength?: unknown }).byteLength;
    if (typeof raw === 'number') {
      return raw;
    }
  }
  return undefined;
}

function chunkToBuffer(item: unknown): Buffer {
  if (typeof item === 'string') {
    return Buffer.from(item, 'utf8');
  }
  if (item instanceof Uint8Array) {
    return Buffer.from(item.buffer, item.byteOffset, item.byteLength);
  }
  throw new TypeError(
    'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.',
  );
}

function concatChunks(chunks: readonly Buffer[]): Uint8Array {
  const joined = Buffer.concat(chunks);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

function isSyncIterable(value: object): value is Iterable<unknown> {
  return (
    Symbol.iterator in value &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

function isAsyncIterable(value: object): value is AsyncIterable<unknown> {
  return (
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

export async function toBytesAsync(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (data !== null && typeof data === 'object') {
    if (isSyncIterable(data)) {
      const chunks: Buffer[] = [];
      for (const item of data) {
        chunks.push(chunkToBuffer(item));
      }
      return concatChunks(chunks);
    }
    if (isAsyncIterable(data)) {
      if ('on' in data && typeof (data as { on?: unknown }).on === 'function') {
        (data as { on: (event: string, listener: () => void) => void }).on('error', () => {});
      }
      const chunks: Buffer[] = [];
      for await (const item of data) {
        chunks.push(chunkToBuffer(item));
      }
      return concatChunks(chunks);
    }
  }
  throw new TypeError(
    'The "data" argument must be of type string or an instance of Buffer or Uint8Array.',
  );
}

/**
 * Trigger `ToNumber` coercion on `options.end` in the same order as
 * `@google-cloud/storage` (`options.end < 0`), throwing `TypeError` on
 * uncoercible objects such as `Object.create(null)`.
 */
function probeEndNumericCoercion(rawEnd: unknown): void {
  void ((rawEnd as number) < 0);
}

export function normalizeDownloadOptions(rawOptions: unknown): DownloadOptions {
  if (typeof rawOptions === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.download returns a promise; the callback form is not supported.',
    );
  }
  if (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  const opts = rawOptions as Record<string, unknown>;
  const hasStart = typeof opts.start === 'number';
  const hasEnd = typeof opts.end === 'number';
  probeEndNumericCoercion(opts.end);
  const rangeRequest = hasStart || hasEnd;
  if (rangeRequest && (typeof opts.validation === 'string' || opts.validation === true)) {
    throw new Error('Cannot use validation with file ranges (start/end).');
  }
  const normalized: DownloadOptions = {};
  if (hasStart) {
    normalized.start = opts.start as number;
  }
  if (hasEnd) {
    normalized.end = opts.end as number;
  }
  if (typeof opts.validation === 'boolean' || opts.validation === 'md5' || opts.validation === 'crc32c') {
    normalized.validation = opts.validation;
  }
  return normalized;
}

/**
 * Normalize `DownloadOptions` (`start..end` inclusive, with negative `end`
 * treated as a trailing byte count matching `@google-cloud/storage`'s
 * `Range: bytes=-N` tail request). Returns `null` when the slice is empty.
 */
export function normalizeByteBounds(
  size: number,
  options: DownloadOptions,
): { start: number; endExclusive: number } | null {
  if (options.end !== undefined && options.end < 0) {
    const tailLength = Math.min(Math.trunc(-options.end) || 0, size);
    if (tailLength <= 0) return null;
    return { start: size - tailLength, endExclusive: size };
  }
  let rawStart = 0;
  if (options.start !== undefined) {
    rawStart = Math.trunc(options.start) || 0;
  }
  let rawEnd = size;
  if (options.end !== undefined) {
    rawEnd = Math.trunc(options.end + 1) || 0;
  }
  let start = Math.min(rawStart, size);
  if (rawStart < 0) {
    start = Math.max(size + rawStart, 0);
  }
  let endExclusive = Math.min(rawEnd, size);
  if (rawEnd < 0) {
    endExclusive = Math.max(size + rawEnd, 0);
  }
  if (endExclusive <= start) return null;
  return { start, endExclusive };
}

export function byteRange(bytes: Uint8Array, options: DownloadOptions): Uint8Array {
  const bounds = normalizeByteBounds(bytes.byteLength, options);
  if (bounds === null) return bytes.subarray(0, 0);
  return bytes.subarray(bounds.start, bounds.endExclusive);
}

export function normalizeCopyOptions(rawOptions: unknown): CopyOptions {
  if (typeof rawOptions === 'function') {
    throw new TypeError(
      'pyric-admin/storage: File.copy returns a promise; the callback form is not supported.',
    );
  }
  if (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  return rawOptions as CopyOptions;
}

/**
 * Resolve `File.copy` destination matching `@google-cloud/storage`
 * (`File.prototype.copy`).
 */
export function copyTargetOf(
  source: File,
  destination: CopyDestination,
  storage: Storage,
  isBucketHandle: (candidate: unknown) => candidate is Bucket,
  isFileHandle: (candidate: unknown) => candidate is File,
): File {
  if (!Boolean(destination)) {
    throw new Error('Destination file should have a name.');
  }
  if (typeof destination === 'string') {
    const urlMatch = GS_COPY_URL_RE.exec(destination);
    if (urlMatch !== null && urlMatch[1] !== undefined && urlMatch[2] !== undefined) {
      return storage.bucket(urlMatch[1]).file(urlMatch[2]);
    }
    return source.bucket.file(destination);
  }
  if (isBucketHandle(destination)) {
    return destination.file(source.name);
  }
  if (isFileHandle(destination)) {
    return destination;
  }
  throw new Error('Destination file should have a name.');
}

function probeNullPrototypeNumberCoercion(value: object): void {
  if (Object.getPrototypeOf(value) === null) {
    // `@google-cloud/storage` evaluates `isNaN(expires)`, which invokes
    // `ToNumber` and throws `TypeError` on null-prototype objects.
    Number(value);
  }
}

function normalizeExpires(rawExpires: unknown): number {
  if (rawExpires !== null && typeof rawExpires === 'object' && !(rawExpires instanceof Date)) {
    probeNullPrototypeNumberCoercion(rawExpires);
    throw new Error('The expiration date provided was invalid.');
  }
  if (rawExpires === undefined || rawExpires === null || typeof rawExpires === 'boolean') {
    throw new Error('The expiration date provided was invalid.');
  }
  if (typeof rawExpires === 'number') {
    if (!Number.isFinite(rawExpires)) {
      throw new Error('The expiration date provided was invalid.');
    }
    return rawExpires;
  }
  if (rawExpires instanceof Date) {
    const ms = rawExpires.getTime();
    if (Number.isNaN(ms)) {
      throw new Error('The expiration date provided was invalid.');
    }
    return ms;
  }
  if (typeof rawExpires === 'string') {
    if (rawExpires.trim().length === 0) {
      throw new Error('The expiration date provided was invalid.');
    }
    const ms = new Date(rawExpires).getTime();
    if (Number.isNaN(ms)) {
      throw new Error('The expiration date provided was invalid.');
    }
    return ms;
  }
  throw new Error('The expiration date provided was invalid.');
}

/**
 * Deterministic sandbox signed-URL stub shared by local and remote arms.
 */
export function stubSignedUrl(
  bucketName: string,
  path: string,
  rawOptions: GetSignedUrlOptions,
): string {
  if (rawOptions === null) {
    throw new TypeError('Cannot read properties of null (reading "action").');
  }
  if (rawOptions === undefined) {
    throw new Error('The expiration date provided was invalid.');
  }
  const rawRecord = rawOptions as unknown as { action?: unknown; expires?: unknown };
  let actionText = 'undefined';
  if (rawRecord.action !== undefined) {
    actionText = String(rawRecord.action);
  }
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new Error('The expiration date provided was invalid.');
  }
  const expiresMs = normalizeExpires(rawRecord.expires);
  return `pyric-sandbox-storage://${bucketName}/${path}?expires=${expiresMs}&action=${actionText}`;
}
