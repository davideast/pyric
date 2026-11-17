/**
 * Offline differential oracle for installed `firebase-admin/storage`
 * (`v13.10.0`) + `@google-cloud/storage` (`v7.21.0`).
 *
 * Runs the real `firebase-admin/storage` and `@google-cloud/storage` classes
 * with an in-memory 2048-bit RSA `cert(...)` credential (`autoRetry: false`)
 * and an intercepted `makeAuthenticatedRequest` + upload sink so zero network
 * sockets are opened under `unshare -rn`.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import {
  cert,
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
  type App as UpstreamApp,
} from 'firebase-admin/app';
import {
  getDownloadURL as getUpstreamDownloadURL,
  getStorage as getUpstreamStorage,
  type Storage as UpstreamStorage,
} from 'firebase-admin/storage';

export interface NormalizedStorageOutcome {
  readonly accepted: boolean;
  readonly acceptedPreflight?: boolean;
  readonly errorKind?:
    | 'TypeError'
    | 'RangeError'
    | 'FirebaseError'
    | 'DeferredApiError'
    | 'NotImplementedError'
    | 'CallbackUnsupportedError'
    | 'OtherError';
  readonly code?: string;
  readonly message?: string;
}

const cachedRsaKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function hasStringCode(error: unknown): error is { code: string; message?: unknown } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

function isDeferredApiError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PyricDeferredApiError';
}

function isNotImplementedStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('not implemented in pyric-admin/storage');
}

function isCallbackUnsupportedError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return error.message.includes('callback form is not supported');
}

export function classifyStorageError(error: unknown): {
  errorKind: NonNullable<NormalizedStorageOutcome['errorKind']>;
  code?: string;
  message: string;
} {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  if (isCallbackUnsupportedError(error)) {
    return { errorKind: 'CallbackUnsupportedError', message };
  }
  if (error instanceof TypeError) {
    return { errorKind: 'TypeError', message };
  }
  if (error instanceof RangeError) {
    return { errorKind: 'RangeError', message };
  }
  if (isDeferredApiError(error)) {
    return { errorKind: 'DeferredApiError', message };
  }
  if (isNotImplementedStorageError(error)) {
    return { errorKind: 'NotImplementedError', message };
  }
  if (hasStringCode(error) && error.code.startsWith('app/') || hasStringCode(error) && error.code.startsWith('storage/')) {
    return { errorKind: 'FirebaseError', code: error.code, message };
  }
  return {
    errorKind: 'OtherError',
    code: hasStringCode(error) ? error.code : undefined,
    message,
  };
}

function readFlag(fn?: () => boolean): boolean | undefined {
  if (fn === undefined) return undefined;
  return fn();
}

export async function captureStorageOutcome(
  invoke: () => unknown,
  didReachTransport?: () => boolean,
): Promise<NormalizedStorageOutcome> {
  try {
    await invoke();
    return {
      accepted: true,
      acceptedPreflight: readFlag(didReachTransport),
    };
  } catch (error) {
    const info = classifyStorageError(error);
    return {
      accepted: false,
      acceptedPreflight: readFlag(didReachTransport),
      errorKind: info.errorKind,
      code: info.code,
      message: info.message,
    };
  }
}

interface StoredWireObject {
  bucket: string;
  name: string;
  bytes: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  downloadTokens?: string;
}

export interface OfflineUpstreamStorageHarness {
  readonly app: UpstreamApp;
  readonly svc: UpstreamStorage;
  readonly getDownloadURL: typeof getUpstreamDownloadURL;
  readonly resetState: (seedObjects: ReadonlyArray<{
    bucket: string;
    name: string;
    content: string;
    contentType?: string;
    downloadTokens?: string;
  }>) => void;
  readonly resetTransportFlag: () => void;
  readonly didReachTransport: () => boolean;
  readonly dispose: () => Promise<void>;
}

let upstreamStorageSeq = 0;
let patchedGcsFilePrototype = false;
const activeWriteSinkByStorage = new WeakMap<
  object,
  (bucket: string, name: string, data: Buffer) => void
>();
const transportHookByStorage = new WeakMap<object, () => void>();

function ensureGcsWriteStreamPatched(sampleFile: object): void {
  if (patchedGcsFilePrototype) return;
  const proto = Object.getPrototypeOf(sampleFile) as {
    createWriteStream: (options?: Record<string, unknown>) => Writable;
  };
  const origCreateWriteStream = proto.createWriteStream;
  proto.createWriteStream = function patchedCreateWriteStream(
    this: { bucket: { name: string }; name: string; storage: object },
    options?: Record<string, unknown>,
  ): Writable {
    const preflightProbe = origCreateWriteStream.call(this, options);
    preflightProbe.on('error', () => {});
    preflightProbe.destroy();

    transportHookByStorage.get(this.storage)?.();
    const chunks: Buffer[] = [];
    const sink = activeWriteSinkByStorage.get(this.storage);
    const bucketName = this.bucket.name;
    const objectName = this.name;
    return new Writable({
      write(chunk: Buffer | string, encoding, cb) {
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, encoding));
        } else {
          chunks.push(Buffer.from(chunk));
        }
        cb();
      },
      final(cb) {
        sink?.(bucketName, objectName, Buffer.concat(chunks));
        cb();
      },
    });
  };
  patchedGcsFilePrototype = true;
}

function parseObjectRoute(uri: string): {
  bucket: string;
  objectName?: string;
  copyDestBucket?: string;
  copyDestObject?: string;
  isFirebaseV0?: boolean;
} | null {
  const v0Match = /\/v0\/b\/([^/]+)\/o\/([^?]+)/.exec(uri);
  if (v0Match !== null) {
    return {
      bucket: decodeURIComponent(v0Match[1] ?? ''),
      objectName: decodeURIComponent(v0Match[2] ?? ''),
      isFirebaseV0: true,
    };
  }
  const rewriteMatch = /\/b\/([^/]+)\/o\/([^/]+)\/rewriteTo\/b\/([^/]+)\/o\/([^?]+)/.exec(uri);
  if (rewriteMatch !== null) {
    return {
      bucket: decodeURIComponent(rewriteMatch[1] ?? ''),
      objectName: decodeURIComponent(rewriteMatch[2] ?? ''),
      copyDestBucket: decodeURIComponent(rewriteMatch[3] ?? ''),
      copyDestObject: decodeURIComponent(rewriteMatch[4] ?? ''),
    };
  }
  const objMatch = /\/b\/([^/]+)\/o\/([^?]+)/.exec(uri);
  if (objMatch !== null) {
    return {
      bucket: decodeURIComponent(objMatch[1] ?? ''),
      objectName: decodeURIComponent(objMatch[2] ?? ''),
    };
  }
  const listMatch = /\/b\/([^/]+)\/o(?:\?|$)/.exec(uri);
  if (listMatch !== null) {
    return {
      bucket: decodeURIComponent(listMatch[1] ?? ''),
    };
  }
  return null;
}

export function createOfflineUpstreamStorageHarness(
  storageBucket?: string,
): OfflineUpstreamStorageHarness {
  const appOptions: {
    projectId: string;
    storageBucket?: string;
    credential: ReturnType<typeof cert>;
  } = {
    projectId: 'demo-project',
    credential: cert({
      projectId: 'demo-project',
      clientEmail: 'svc@demo-project.iam.gserviceaccount.com',
      privateKey: cachedRsaKey.privateKey,
    }),
  };
  if (storageBucket !== undefined) appOptions.storageBucket = storageBucket;
  const app = initializeUpstreamApp(
    appOptions,
    `upstream-storage-diff-${++upstreamStorageSeq}`,
  );
  const svc = getUpstreamStorage(app);
  const gcsClient = (svc as unknown as { storageClient: Record<string, unknown> }).storageClient;
  (gcsClient.retryOptions as { autoRetry: boolean }).autoRetry = false;

  const probeBucket = svc.bucket('probe-init-bucket');
  const probeFile = probeBucket.file('probe-init-file') as unknown as {
    crc32cGenerator: () => { update: (buf: Buffer) => void; toString: () => string };
  };
  ensureGcsWriteStreamPatched(probeFile);

  let reachedTransport = false;
  const objects = new Map<string, StoredWireObject>();
  const keyOf = (bucket: string, name: string): string => `${bucket}\0${name}`;

  transportHookByStorage.set(gcsClient, () => {
    reachedTransport = true;
  });
  activeWriteSinkByStorage.set(gcsClient, (bucket, name, bytes) => {
    objects.set(keyOf(bucket, name), { bucket, name, bytes });
  });
  (gcsClient.authClient as { request: () => Promise<unknown> }).request = async () => {
    reachedTransport = true;
    return {
      headers: {
        location:
          'https://storage.googleapis.com/upload/storage/v1/b/stub/o?uploadType=resumable&upload_id=stub',
      },
      data: '',
    };
  };

  const toGcsMetadata = (entry: StoredWireObject): Record<string, unknown> => {
    const meta: Record<string, unknown> = {
      kind: 'storage#object',
      name: entry.name,
      bucket: entry.bucket,
      size: String(entry.bytes.byteLength),
      generation: '1',
      metageneration: '1',
      timeCreated: '2026-06-01T12:00:00.000Z',
      updated: '2026-06-01T12:00:00.000Z',
    };
    if (entry.contentType !== undefined) meta.contentType = entry.contentType;
    if (entry.metadata !== undefined) meta.metadata = entry.metadata;
    return meta;
  };

  gcsClient.makeAuthenticatedRequest = (
    reqOpts: { method?: string; uri?: string; qs?: Record<string, unknown>; json?: unknown },
    callback?: (err: Error | null, body?: unknown, resp?: unknown) => void,
  ) => {
    reachedTransport = true;
    const method = (reqOpts.method ?? 'GET').toUpperCase();
    const uri = reqOpts.uri ?? '';
    const route = parseObjectRoute(uri);

    if (typeof callback === 'function') {
      queueMicrotask(() => {
        if (route === null || route.bucket.length === 0) {
          const invalidBucketErr = Object.assign(new Error('Bucket is required.'), { code: 400 });
          callback(invalidBucketErr);
          return;
        }
        if (route.isFirebaseV0 === true) {
          const hit = objects.get(keyOf(route.bucket, route.objectName ?? ''));
          if (hit === undefined) {
            callback(Object.assign(new Error(`No such object: ${route.bucket}/${route.objectName}`), { code: 404 }));
            return;
          }
          callback(null, {
            name: hit.name,
            bucket: hit.bucket,
            downloadTokens: hit.downloadTokens ?? 'minted-upstream-token',
          });
          return;
        }
        if (route.copyDestBucket !== undefined && route.copyDestObject !== undefined) {
          const src = objects.get(keyOf(route.bucket, route.objectName ?? ''));
          if (src === undefined) {
            callback(Object.assign(new Error(`No such object: ${route.bucket}/${route.objectName}`), { code: 404 }));
            return;
          }
          const copied: StoredWireObject = {
            bucket: route.copyDestBucket,
            name: route.copyDestObject,
            bytes: Buffer.from(src.bytes),
            contentType: src.contentType,
          };
          objects.set(keyOf(copied.bucket, copied.name), copied);
          callback(
            null,
            { kind: 'storage#rewriteResponse', done: true, resource: toGcsMetadata(copied) },
            { statusCode: 200, headers: {} },
          );
          return;
        }
        if (route.objectName === undefined) {
          const prefix = typeof reqOpts.qs?.prefix === 'string' ? reqOpts.qs.prefix : '';
          const items = [...objects.values()]
            .filter((entry) => entry.bucket === route.bucket && entry.name.startsWith(prefix))
            .map(toGcsMetadata);
          callback(null, { kind: 'storage#objects', items }, { statusCode: 200, headers: {} });
          return;
        }
        const targetKey = keyOf(route.bucket, route.objectName);
        const existing = objects.get(targetKey);
        if (method === 'DELETE') {
          objects.delete(targetKey);
          callback(null, {}, { statusCode: 204, headers: {} });
          return;
        }
        if (method === 'PATCH') {
          if (
            reqOpts.json === null ||
            typeof reqOpts.json !== 'object' ||
            Array.isArray(reqOpts.json)
          ) {
            callback(Object.assign(new Error('Invalid JSON payload received.'), { code: 400 }));
            return;
          }
          if (existing === undefined) {
            callback(Object.assign(new Error(`No such object: ${route.bucket}/${route.objectName}`), { code: 404 }));
            return;
          }
          callback(null, toGcsMetadata(existing), { statusCode: 200, headers: {} });
          return;
        }
        if (existing === undefined) {
          callback(Object.assign(new Error(`No such object: ${route.bucket}/${route.objectName}`), { code: 404 }));
          return;
        }
        callback(null, toGcsMetadata(existing), { statusCode: 200, headers: {} });
      });
      return undefined;
    }

    const stream = new PassThrough() as PassThrough & { abort: () => void };
    stream.abort = () => stream.destroy();
    queueMicrotask(() => {
      let hit: StoredWireObject | undefined;
      if (route !== null && route.objectName !== undefined) {
        hit = objects.get(keyOf(route.bucket, route.objectName));
      }
      if (hit === undefined) {
        const missingStream = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
          toJSON: () => { headers: Record<string, string> };
        };
        missingStream.statusCode = 404;
        missingStream.headers = {};
        missingStream.toJSON = () => ({ headers: {} });
        stream.emit('error', Object.assign(new Error('No such object'), { code: 404 }));
        return;
      }
      const crc = probeFile.crc32cGenerator();
      crc.update(hit.bytes);
      const md5 = createHash('md5').update(hit.bytes).digest('base64');
      const fakeRes = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        toJSON: () => { headers: Record<string, string> };
      };
      fakeRes.statusCode = 200;
      fakeRes.headers = {
        'x-goog-stored-content-encoding': 'identity',
        'x-goog-hash': `crc32c=${crc.toString()},md5=${md5}`,
      };
      fakeRes.toJSON = () => ({ headers: fakeRes.headers });
      stream.emit('response', fakeRes);
      fakeRes.end(hit.bytes);
      stream.end(hit.bytes);
    });
    return stream;
  };

  return {
    app,
    svc,
    getDownloadURL: getUpstreamDownloadURL,
    resetState(seedObjects) {
      objects.clear();
      for (const seed of seedObjects) {
        objects.set(keyOf(seed.bucket, seed.name), {
          bucket: seed.bucket,
          name: seed.name,
          bytes: Buffer.from(seed.content, 'utf8'),
          contentType: seed.contentType,
          downloadTokens: seed.downloadTokens,
        });
      }
    },
    resetTransportFlag() {
      reachedTransport = false;
    },
    didReachTransport() {
      return reachedTransport;
    },
    async dispose() {
      activeWriteSinkByStorage.delete(gcsClient);
      transportHookByStorage.delete(gcsClient);
      await deleteUpstreamApp(app).catch(() => {});
    },
  };
}

function isPastValidExpirationInput(expires: unknown): boolean {
  if (typeof expires === 'number') {
    return Number.isFinite(expires);
  }
  if (expires instanceof Date) {
    return !Number.isNaN(expires.getTime());
  }
  if (typeof expires === 'string' && expires.trim().length > 0) {
    return !Number.isNaN(Date.parse(expires));
  }
  return false;
}

export function isDocumentedStorageSandboxDivergence(
  methodName: string,
  rawArgs: readonly unknown[],
  upstream: NormalizedStorageOutcome,
  pyric: NormalizedStorageOutcome,
): boolean {
  // 1. `File.move` is a documented deferred member (`FILE_DEFERRED_MEMBERS` in `deferred-members.ts`).
  if (methodName === 'move' && pyric.errorKind === 'DeferredApiError') {
    return true;
  }

  // 1b. `Storage.bucket(name)` front-loads empty-after-stripping rejection (`'gs://'`, `'/'`)
  //     with `storage/invalid-argument` instead of deferring to HTTP 400 (`firestore-storage-backend-parity.test.ts:540`).
  if (
    methodName === 'bucket' &&
    upstream.accepted &&
    pyric.code === 'storage/invalid-argument' &&
    typeof rawArgs[0] === 'string' &&
    rawArgs[0].replace(/^gs:\/\//, '').replace(/\/+$/, '').length === 0
  ) {
    return true;
  }

  // 2. `File.setMetadata` and `File.createResumableUpload` (without an HTTP byte route)
  //    explicitly reject with `NotImplementedError` once client-side preflight succeeds.
  if (
    (methodName === 'setMetadata' || methodName === 'createResumableUpload') &&
    upstream.acceptedPreflight === true &&
    pyric.errorKind === 'NotImplementedError'
  ) {
    return true;
  }

  // 3. `Bucket.getFiles(fn)` / `Bucket.deleteFiles(fn)` / `File.download(fn)`
  //    explicitly reject callback-style invocation (`file-query.ts:51`).
  if (
    typeof rawArgs[0] === 'function' &&
    pyric.errorKind === 'CallbackUnsupportedError'
  ) {
    return true;
  }

  // 4. `File.getSignedUrl` intentionally embeds valid numeric/Date/ISO past timestamps
  //    without wall-clock rejection for deterministic fixtures (`storage.test.ts:126`).
  if (
    methodName === 'getSignedUrl' &&
    !upstream.accepted &&
    upstream.message === 'An expiration date cannot be in the past.' &&
    pyric.accepted
  ) {
    const cfg = rawArgs[0] as { expires?: unknown } | null | undefined;
    if (cfg !== null && typeof cfg === 'object' && isPastValidExpirationInput(cfg.expires)) {
      return true;
    }
  }

  // 5. `pyric-admin/storage` shares its object store with `pyric/storage` (`ref()`),
  //    which rejects malformed `^[A-Za-z]+://` URL-scheme strings with `storage/invalid-url`.
  if (
    methodName === 'copy' &&
    upstream.accepted &&
    pyric.code === 'storage/invalid-url' &&
    typeof rawArgs[0] === 'string' &&
    /^[A-Za-z]+:\/\//.test(rawArgs[0])
  ) {
    return true;
  }

  return false;
}
