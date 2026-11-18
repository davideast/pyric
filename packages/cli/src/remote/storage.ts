/**
 * Admin-lens Storage conveniences over a remote sandbox channel.
 *
 * Every call pins `actAs: { mode: 'admin' }` (firebase-admin rules-bypass
 * semantics). A host with an HTTP byte route transfers bytes there without a
 * frame cap; a host without one uses base64 frames capped at
 * `MAX_STORAGE_OP_BYTES` (8 MiB).
 */
import type { FullMetadata } from 'pyric/storage';
import {
  fetchFromByteRoute,
  uploadOverByteRoute,
  type RemoteByteRoute,
  type RemoteUploadRequest,
} from 'pyric/storage/internal';
import type { WorkerOpPayload } from '../bridge/protocol.js';
import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../serve/worker/protocol.js';

const ADMIN_LENS = { mode: 'admin' } as const;

export interface RemoteStorageChannel {
  op(payload: WorkerOpPayload): Promise<unknown>;
  byteRoute?(): Promise<RemoteByteRoute | undefined>;
}

/**
 * Thin Storage conveniences over the channel: bytes plus browse and metadata.
 * Every call pins `actAs: { mode: 'admin' }`; use the raw `channel` for lensed
 * (rules-evaluated) access.
 */
export interface RemoteStorage {
  /** Upload `data` at `path` (replaces any existing object) and return its `FullMetadata`. */
  putBytes(
    path: string,
    data: Uint8Array,
    options?: { contentType?: string; metadata?: Record<string, unknown> },
  ): Promise<FullMetadata>;
  /** Download the object's bytes; rejects `storage/object-not-found` when absent. */
  getBytes(path: string): Promise<Buffer>;
  /** Delete the object at `path`. Idempotent (missing = no-op). */
  deleteObject(path: string): Promise<void>;
  /** Read the object's `FullMetadata`. */
  getMetadata(path: string): Promise<FullMetadata>;
  /** True when an object exists at `path`, false when `storage/object-not-found`. */
  exists(path: string): Promise<boolean>;
  /** Enumerate immediate child items and prefixes under `path`. */
  listAll(path: string): Promise<{
    items: Array<{ fullPath: string; name: string }>;
    prefixes: Array<{ fullPath: string; name: string }>;
  }>;
}

function isStorageObjectNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'storage/object-not-found';
}

export function buildRemoteStorage(channel: RemoteStorageChannel): RemoteStorage {
  return {
    async putBytes(path, data, options) {
      const route = await channel.byteRoute?.();
      if (route !== undefined) {
        const operations = {
          op: (payload: { method: string }) => channel.op(payload as WorkerOpPayload),
        };
        const uploadReq: RemoteUploadRequest = {
          path,
          data: new Blob([data as Uint8Array<ArrayBuffer>]),
          actAs: ADMIN_LENS,
        };
        if (options?.contentType !== undefined) {
          uploadReq.contentType = options.contentType;
        }
        if (options?.metadata !== undefined) {
          uploadReq.metadata = options.metadata;
        }
        return (await uploadOverByteRoute(operations, route, uploadReq)) as FullMetadata;
      }
      if (data.byteLength > MAX_STORAGE_OP_BYTES) {
        throw storagePayloadTooLarge(data.byteLength, `storage payload for '${path}'`);
      }
      const putOp: WorkerOpPayload = {
        method: 'storage.putBytes',
        path,
        dataB64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
        actAs: ADMIN_LENS,
      };
      if (options?.contentType !== undefined) {
        putOp.contentType = options.contentType;
      }
      if (options?.metadata !== undefined) {
        putOp.metadata = options.metadata;
      }
      return (await channel.op(putOp)) as FullMetadata;
    },
    async getBytes(path) {
      const route = await channel.byteRoute?.();
      if (route !== undefined) {
        const metadata = await this.getMetadata(path);
        const response = await fetchFromByteRoute(route, { bucket: metadata.bucket, path });
        return Buffer.from(await response.arrayBuffer());
      }
      const res = (await channel.op({
        method: 'storage.getBytes',
        path,
        actAs: ADMIN_LENS,
      })) as { dataB64: string };
      return Buffer.from(res.dataB64, 'base64');
    },
    async deleteObject(path) {
      try {
        await channel.op({ method: 'storage.deleteObject', path, actAs: ADMIN_LENS });
      } catch (err) {
        if (!isStorageObjectNotFound(err)) {
          throw err;
        }
      }
    },
    async getMetadata(path) {
      return (await channel.op({
        method: 'storage.getMetadata',
        path,
        actAs: ADMIN_LENS,
      })) as FullMetadata;
    },
    async exists(path) {
      try {
        await this.getMetadata(path);
        return true;
      } catch (err) {
        if (isStorageObjectNotFound(err)) return false;
        throw err;
      }
    },
    async listAll(path) {
      return (await channel.op({
        method: 'storage.listAll',
        path,
        actAs: ADMIN_LENS,
      })) as {
        items: Array<{ fullPath: string; name: string }>;
        prefixes: Array<{ fullPath: string; name: string }>;
      };
    },
  };
}
