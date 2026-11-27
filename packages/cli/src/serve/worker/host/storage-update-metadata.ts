/**
 * Client-plane `storage.updateMetadata` handler for the SharedWorker host.
 *
 * Evaluates Storage `allow update` rules directly under the caller's active
 * auth lens (via `pyric/storage`'s `updateMetadata`), preventing native client
 * SDKs from escalating to the admin lens or probing `allow create` via uploads.
 */
import { FirebaseError } from 'pyric/app';
import type { AuthLens } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  getStorageSandbox,
  ref as storageRef,
  updateMetadata as storageUpdateMetadata,
  type FirebaseStorage,
  type SettableMetadata,
} from 'pyric/storage';
import {
  DEFAULT_BUCKET,
  bindStorageOperationContext,
  getAdminStorageSandbox,
  getStorageService,
  nameStorageBucket,
} from 'pyric/storage/internal';

import { portSession } from '../host-auth.js';
import {
  bestEffortFlush,
  fail,
  ok,
  type HostCtx,
  type PortLike,
} from '../host-context.js';
import type { OpMessage, StorageBucketWire } from '../protocol.js';
import { authStateForLens, lensCacheKey, opProvenance, sessionCacheKey } from './core.js';
import { storeBucketOf } from './storage.js';

type UpdateMetadataOpMessage = Extract<OpMessage, { method: 'storage.updateMetadata' }>;

const SETTABLE_HEADER_KEYS = [
  'contentType',
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
] as const;

function defineOwnKey(target: Record<string, string | null>, key: string, value: string | null): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function resolveBucketName(ctx: HostCtx, msg: StorageBucketWire, stored: string): string {
  const named = msg.bucket ?? msg.defaultBucket;
  if (named !== undefined && named !== '') return named;
  const configured = ctx.appOptions?.storageBucket;
  if (stored === DEFAULT_BUCKET && typeof configured === 'string' && configured !== '') {
    return configured;
  }
  return stored;
}

function resolveLensStorage(
  ctx: HostCtx,
  actAs: AuthLens | undefined,
  port: PortLike,
  bucket: string,
): FirebaseStorage {
  const isNamedBucket = bucket !== DEFAULT_BUCKET;
  const bucketOpts = isNamedBucket ? { bucket } : undefined;
  if (actAs?.mode === 'admin') {
    if (isNamedBucket) return getAdminStorageSandbox(ctx.sandbox, bucketOpts);
    return (ctx.adminStorage ??= getAdminStorageSandbox(ctx.sandbox));
  }
  if (!actAs || actAs.mode === 'app-session') {
    const session = portSession(ctx, port);
    if (!isNamedBucket) {
      if (!session) {
        return (ctx.storage ??= getStorageSandbox(bindOperationContext(ctx.sandbox.withAuth(null), {
          source: { kind: 'app' },
          authLens: { mode: 'app-session' },
        })));
      }
      const key = sessionCacheKey(session);
      const handles = (ctx.sessionStorages ??= new Map());
      let handle = handles.get(key);
      if (!handle) {
        handle = getStorageSandbox(ctx.sandbox.withAuth(session.state));
        handles.set(key, handle);
      }
      return handle;
    }
    const handles = (ctx.bucketStorages ??= new Map());
    const lensKey = session ? `session:${sessionCacheKey(session)}` : 'app';
    const cacheKey = `${bucket}\u0000${lensKey}`;
    let handle = handles.get(cacheKey);
    if (!handle) {
      handle = session
        ? getStorageSandbox(ctx.sandbox.withAuth(session.state), bucketOpts)
        : getStorageSandbox(bindOperationContext(ctx.sandbox.withAuth(null), {
            source: { kind: 'app' },
            authLens: { mode: 'app-session' },
          }), bucketOpts);
      handles.set(cacheKey, handle);
    }
    return handle;
  }
  if (actAs.mode === 'anon') {
    if (!isNamedBucket) {
      return (ctx.anonStorage ??= getStorageSandbox(ctx.sandbox.withAuth(null)));
    }
    const handles = (ctx.bucketStorages ??= new Map());
    const cacheKey = `${bucket}\u0000anon`;
    let handle = handles.get(cacheKey);
    if (!handle) {
      handle = getStorageSandbox(ctx.sandbox.withAuth(null), bucketOpts);
      handles.set(cacheKey, handle);
    }
    return handle;
  }
  const key = lensCacheKey(actAs);
  if (!isNamedBucket) {
    const handles = (ctx.lensStorages ??= new Map());
    let handle = handles.get(key);
    if (!handle) {
      handle = getStorageSandbox(ctx.sandbox.withAuth(authStateForLens(actAs)));
      handles.set(key, handle);
    }
    return handle;
  }
  const handles = (ctx.bucketStorages ??= new Map());
  const cacheKey = `${bucket}\u0000as:${key}`;
  let handle = handles.get(cacheKey);
  if (!handle) {
    handle = getStorageSandbox(ctx.sandbox.withAuth(authStateForLens(actAs)), bucketOpts);
    handles.set(cacheKey, handle);
  }
  return handle;
}

export async function handleStorageUpdateMetadata(
  ctx: HostCtx,
  port: PortLike,
  msg: UpdateMetadataOpMessage,
): Promise<void> {
  try {
    if (msg.patch.downloadTokens !== undefined) {
      throw new FirebaseError(
        'storage/unauthorized',
        'downloadTokens cannot be updated via storage.updateMetadata; use the admin plane.',
      );
    }
    const bucket = storeBucketOf(ctx, msg.bucket);
    const bucketName = resolveBucketName(ctx, msg, bucket);
    const provenance = opProvenance(msg);
    const baseStorage = nameStorageBucket(
      resolveLensStorage(ctx, msg.actAs, port, bucket),
      bucketName,
    );
    const storage = bindStorageOperationContext(baseStorage, provenance);
    const target = storageRef(storage, msg.path);

    const settablePatch: Record<string, unknown> = {};
    const wireSettable = msg.patch.settable;
    if (wireSettable !== undefined) {
      for (const field of SETTABLE_HEADER_KEYS) {
        const value = wireSettable[field];
        if (value !== undefined) {
          settablePatch[field] = value;
        }
      }
    }

    const wireCustom = msg.patch.customMetadata;
    if (wireCustom !== undefined) {
      const ownEntries = Object.entries(wireCustom);
      if (msg.replaceCustomMetadata === true) {
        if (ownEntries.length === 0) {
          settablePatch.customMetadata = null;
        } else {
          const service = await getStorageService(storage);
          const existing = await service.backend.getMetadata(target.fullPath);
          const merged: Record<string, string | null> = {};
          if (existing?.customMetadata !== undefined) {
            for (const oldKey of Object.keys(existing.customMetadata)) {
              if (!Object.hasOwn(wireCustom, oldKey)) {
                defineOwnKey(merged, oldKey, null);
              }
            }
          }
          for (const [k, v] of ownEntries) {
            defineOwnKey(merged, k, v);
          }
          settablePatch.customMetadata = merged;
        }
      } else {
        const merged: Record<string, string | null> = {};
        for (const [k, v] of ownEntries) {
          defineOwnKey(merged, k, v);
        }
        settablePatch.customMetadata = merged;
      }
    }

    const result = await storageUpdateMetadata(
      target,
      settablePatch as SettableMetadata,
      provenance,
    );
    await bestEffortFlush(ctx, msg.method);
    ok(port, msg.id, { ...result, bucket: bucketName });
  } catch (e) {
    fail(port, msg.id, e);
  }
}
