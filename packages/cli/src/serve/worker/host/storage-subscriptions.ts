/**
 * Read-only Storage mutation subscription on the worker host for Cloud
 * Functions triggers.
 *
 * Listens on the existing `ctx.sandbox.onEvent` stream and relays each
 * committed `storage` service mutation (`object_put`, `metadata_update`,
 * `object_delete`) as a JSON-safe `snap` message after computing RFC 3720
 * Castagnoli `crc32c` over the stored object bytes.
 */
import { FirebaseError } from 'pyric/app';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  DEFAULT_BUCKET,
  arrayBufferToBase64,
  cloneCustomMetadata,
  getAdminStorageSandbox,
  getStorageService,
  type StoredMetadata,
} from 'pyric/storage/internal';
import { post, type HostCtx, type PortLike } from '../host-context.js';
import { serializeError, type StorageSubMessage } from '../protocol.js';
import { defaultBucketNames, storeBucketOf } from './storage.js';

const CRC_SLICE_BYTES = 64 * 1024;
const MAX_CACHED_CRC_ENTRIES = 512;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) !== 0) {
        crc = 0x82f63b78 ^ (crc >>> 1);
      } else {
        crc = crc >>> 1;
      }
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

const EMPTY_CRC32C_BASE64 = 'AAAAAA==';

const crcCacheByHost = new WeakMap<HostCtx, Map<string, string>>();

interface StorageMutationObjectWire {
  fullPath: string;
  bucket: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  size: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: Record<string, string>;
  downloadTokens?: string;
  md5Hash?: string;
  crc32c: string;
  etag?: string;
}

export type StorageSubscriptionSnapWire =
  | {
      kind: 'ready';
      defaultBucket: string;
    }
  | {
      kind: 'mutation';
      op: 'object_put' | 'metadata_update' | 'object_delete';
      storeBucket: string;
      bucketName: string;
      path: string;
      at: number;
      rollback: boolean;
      before?: StorageMutationObjectWire;
      after?: StorageMutationObjectWire;
    };

function crcCacheFor(ctx: HostCtx): Map<string, string> {
  let cache = crcCacheByHost.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    crcCacheByHost.set(ctx, cache);
  }
  return cache;
}

function rememberCrc32c(ctx: HostCtx, key: string, crc32c: string): void {
  const cache = crcCacheFor(ctx);
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, crc32c);
  while (cache.size > MAX_CACHED_CRC_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function crcCacheKey(storeBucket: string, path: string, generation: string): string {
  return `${storeBucket}/${path}#${generation}`;
}

async function computeBlobCrc32cBase64(blob: Blob): Promise<string> {
  if (blob.size === 0) return EMPTY_CRC32C_BASE64;
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += CRC_SLICE_BYTES) {
    const end = Math.min(offset + CRC_SLICE_BYTES, blob.size);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index] ?? 0;
      const lookup = CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0;
      crc = lookup ^ (crc >>> 8);
    }
  }
  const finalized = (crc ^ 0xffffffff) >>> 0;
  const bigEndian = new Uint8Array([
    (finalized >>> 24) & 0xff,
    (finalized >>> 16) & 0xff,
    (finalized >>> 8) & 0xff,
    finalized & 0xff,
  ]);
  return arrayBufferToBase64(bigEndian.buffer as ArrayBuffer);
}

async function resolveStoredCrc32c(
  ctx: HostCtx,
  storeBucket: string,
  metadata: StoredMetadata,
  allowBlobRead: boolean,
): Promise<string> {
  const key = crcCacheKey(storeBucket, metadata.fullPath, metadata.generation);
  if (typeof metadata.crc32c === 'string' && metadata.crc32c.length > 0) {
    rememberCrc32c(ctx, key, metadata.crc32c);
    return metadata.crc32c;
  }
  const cached = crcCacheFor(ctx).get(key);
  if (cached !== undefined) return cached;
  if (metadata.size === 0) {
    rememberCrc32c(ctx, key, EMPTY_CRC32C_BASE64);
    return EMPTY_CRC32C_BASE64;
  }
  if (!allowBlobRead) return EMPTY_CRC32C_BASE64;
  try {
    const adminStorage = getAdminStorageSandbox(ctx.sandbox, { bucket: storeBucket });
    const service = await getStorageService(adminStorage);
    const object = await service.backend.getObject(metadata.fullPath, storeBucket);
    if (object === undefined || object.metadata.generation !== metadata.generation) {
      return EMPTY_CRC32C_BASE64;
    }
    const crc32c = await computeBlobCrc32cBase64(object.blob);
    rememberCrc32c(ctx, key, crc32c);
    return crc32c;
  } catch {
    // Observational fallback if a concurrent delete removed the object first.
    return EMPTY_CRC32C_BASE64;
  }
}

function toWireObject(
  stored: StoredMetadata,
  bucketName: string,
  crc32c: string,
): StorageMutationObjectWire {
  const out: StorageMutationObjectWire = {
    fullPath: stored.fullPath,
    bucket: bucketName,
    generation: stored.generation,
    metageneration: stored.metageneration,
    timeCreated: stored.timeCreated,
    updated: stored.updated,
    size: stored.size,
    crc32c,
  };
  if (stored.contentType !== undefined) out.contentType = stored.contentType;
  if (stored.cacheControl !== undefined) out.cacheControl = stored.cacheControl;
  if (stored.contentDisposition !== undefined) out.contentDisposition = stored.contentDisposition;
  if (stored.contentEncoding !== undefined) out.contentEncoding = stored.contentEncoding;
  if (stored.contentLanguage !== undefined) out.contentLanguage = stored.contentLanguage;
  if (stored.customMetadata !== undefined) {
    const cloned = cloneCustomMetadata(stored.customMetadata);
    if (cloned !== undefined) out.customMetadata = cloned;
  }
  if (stored.downloadTokens !== undefined) out.downloadTokens = stored.downloadTokens;
  if (stored.md5Hash !== undefined) out.md5Hash = stored.md5Hash;
  if (stored.etag !== undefined) out.etag = stored.etag;
  return out;
}

function resolveDefaultBucketDisplayName(ctx: HostCtx, fallbackDefaultBucket?: string): string {
  const configured = ctx.appOptions?.storageBucket;
  if (typeof configured === 'string' && configured !== '' && configured !== DEFAULT_BUCKET) {
    return configured;
  }
  for (const alias of defaultBucketNames(ctx)) {
    if (alias !== '' && alias !== DEFAULT_BUCKET) return alias;
  }
  if (typeof fallbackDefaultBucket === 'string' && fallbackDefaultBucket !== '') {
    return fallbackDefaultBucket;
  }
  return DEFAULT_BUCKET;
}

function resolveBucketDisplayName(
  ctx: HostCtx,
  storeBucket: string,
  fallbackDefaultBucket?: string,
): string {
  if (storeBucket === DEFAULT_BUCKET) {
    return resolveDefaultBucketDisplayName(ctx, fallbackDefaultBucket);
  }
  return storeBucket;
}

interface StorageServiceMutationShape {
  kind: 'service_mutation';
  service: 'storage';
  op: 'object_put' | 'metadata_update' | 'object_delete';
  at: number;
  path: string;
  before?: StoredMetadata;
  after?: StoredMetadata;
  detail?: Record<string, unknown>;
}

function isStorageMutationEvent(event: SandboxEvent): event is SandboxEvent & StorageServiceMutationShape {
  if (event.kind !== 'service_mutation') return false;
  if (event.service !== 'storage') return false;
  return (
    event.op === 'object_put' ||
    event.op === 'metadata_update' ||
    event.op === 'object_delete'
  );
}

function ensurePortSubs(ctx: HostCtx, port: PortLike): Map<string, () => void> {
  let portSubs = ctx.subs.get(port);
  if (portSubs === undefined) {
    portSubs = new Map();
    ctx.subs.set(port, portSubs);
  }
  return portSubs;
}

function resolveMutationRawBucket(
  event: StorageServiceMutationShape,
  detail: Record<string, unknown>,
): string {
  const detailBucket = detail.bucket;
  if (typeof detailBucket === 'string' && detailBucket !== '') {
    return detailBucket;
  }
  if (event.after?.bucket !== undefined && event.after.bucket !== '') {
    return event.after.bucket;
  }
  if (event.before?.bucket !== undefined && event.before.bucket !== '') {
    return event.before.bucket;
  }
  return DEFAULT_BUCKET;
}

export function handleStorageSub(ctx: HostCtx, port: PortLike, msg: StorageSubMessage): void {
  const portSubs = ensurePortSubs(ctx, port);
  if (portSubs.has(msg.subId)) return;

  if (msg.actAs?.mode !== 'admin') {
    const error = new FirebaseError(
      'storage/unauthorized',
      'Storage trigger subscriptions require the admin lens.',
    );
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(error) } });
    return;
  }

  const fallbackDefault = msg.target.defaultBucket;

  let closed = false;
  let queue = Promise.resolve();
  const stopOnEvent = ctx.sandbox.onEvent((event) => {
    if (closed || !isStorageMutationEvent(event)) return;
    const detail = event.detail ?? {};
    const rawBucket = resolveMutationRawBucket(event, detail);
    const storeBucket = storeBucketOf(ctx, rawBucket);
    if (msg.target.bucket !== undefined) {
      const requestedStoreBucket = storeBucketOf(ctx, msg.target.bucket);
      if (storeBucket !== requestedStoreBucket) return;
    }

    const bucketName = resolveBucketDisplayName(ctx, storeBucket, fallbackDefault);
    const isRollback = detail.rollback === true;
    const beforeMeta = event.before;
    const afterMeta = event.after;
    const op = event.op;
    const path = event.path;
    const at = event.at;

    queue = queue.then(async () => {
      if (closed) return;
      let beforeWire: StorageMutationObjectWire | undefined;
      if (beforeMeta !== undefined) {
        const beforeCrc = await resolveStoredCrc32c(ctx, storeBucket, beforeMeta, false);
        beforeWire = toWireObject(beforeMeta, bucketName, beforeCrc);
      }
      let afterWire: StorageMutationObjectWire | undefined;
      if (afterMeta !== undefined) {
        const afterCrc = await resolveStoredCrc32c(ctx, storeBucket, afterMeta, true);
        afterWire = toWireObject(afterMeta, bucketName, afterCrc);
      }
      if (closed) return;
      const payload: StorageSubscriptionSnapWire = {
        kind: 'mutation',
        op,
        storeBucket,
        bucketName,
        path,
        at,
        rollback: isRollback,
      };
      if (beforeWire !== undefined) payload.before = beforeWire;
      if (afterWire !== undefined) payload.after = afterWire;
      post(port, { t: 'snap', subId: msg.subId, value: payload });
    }).catch(() => {
      // Observational stream: never reject unhandled on background fan-out.
    });
  });

  portSubs.set(msg.subId, () => {
    closed = true;
    stopOnEvent();
  });

  const readySnap: StorageSubscriptionSnapWire = {
    kind: 'ready',
    defaultBucket: resolveDefaultBucketDisplayName(ctx, fallbackDefault),
  };
  post(port, { t: 'snap', subId: msg.subId, value: readySnap });
}
