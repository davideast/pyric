/**
 * SharedWorker host — worker-backed Cloud Storage ops.
 *
 * Object browse (`storage.listAll`/`getMetadata`), the MessagePort-only
 * `getBlob`, and the relay-safe base64 byte transfer (`putBytes`/`getBytes`)
 * plus idempotent `deleteObject`. A host with an HTTP byte route refuses
 * the byte-carrying frames (see `HostCtx.storageByteRoute`); its uploads
 * begin and finish here. Owns the storage lens resolver
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
  deleteObject as storageDeleteObject,
  type FirebaseStorage,
  type FullMetadata,
  type SettableMetadata,
} from 'pyric/storage';
// Host-only rules-bypass admin plane — the storage mirror of
// `getAdminFirestore`/`getAdminDatabase`, resolved for `actAs: { mode: 'admin' }`.
import {
  DEFAULT_BUCKET,
  bindStorageOperationContext,
  copyObject,
  getAdminStorageSandbox,
  getStorageService,
  patchObjectMetadata,
  storageAuth,
  storageOperationProvenance,
  targetOf,
  enforceRules,
  requestResourceFor,
  resourceFromStored,
  uploadObject,
} from 'pyric/storage/internal';
import { FirebaseError } from 'pyric/app';
import type { AuthLens, EventProvenance } from 'pyric/sandbox';
import { bindOperationContext, getClock } from 'pyric/sandbox/internal';

import type { OpMessage, StorageBucketWire } from '../protocol.js';
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
  mintCapabilityToken,
  storageObjectPath,
  storageUploadPath,
} from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { authStateForLens, lensCacheKey, opProvenance, sessionCacheKey } from './core.js';
import { portSession } from '../host-auth.js';

/** An upload between `storage.beginUpload` and `storage.finishUpload`. */
interface PendingUpload {
  /** The bucket the upload's object is stored in. */
  bucket: string;
  /** The name its caller knows that bucket by. */
  bucketName: string;
  path: string;
  settable: SettableMetadata;
  /** Download tokens the object is created with, set on the admin lens. */
  downloadTokens?: string;
  /** Authorizes sending this upload's bytes over the byte route, and nothing else. */
  token: string;
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

/** The token bound to one pending upload, or undefined once it finished or was aborted. */
export function uploadTokenOf(ctx: HostCtx, uploadId: string): string | undefined {
  return pendingUploads(ctx).get(uploadId)?.token;
}

// ─── Buckets ──────────────────────────────────────────────────────────────

/** Names callers gave the host's default bucket, as their app's `storageBucket` option names it. */
const defaultBucketNamesByHost = new WeakMap<HostCtx, Set<string>>();

/**
 * The bucket a bucket name stores its objects in. The host's default bucket
 * answers to `DEFAULT_BUCKET`, to the page app's `storageBucket` option, and
 * to every name a caller gave it with `defaultBucket`; every other name is
 * a bucket of its own.
 */
export function storeBucketOf(ctx: HostCtx, name: string | undefined): string {
  const unnamed = name === undefined || name === DEFAULT_BUCKET;
  if (unnamed) return DEFAULT_BUCKET;
  const configured = ctx.appOptions?.storageBucket;
  const isDefault = name === configured || defaultBucketNamesByHost.get(ctx)?.has(name) === true;
  return isDefault ? DEFAULT_BUCKET : name;
}

/** The bucket an op's object is stored in, after noting the caller's name for the default bucket. */
function bucketOfOp(ctx: HostCtx, msg: StorageBucketWire): string {
  const named = msg.defaultBucket;
  const namesDefault = named !== undefined && named !== '' && named !== DEFAULT_BUCKET;
  if (namesDefault) {
    let names = defaultBucketNamesByHost.get(ctx);
    if (names === undefined) {
      names = new Set();
      defaultBucketNamesByHost.set(ctx, names);
    }
    names.add(named);
  }
  return storeBucketOf(ctx, msg.bucket);
}

/**
 * The name the caller knows a bucket by: the name the op gave it, or for the
 * default bucket, the page app's `storageBucket` option. URLs and metadata
 * carry this name; {@link storeBucketOf} maps it back.
 */
function bucketNameOf(ctx: HostCtx, msg: StorageBucketWire, stored: string): string {
  const named = msg.bucket ?? msg.defaultBucket;
  const hasName = named !== undefined && named !== '';
  if (hasName) return named;
  const configured = ctx.appOptions?.storageBucket;
  const namedByApp = stored === DEFAULT_BUCKET && typeof configured === 'string' && configured !== '';
  return namedByApp ? configured : stored;
}

/** Object metadata under the bucket name its caller knows the bucket by. */
function namedMetadata<T extends { bucket: string }>(ctx: HostCtx, msg: StorageBucketWire, metadata: T): T {
  return { ...metadata, bucket: bucketNameOf(ctx, msg, metadata.bucket) };
}

// ─── Upload sessions ──────────────────────────────────────────────────────

/**
 * An upload session from `storage.createUploadSession`. Its bytes arrive over
 * the byte route; the upload that holds them begins once their size is known,
 * and the object is created on the admin plane when the last byte arrives.
 */
interface UploadSession {
  bucket: string;
  bucketName: string;
  path: string;
  settable: SettableMetadata;
  downloadTokens?: string;
  origin?: string;
  token: string;
  provenance?: EventProvenance;
  uploadId?: string;
}

const uploadSessionsByHost = new WeakMap<HostCtx, Map<string, UploadSession>>();

function uploadSessions(ctx: HostCtx): Map<string, UploadSession> {
  let sessions = uploadSessionsByHost.get(ctx);
  if (sessions === undefined) {
    sessions = new Map();
    uploadSessionsByHost.set(ctx, sessions);
  }
  return sessions;
}

/** What the byte route needs of a pending upload session, or undefined for any other id. */
export function uploadSessionOf(ctx: HostCtx, sessionId: string): { token: string; origin?: string; uploadId?: string } | undefined {
  const session = uploadSessions(ctx).get(sessionId);
  if (session === undefined) return undefined;
  return {
    token: session.token,
    ...(session.origin !== undefined ? { origin: session.origin } : {}),
    ...(session.uploadId !== undefined ? { uploadId: session.uploadId } : {}),
  };
}

function sessionOf(ctx: HostCtx, sessionId: string): UploadSession {
  const session = uploadSessions(ctx).get(sessionId);
  if (session === undefined) throw new FirebaseError('storage/object-not-found', `Upload session '${sessionId}' not found or already completed.`);
  return session;
}

/** Begin the upload that holds a session's `size` bytes, once the first request names its size. */
export async function openUploadSession(ctx: HostCtx, sessionId: string, size: number): Promise<string> {
  const session = sessionOf(ctx, sessionId);
  const begun = session.uploadId !== undefined;
  if (begun) return session.uploadId!;
  const tooLarge = size > MAX_STORAGE_OBJECT_BYTES;
  if (tooLarge) throw storageQuotaExceeded(size, `the upload session for '${session.path}'`);
  const storage = getAdminStorageSandbox(ctx.sandbox, { bucket: session.bucket });
  const service = await getStorageService(storage);
  if (!service.backend.beginUpload) {
    throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
  }
  const contentType = session.settable.contentType ?? 'application/octet-stream';
  session.uploadId = await service.backend.beginUpload(targetOf(storage).bucket, session.path, size, contentType, session.settable.customMetadata);
  return session.uploadId;
}

/** Create a session's object on the admin plane from its complete upload. */
export async function finishUploadSession(ctx: HostCtx, sessionId: string): Promise<FullMetadata> {
  const session = sessionOf(ctx, sessionId);
  const uploadId = session.uploadId;
  if (uploadId === undefined) throw new FirebaseError('storage/invalid-argument', `Upload session '${sessionId}' has received no bytes.`);
  const storage = bindStorageOperationContext(getAdminStorageSandbox(ctx.sandbox, { bucket: session.bucket }), session.provenance);
  const service = await getStorageService(storage);
  if (!service.backend.readUpload) {
    throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
  }
  const staged = await service.backend.readUpload(uploadId);
  const result = await uploadObject(storageRef(storage, session.path), staged, session.settable, {
    ...(session.downloadTokens !== undefined ? { downloadTokens: session.downloadTokens } : {}),
  });
  uploadSessions(ctx).delete(sessionId);
  await service.backend.abortUpload?.(uploadId);
  await bestEffortFlush(ctx, 'storage.finishUpload');
  return { ...result.metadata, bucket: session.bucketName };
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

function lensStorage(ctx: HostCtx, actAs: AuthLens | undefined, port: PortLike, bucket: string = DEFAULT_BUCKET): FirebaseStorage {
  const namedBucket = bucket !== DEFAULT_BUCKET;
  if (namedBucket) return bucketLensStorage(ctx, actAs, port, bucket);
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
 * {@link lensStorage} for a bucket other than the default one: the same
 * lenses, on a handle scoped to `bucket`. Each bucket's objects are its own;
 * the ruleset is shared, as one project's buckets share `storage.rules`.
 */
function bucketLensStorage(ctx: HostCtx, actAs: AuthLens | undefined, port: PortLike, bucket: string): FirebaseStorage {
  if (actAs?.mode === 'admin') return getAdminStorageSandbox(ctx.sandbox, { bucket });
  const handles = (ctx.bucketStorages ??= new Map());
  const session = !actAs || actAs.mode === 'app-session' ? portSession(ctx, port) : undefined;
  let lensKey: string;
  let open: () => FirebaseStorage;
  if (session) {
    lensKey = `session:${sessionCacheKey(session)}`;
    open = () => getStorageSandbox(ctx.sandbox.withAuth(session.state), { bucket });
  } else if (!actAs || actAs.mode === 'app-session') {
    lensKey = 'app';
    open = () => getStorageSandbox(bindOperationContext(ctx.sandbox.withAuth(null), {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    }), { bucket });
  } else if (actAs.mode === 'anon') {
    lensKey = 'anon';
    open = () => getStorageSandbox(ctx.sandbox.withAuth(null), { bucket });
  } else {
    lensKey = `as:${lensCacheKey(actAs)}`;
    open = () => getStorageSandbox(ctx.sandbox.withAuth(authStateForLens(actAs)), { bucket });
  }
  const key = `${bucket}\u0000${lensKey}`;
  let handle = handles.get(key);
  if (!handle) {
    handle = open();
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

/**
 * The download tokens an upload creates its object with. firebase-admin's
 * `save` sets them; no client SDK can, so they are taken on the admin lens only.
 */
function uploadDownloadTokens(msg: { downloadTokens?: string; actAs?: AuthLens }): string | undefined {
  const tokens = msg.downloadTokens;
  const setsTokens = tokens !== undefined;
  const adminPlane = msg.actAs?.mode === 'admin';
  if (setsTokens && !adminPlane) {
    throw new FirebaseError('storage/unauthorized', 'An upload sets download tokens on the admin lens only (firebase-admin File.save).');
  }
  return tokens;
}

/** The storage op methods routed to {@link handleStorageOp}. */
const STORAGE_METHODS = new Set<string>([
  'storage.listAll',
  'storage.getMetadata',
  'storage.getDownloadURL',
  'storage.getBlob',
  'storage.setMetadata',
  'storage.putBytes',
  'storage.getBytes',
  'storage.beginUpload',
  'storage.putPart',
  'storage.finishUpload',
  'storage.abortUpload',
  'storage.deleteObject',
  'storage.copyObject',
  'storage.createUploadSession',
]);

/** The operations that carry an object's bytes in frames. */
const BYTE_FRAME_METHODS: ReadonlySet<OpMessage['method']> = new Set<OpMessage['method']>([
  'storage.getBlob',
  'storage.putBytes',
  'storage.getBytes',
  'storage.putPart',
]);

export function isStorageOp(method: OpMessage['method']): boolean {
  return STORAGE_METHODS.has(method);
}

export async function handleStorageOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  const refusesFrames = ctx.storageByteRoute === true && BYTE_FRAME_METHODS.has(msg.method);
  if (refusesFrames) {
    fail(port, msg.id, new FirebaseError(
      'failed-precondition',
      'This host moves Storage bytes over its HTTP byte route (/__pyric/storage/v0/…) and does not take them as frames. ' +
        'Update @pyric/cli and pyric-admin, and reload the page.',
    ));
    return;
  }
  switch (msg.method) {
    case 'storage.listAll': {
      // Object browse. `listAll` enforces `read` rules on the scanned prefix
      // under the op's lens (admin lens bypasses — see lensStorage).
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
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
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
          opProvenance(msg),
        );
        // FullMetadata is plain JSON (bucket/fullPath/name/size/contentType/...).
        ok(
          port,
          msg.id,
          namedMetadata(ctx, msg, await storageGetMetadata(storageRef(storage, msg.path))),
        );
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getDownloadURL': {
      // Read rules decide, as for getMetadata. The token persists in the
      // object's metadata, as production keeps it, and is minted on first use.
      try {
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
          opProvenance(msg),
        );
        const r = storageRef(storage, msg.path);
        await storageGetMetadata(r);
        const target = targetOf(r.storage);
        const service = await getStorageService(r.storage);
        const stored = await service.backend.getMetadata(r.fullPath, target.bucket);
        const missing = stored === undefined;
        if (missing) throw new FirebaseError('storage/object-not-found', `Object '${msg.path}' does not exist.`);
        let token = (stored.downloadTokens ?? '').split(',').find(existing => existing !== '');
        const unminted = token === undefined;
        if (unminted) {
          token = crypto.randomUUID();
          await service.backend.putMetadata(r.fullPath, {
            ...stored,
            downloadTokens: token,
            metageneration: String(Number(stored.metageneration) + 1),
            updated: new Date(getClock(ctx.sandbox).now()).toISOString(),
          }, target.bucket);
        }
        ok(port, msg.id, { path: storageObjectPath(bucketNameOf(ctx, msg, target.bucket), r.fullPath, token) });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.setMetadata': {
      // firebase-admin's File.setMetadata. It can change the download tokens,
      // which no client SDK can, so it runs on the admin lens only.
      try {
        const adminPlane = msg.actAs?.mode === 'admin';
        if (!adminPlane) {
          throw new FirebaseError('storage/unauthorized', 'storage.setMetadata is the admin plane (firebase-admin File.setMetadata) and runs only on the admin lens.');
        }
        const storage = bindStorageOperationContext(lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)), opProvenance(msg));
        const result = await patchObjectMetadata(storageRef(storage, msg.path), msg.patch);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, namedMetadata(ctx, msg, result));
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
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
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
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
          opProvenance(msg),
        );
        const result = await uploadObject(
          storageRef(storage, msg.path),
          bytes,
          toSettableMetadata(msg),
          { downloadTokens: uploadDownloadTokens(msg) },
        );
        await bestEffortFlush(ctx, msg.method);
        // FullMetadata — plain JSON, relay-safe.
        ok(port, msg.id, namedMetadata(ctx, msg, result.metadata));
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
        const downloadTokens = uploadDownloadTokens(msg);
        const storage = bindStorageOperationContext(
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
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
            // An upload is a `create` whether or not an object exists; `resource`
            // is the stored object when one does.
            method: 'create',
            path: r.fullPath,
            resource: requestResourceFor({
              ...settable,
              fullPath: r.fullPath,
              bucket: r.bucket,
              size: msg.size,
              contentType: settable.contentType ?? msg.contentType ?? 'application/octet-stream',
            }, 'upload'),
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
        const token = mintCapabilityToken();
        pendingUploads(ctx).set(uploadId, { bucket: target.bucket, bucketName: bucketNameOf(ctx, msg, target.bucket), path: r.fullPath, settable, ...(downloadTokens !== undefined ? { downloadTokens } : {}), token });
        // A host with a byte route takes the bytes at this URL; others ignore it.
        ok(port, msg.id, { uploadId, uploadUrl: storageUploadPath(target.bucket, r.fullPath, uploadId, token) });
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
          lensStorage(ctx, msg.actAs, port, pending!.bucket),
          opProvenance(msg),
        );
        const service = await getStorageService(storage);
        if (!service.backend.readUpload) {
          throw new FirebaseError('storage/unsupported', 'Current storage backend does not support chunked uploads.');
        }
        // A Blob of the staged bytes; a backend that staged them in a file keeps
        // that file as the object instead of reading it.
        const staged = await service.backend.readUpload(msg.uploadId);
        const result = await uploadObject(storageRef(storage, pending!.path), staged, pending!.settable, { downloadTokens: pending!.downloadTokens });
        pendingUploads(ctx).delete(msg.uploadId);
        await service.backend.abortUpload?.(msg.uploadId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, { ...result.metadata, bucket: pending!.bucketName });
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
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
          opProvenance(msg),
        );
        const r = storageRef(storage, msg.path);
        const meta = await storageGetMetadata(r);
        const isRange = msg.offset !== undefined || msg.length !== undefined;
        if (isRange) {
          // The generation the caller expects, or the one the rules were
          // evaluated against. The bytes are read with their metadata as one
          // pair from the same write, and an overwrite since either generation
          // was observed fails the read rather than mixing two writes.
          const generation = msg.expectedGeneration ?? meta.generation;
          const objectChanged = (): FirebaseError =>
            new FirebaseError('storage/object-changed', 'The object changed while reading. Re-read metadata and retry.');
          if (meta.generation !== generation) throw objectChanged();
          const offset = msg.offset ?? 0;
          const length = msg.length ?? (meta.size - offset);
          if (length > MAX_STORAGE_OP_BYTES) {
            throw storagePayloadTooLarge(length, `range read for '${msg.path}'`);
          }
          const target = targetOf(r.storage);
          const service = await getStorageService(r.storage);
          const object = await service.backend.getObject(r.fullPath, target.bucket);
          if (!object) {
            throw new FirebaseError('storage/object-not-found', `object '${msg.path}' not found.`);
          }
          if (object.metadata.generation !== generation) throw objectChanged();
          const slice = new Uint8Array(await object.blob.slice(offset, offset + length).arrayBuffer());
          ok(port, msg.id, {
            dataB64: bytesToBase64(slice),
            contentType: object.metadata.contentType,
            size: slice.byteLength,
            generation: object.metadata.generation,
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
          lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)),
          opProvenance(msg),
        );
        await storageDeleteObject(storageRef(storage, msg.path));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.copyObject': {
      // firebase-admin's File.copy, within a bucket or into another one.
      try {
        const adminPlane = msg.actAs?.mode === 'admin';
        if (!adminPlane) {
          throw new FirebaseError('storage/unauthorized', 'storage.copyObject is the admin plane (firebase-admin File.copy) and runs only on the admin lens.');
        }
        const provenance = opProvenance(msg);
        const source = bindStorageOperationContext(lensStorage(ctx, msg.actAs, port, bucketOfOp(ctx, msg)), provenance);
        const destinationBucket = storeBucketOf(ctx, msg.destinationBucket);
        const destination = bindStorageOperationContext(lensStorage(ctx, msg.actAs, port, destinationBucket), provenance);
        const result = await copyObject(storageRef(source, msg.path), storageRef(destination, msg.destinationPath), msg.patch ?? {}, provenance);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, namedMetadata(ctx, { bucket: msg.destinationBucket, defaultBucket: msg.defaultBucket }, result));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.createUploadSession': {
      // firebase-admin's File.createResumableUpload. The session URL takes the
      // bytes over the byte route, which creates the object when they are all in.
      try {
        const adminPlane = msg.actAs?.mode === 'admin';
        if (!adminPlane) {
          throw new FirebaseError('storage/unauthorized', 'storage.createUploadSession is the admin plane (firebase-admin File.createResumableUpload) and runs only on the admin lens.');
        }
        const routed = ctx.storageByteRoute === true;
        if (!routed) {
          throw new FirebaseError('storage/unsupported', 'Upload sessions need a host with an HTTP byte route. This host has none; upload with File.save() instead.');
        }
        if (!msg.path || msg.path.trim() === '') {
          throw new FirebaseError('storage/invalid-root-operation', 'storage.createUploadSession cannot operate on root reference.');
        }
        const bucket = bucketOfOp(ctx, msg);
        const storage = lensStorage(ctx, msg.actAs, port, bucket);
        const r = storageRef(storage, msg.path);
        const sessionId = crypto.randomUUID();
        const token = mintCapabilityToken();
        const downloadTokens = uploadDownloadTokens(msg);
        const provenance = opProvenance(msg);
        uploadSessions(ctx).set(sessionId, {
          bucket,
          bucketName: bucketNameOf(ctx, msg, bucket),
          path: r.fullPath,
          settable: toSettableMetadata(msg),
          token,
          ...(downloadTokens !== undefined ? { downloadTokens } : {}),
          ...(msg.origin !== undefined ? { origin: msg.origin } : {}),
          ...(provenance !== undefined ? { provenance } : {}),
        });
        ok(port, msg.id, { uploadUrl: storageUploadPath(bucketNameOf(ctx, msg, bucket), r.fullPath, sessionId, token) });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String(msg.method)}`));
    }
  }
}
