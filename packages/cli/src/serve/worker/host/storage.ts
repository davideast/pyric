/**
 * SharedWorker host — worker-backed Cloud Storage ops.
 *
 * Object browse (`storage.listAll`/`getMetadata`), the MessagePort-only
 * `getBlob`, and the relay-safe base64 byte transfer (`putBytes`/`getBytes`)
 * plus idempotent `deleteObject`. Owns the storage lens resolver
 * (`lensStorage` — the storage mirror of the firestore/rtdb lens resolvers),
 * the lazily-created shared handle, and the wire → `SettableMetadata` mapper.
 *
 * Routed here by the host dispatcher. Storage dispatch is async, so the
 * mutating ops thread the op's provenance EXPLICITLY (their events escape the
 * dispatcher's synchronous ambient-provenance window). Never imports the
 * dispatcher.
 */

import {
  getStorageSandbox,
  ref as storageRef,
  listAll as storageListAll,
  getMetadata as storageGetMetadata,
  getBlob as storageGetBlob,
  getBytes as storageGetBytes,
  uploadBytes as storageUploadBytes,
  deleteObject as storageDeleteObject,
  type FirebaseStorage,
  type SettableMetadata,
} from 'pyric/storage';
// Host-only rules-bypass admin plane — the storage mirror of
// `getAdminFirestore`/`getAdminDatabase`, resolved for `actAs: { mode: 'admin' }`.
import {
  bindStorageOperationContext,
  getAdminStorageSandbox,
  getStorageService,
  storageAuth,
  storageOperationProvenance,
  targetOf,
  enforceRules,
  requestResourceFor,
  resourceFromStored,
} from 'pyric/storage/internal';
import { FirebaseError } from 'pyric/app';
import type { AuthLens } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';

import type { OpMessage } from '../protocol.js';
import {
  bytesToBase64,
  base64ToBytes,
  storagePayloadTooLarge,
  storagePartTooLarge,
  storageQuotaExceeded,
  MAX_STORAGE_OP_BYTES,
  MAX_STORAGE_OP_B64_LENGTH,
  MAX_STORAGE_PART_BYTES,
  MAX_STORAGE_PART_B64_LENGTH,
  MAX_STORAGE_OBJECT_BYTES,
} from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { authStateForLens, lensCacheKey, opProvenance, sessionCacheKey } from './core.js';
import { portSession } from '../host-auth.js';

/** An upload between `storage.beginUpload` and `storage.finishUpload`. */
interface PendingUpload {
  path: string;
  settable: SettableMetadata;
}

/**
 * Where each staged upload will land and with which settable metadata. The
 * backend keeps the bytes; the object itself is written by the engine's
 * upload, exactly as a single-frame `storage.putBytes` is.
 */
const pendingUploadsByHost = new WeakMap<HostCtx, Map<string, PendingUpload>>();

function pendingUploads(ctx: HostCtx): Map<string, PendingUpload> {
  let uploads = pendingUploadsByHost.get(ctx);
  const firstUpload = uploads === undefined;
  if (firstUpload) {
    uploads = new Map();
    pendingUploadsByHost.set(ctx, uploads);
  }
  return uploads!;
}

/** The shared Storage handle, lazily created (Pyric Studio data browse): one per
 *  worker, directly over the shared sandbox. The high-level
 *  `pyric/storage` ops enforce rules, so the host reads through them. */
function ensureStorage(ctx: HostCtx): FirebaseStorage {
  return (ctx.storage ??= getStorageSandbox(bindOperationContext(ctx.sandbox.withAuth(null), {
    source: { kind: 'app' },
    authLens: { mode: 'app-session' },
  })));
}

/**
 * Resolve the Storage handle a storage op runs against, given its `actAs`
 * lens — the storage mirror of {@link lensRtdb}:
 *
 *   - absent / `app-session` → a handle carrying the initiating port's Auth
 *     session, or the shared anonymous handle when that port is signed out.
 *     Storage rules apply only when the HOST
 *     configured them on this sandbox's storage service (first call per
 *     sandbox wins) — the SERVED worker configures them via
 *     `applyServeInit` (`serve-init.ts`), which opens the storage service
 *     with `payload.storageRules` BEFORE any op can reach `ensureStorage`/
 *     `lensStorage`, so every lens on a served worker enforces the
 *     project's storage.rules (or fails closed when the project has none,
 *     matching Firebase production's no-rules posture). The lens split still
 *     matters for embedding/test hosts that open the service directly.
 *   - `{ mode: 'admin' }` → the rules-BYPASS handle from
 *     `pyric/storage/internal`'s admin plane — same per-sandbox store +
 *     ruleset, rule evaluation skipped (firebase-admin semantics for the
 *     `pyric-admin` remote arm / Studio admin lens).
 *   - `{ mode: 'as', uid }` → a frozen-identity `getStorageSandbox(
 *     sandbox.withAuth({ uid, token? }))` handle; rules evaluate AS that
 *     user. Cached per uid/token key on `ctx.lensStorages`.
 */
function sessionStorage(ctx: HostCtx, port: PortLike): FirebaseStorage {
  const session = portSession(ctx, port);
  if (!session) return ensureStorage(ctx);
  const key = sessionCacheKey(session);
  const handles = (ctx.sessionStorages ??= new Map());
  let handle = handles.get(key);
  if (!handle) {
    handle = getStorageSandbox(ctx.sandbox.withAuth(session.state));
    handles.set(key, handle);
  }
  return handle;
}

function lensStorage(ctx: HostCtx, actAs: AuthLens | undefined, port: PortLike): FirebaseStorage {
  if (!actAs || actAs.mode === 'app-session') {
    return sessionStorage(ctx, port);
  }
  if (actAs.mode === 'admin') {
    return (ctx.adminStorage ??= getAdminStorageSandbox(ctx.sandbox));
  }
  // Genuinely unauthenticated — see the `anon` note on lensDb. Distinct from
  // the shared page handle only when the host configured storage rules, but
  // pinning it keeps remote `withAuth(null)` semantics uniform across services.
  if (actAs.mode === 'anon') {
    return (ctx.anonStorage ??= getStorageSandbox(ctx.sandbox.withAuth(null)));
  }
  const handles = (ctx.lensStorages ??= new Map());
  const key = lensCacheKey(actAs);
  let handle = handles.get(key);
  if (!handle) {
    handle = getStorageSandbox(ctx.sandbox.withAuth(authStateForLens(actAs)));
    handles.set(key, handle);
  }
  return handle;
}

/**
 * Map a wire `storage.putBytes` payload to `pyric/storage`'s
 * `SettableMetadata`. The explicit `contentType` field wins; recognized
 * settable fields are lifted from `metadata`; a GCS-style nested custom map
 * (`metadata.metadata`, as `@google-cloud/storage`'s `save` spells it) or a
 * pyric-style `metadata.customMetadata` becomes `customMetadata` with
 * values coerced to strings (the storage-rules `metadata` model).
 */
function toSettableMetadata(msg: {
  contentType?: string;
  metadata?: Record<string, unknown>;
}): SettableMetadata {
  const md = msg.metadata ?? {};
  const str = (key: string): string | undefined =>
    typeof md[key] === 'string' ? (md[key] as string) : undefined;
  const customSource = md['customMetadata'] ?? md['metadata'];
  let customMetadata: Record<string, string> | undefined;
  if (customSource !== null && typeof customSource === 'object' && !Array.isArray(customSource)) {
    customMetadata = {};
    for (const [k, v] of Object.entries(customSource as Record<string, unknown>)) {
      customMetadata[k] = String(v);
    }
  }
  const settable: SettableMetadata = {};
  const contentType = msg.contentType ?? str('contentType');
  if (contentType !== undefined) settable.contentType = contentType;
  const cacheControl = str('cacheControl');
  if (cacheControl !== undefined) settable.cacheControl = cacheControl;
  const contentDisposition = str('contentDisposition');
  if (contentDisposition !== undefined) settable.contentDisposition = contentDisposition;
  const contentEncoding = str('contentEncoding');
  if (contentEncoding !== undefined) settable.contentEncoding = contentEncoding;
  const contentLanguage = str('contentLanguage');
  if (contentLanguage !== undefined) settable.contentLanguage = contentLanguage;
  if (customMetadata !== undefined) settable.customMetadata = customMetadata;
  return settable;
}

/** The storage op methods routed to {@link handleStorageOp}. */
const STORAGE_METHODS = new Set<string>([
  'storage.listAll',
  'storage.getMetadata',
  'storage.getBlob',
  'storage.putBytes',
  'storage.getBytes',
  'storage.beginUpload',
  'storage.putPart',
  'storage.finishUpload',
  'storage.abortUpload',
  'storage.deleteObject',
]);

export function isStorageOp(method: OpMessage['method']): boolean {
  return STORAGE_METHODS.has(method);
}

export async function handleStorageOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'storage.listAll': {
      // Object browse. `listAll` enforces `read` rules on the scanned prefix
      // under the op's lens (admin lens bypasses — see lensStorage).
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        const result = await storageListAll(storageRef(storage, msg.path));
        ok(port, msg.id, {
          items: result.items.map((r) => ({ fullPath: r.fullPath, name: r.name })),
          prefixes: result.prefixes.map((r) => ({ fullPath: r.fullPath, name: r.name })),
        });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getMetadata': {
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        // FullMetadata is plain JSON (bucket/fullPath/name/size/contentType/...).
        ok(
          port,
          msg.id,
          await storageGetMetadata(storageRef(storage, msg.path)),
        );
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getBlob': {
      // MessagePort-ONLY: the Blob structured-clones to in-page callers
      // (Studio previews) but silently corrupts under the JSON WS relay — the
      // bridge client rejects relaying it (binary-payload guard). Remote
      // callers use `storage.getBytes` (base64) instead.
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        ok(
          port,
          msg.id,
          await storageGetBlob(storageRef(storage, msg.path)),
        );
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.putBytes': {
      // Byte upload (remote sandbox, slice 2). Decode-end size cap: reject an
      // oversized base64 string BEFORE materializing its bytes, then re-check
      // the exact decoded length. Rules enforce under the op's lens; the
      // upload emits `service_mutation` events. Storage dispatch is async, so
      // the event escapes the ambient-provenance window `handleMessage` opened;
      // thread the op's provenance EXPLICITLY so a Studio-issued write is
      // attributable end to end (issue #84 item 3).
      try {
        const exceedsEncodedLimit = msg.dataB64.length > MAX_STORAGE_OP_B64_LENGTH;
        if (exceedsEncodedLimit) {
          throw storagePayloadTooLarge(
            Math.floor(msg.dataB64.length * 0.75),
            `storage.putBytes payload for '${msg.path}'`,
          );
        }
        const bytes = base64ToBytes(msg.dataB64);
        const exceedsDecodedLimit = bytes.byteLength > MAX_STORAGE_OP_BYTES;
        if (exceedsDecodedLimit) {
          throw storagePayloadTooLarge(bytes.byteLength, `storage.putBytes payload for '${msg.path}'`);
        }
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        const result = await storageUploadBytes(
          storageRef(storage, msg.path),
          bytes,
          toSettableMetadata(msg),
        );
        await bestEffortFlush(ctx, msg.method);
        // FullMetadata — plain JSON, relay-safe.
        ok(port, msg.id, result.metadata);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.beginUpload': {
      try {
        if (!msg.path || msg.path.trim() === '') {
          throw new FirebaseError('storage/invalid-root-operation', 'storage.beginUpload cannot operate on root reference.');
        }
        if (msg.size < 0) {
          throw new FirebaseError('storage/invalid-argument', `Invalid upload size: ${msg.size}`);
        }
        if (msg.size > MAX_STORAGE_OBJECT_BYTES) {
          throw storageQuotaExceeded(msg.size, `storage.beginUpload for '${msg.path}'`);
        }
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        const r = storageRef(storage, msg.path);
        const target = targetOf(r.storage);
        const service = await getStorageService(r.storage);
        const existing = await service.backend.getMetadata(r.fullPath);
        const operationProvenance = storageOperationProvenance(target, opProvenance(msg));
        const settable = toSettableMetadata(msg);
        enforceRules(service, {
          request: {
            auth: storageAuth(target),
            method: existing ? 'update' : 'create',
            path: r.fullPath,
            resource: requestResourceFor({
              size: msg.size,
              contentType: settable.contentType ?? msg.contentType ?? 'application/octet-stream',
              customMetadata: settable.customMetadata,
            }),
          },
          resource: resourceFromStored(existing),
        }, target, operationProvenance);
        if (!service.backend.beginUpload) {
          throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
        }
        const uploadId = await service.backend.beginUpload(
          target.bucket,
          r.fullPath,
          msg.size,
          settable.contentType ?? msg.contentType ?? 'application/octet-stream',
          settable.customMetadata,
        );
        pendingUploads(ctx).set(uploadId, { path: r.fullPath, settable });
        ok(port, msg.id, { uploadId });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.putPart': {
      try {
        if (!msg.uploadId) {
          throw new FirebaseError('storage/invalid-argument', 'storage.putPart requires uploadId.');
        }
        if (msg.dataB64.length > MAX_STORAGE_PART_B64_LENGTH) {
          throw storagePartTooLarge(
            Math.floor(msg.dataB64.length * 0.75),
            msg.uploadId,
            msg.partIndex,
          );
        }
        const bytes = base64ToBytes(msg.dataB64);
        if (bytes.byteLength > MAX_STORAGE_PART_BYTES) {
          throw storagePartTooLarge(bytes.byteLength, msg.uploadId, msg.partIndex);
        }
        const storage = ensureStorage(ctx);
        const service = await getStorageService(storage);
        if (!service.backend.putPart) {
          throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
        }
        await service.backend.putPart(msg.uploadId, msg.partIndex, bytes);
        ok(port, msg.id, { bytesTransferred: bytes.byteLength });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.finishUpload': {
      // The object is created by the engine's upload, as a single-frame
      // upload is: its metadata, the sandbox clock, the rules in force now,
      // and one mutation event. Beginning the upload only checked the rules early.
      try {
        if (!msg.uploadId) {
          throw new FirebaseError('storage/invalid-argument', 'storage.finishUpload requires uploadId.');
        }
        const pending = pendingUploads(ctx).get(msg.uploadId);
        const unknownUpload = pending === undefined;
        if (unknownUpload) {
          throw new FirebaseError('storage/object-not-found', `Upload '${msg.uploadId}' not found or already completed.`);
        }
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        const service = await getStorageService(storage);
        if (!service.backend.readUpload) {
          throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
        }
        const staged = await service.backend.readUpload(msg.uploadId);
        const result = await storageUploadBytes(storageRef(storage, pending!.path), staged, pending!.settable);
        pendingUploads(ctx).delete(msg.uploadId);
        await service.backend.abortUpload?.(msg.uploadId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result.metadata);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.abortUpload': {
      try {
        if (!msg.uploadId) {
          throw new FirebaseError('storage/invalid-argument', 'storage.abortUpload requires uploadId.');
        }
        const storage = ensureStorage(ctx);
        const service = await getStorageService(storage);
        pendingUploads(ctx).delete(msg.uploadId);
        if (service.backend.abortUpload) {
          await service.backend.abortUpload(msg.uploadId);
        }
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getBytes': {
      // JSON-safe byte download (remote sandbox, slice 2): base64 in the
      // result. Encode-end size cap so a big browser-side object can't blow
      // up the relay. Metadata is read alongside for contentType (both reads
      // run under the same lens; rule-eval order keeps `unauthorized`
      // superseding `not-found`, matching pyric/storage).
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        const r = storageRef(storage, msg.path);
        const meta = await storageGetMetadata(r);
        const isRange = msg.offset !== undefined || msg.length !== undefined;
        if (isRange) {
          if (msg.expectedGeneration !== undefined && meta.generation !== msg.expectedGeneration) {
            throw new FirebaseError('storage/object-changed', 'The object changed while reading. Re-read metadata and retry.');
          }
          const offset = msg.offset ?? 0;
          const length = msg.length ?? (meta.size - offset);
          if (length > MAX_STORAGE_OP_BYTES) {
            throw storagePayloadTooLarge(length, `range read for '${msg.path}'`);
          }
          const target = targetOf(r.storage);
          const service = await getStorageService(r.storage);
          let slice: Uint8Array | undefined;
          if (service.backend.readRange) {
            slice = await service.backend.readRange(target.bucket, r.fullPath, offset, length, msg.expectedGeneration);
          } else {
            const blob = await service.backend.getBlob(r.fullPath, target.bucket);
            if (blob) {
              const subBlob = blob.slice(offset, offset + length);
              slice = new Uint8Array(await subBlob.arrayBuffer());
            }
          }
          if (!slice) {
            throw new FirebaseError('storage/object-not-found', `object '${msg.path}' not found.`);
          }
          ok(port, msg.id, {
            dataB64: bytesToBase64(slice),
            contentType: meta.contentType,
            size: slice.byteLength,
            generation: meta.generation,
          });
        } else {
          const exceedsStoredLimit = meta.size > MAX_STORAGE_OP_BYTES;
          if (exceedsStoredLimit) {
            throw storagePayloadTooLarge(meta.size, `object '${msg.path}'`);
          }
          const buf = await storageGetBytes(r);
          const exceedsReadLimit = buf.byteLength > MAX_STORAGE_OP_BYTES;
          if (exceedsReadLimit) {
            throw storagePayloadTooLarge(buf.byteLength, `object '${msg.path}'`);
          }
          ok(port, msg.id, {
            dataB64: bytesToBase64(new Uint8Array(buf)),
            contentType: meta.contentType,
            size: buf.byteLength,
            generation: meta.generation,
          });
        }
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.deleteObject': {
      // `pyric/storage`'s sandbox delete is idempotent (no-op on missing) —
      // matching the pyric-admin local arm's delete semantics. Rules enforce
      // `write` under the op's lens; deletes emit `service_mutation` events.
      // Async dispatch escapes the ambient window — thread provenance
      // explicitly (issue #84 item 3).
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port),
          opProvenance(msg),
        );
        await storageDeleteObject(storageRef(storage, msg.path));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String(msg.method)}`));
    }
  }
}
