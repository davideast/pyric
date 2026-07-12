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
  getStorage,
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
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { initializeApp } from 'pyric/app';
import type { AuthLens } from 'pyric/sandbox';

import type { OpMessage } from '../protocol.js';
import {
  bytesToBase64,
  base64ToBytes,
  storagePayloadTooLarge,
  MAX_STORAGE_OP_BYTES,
  MAX_STORAGE_OP_B64_LENGTH,
} from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { authStateForLens, lensCacheKey, opProvenance } from './core.js';

/** The shared Storage handle, lazily created (Pyric Studio data browse): one per
 *  worker, over an app bound to the shared sandbox. The high-level
 *  `pyric/storage` ops enforce rules, so the host reads through them. */
function ensureStorage(ctx: HostCtx): FirebaseStorage {
  return (ctx.storage ??= getStorage(initializeApp({ sandbox: ctx.sandbox })));
}

/**
 * Resolve the Storage handle a storage op runs against, given its `actAs`
 * lens — the storage mirror of {@link lensRtdb}:
 *
 *   - absent / `app-session` → the shared anonymous page handle
 *     ({@link ensureStorage}). Storage rules apply only when the HOST
 *     configured them on this sandbox's storage service (first call per
 *     sandbox wins) — the SERVED worker configures them via
 *     `applyServeInit` (`serve-init.ts`), which opens the storage service
 *     with `payload.storageRules` BEFORE any op can reach `ensureStorage`/
 *     `lensStorage`, so every lens on a served worker enforces the
 *     project's storage.rules (or runs open when the project has none,
 *     matching Firestore/RTDB's no-rules posture). The lens split still
 *     matters for embedding/test hosts that open the service directly.
 *     (Storage also has no per-port session plumbing — reads always ran
 *     anonymous; writes keep that.)
 *   - `{ mode: 'admin' }` → the rules-BYPASS handle from
 *     `pyric/storage/internal`'s admin plane — same per-sandbox store +
 *     ruleset, rule evaluation skipped (firebase-admin semantics for the
 *     `pyric-admin` remote arm / Studio admin lens).
 *   - `{ mode: 'as', uid }` → a frozen-identity `getStorageSandbox(
 *     sandbox.withAuth({ uid, token? }))` handle; rules evaluate AS that
 *     user. Cached per uid/token key on `ctx.lensStorages`.
 */
function lensStorage(ctx: HostCtx, actAs?: AuthLens): FirebaseStorage {
  if (!actAs || actAs.mode === 'app-session') {
    return ensureStorage(ctx);
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
        const storage = lensStorage(ctx, msg.actAs);
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
        const storage = lensStorage(ctx, msg.actAs);
        // FullMetadata is plain JSON (bucket/fullPath/name/size/contentType/...).
        ok(port, msg.id, await storageGetMetadata(storageRef(storage, msg.path)));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'storage.getBlob': {
      // MessagePort-ONLY: the Blob structured-clones to in-page callers
      // (Studio previews) but silently corrupts under the JSON WS relay — the
      // bridge client rejects relaying it (binary-payload guard). Remote
      // callers use `storage.getBytes` (base64) instead.
      try {
        const storage = lensStorage(ctx, msg.actAs);
        ok(port, msg.id, await storageGetBlob(storageRef(storage, msg.path)));
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
        if (msg.dataB64.length > MAX_STORAGE_OP_B64_LENGTH) {
          throw storagePayloadTooLarge(
            Math.floor(msg.dataB64.length * 0.75),
            `storage.putBytes payload for '${msg.path}'`,
          );
        }
        const bytes = base64ToBytes(msg.dataB64);
        if (bytes.byteLength > MAX_STORAGE_OP_BYTES) {
          throw storagePayloadTooLarge(bytes.byteLength, `storage.putBytes payload for '${msg.path}'`);
        }
        const storage = lensStorage(ctx, msg.actAs);
        const result = await storageUploadBytes(
          storageRef(storage, msg.path),
          bytes,
          toSettableMetadata(msg),
          opProvenance(msg),
        );
        // FullMetadata — plain JSON, relay-safe.
        ok(port, msg.id, result.metadata);
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
        const storage = lensStorage(ctx, msg.actAs);
        const r = storageRef(storage, msg.path);
        const meta = await storageGetMetadata(r);
        if (meta.size > MAX_STORAGE_OP_BYTES) {
          throw storagePayloadTooLarge(meta.size, `object '${msg.path}'`);
        }
        const buf = await storageGetBytes(r);
        if (buf.byteLength > MAX_STORAGE_OP_BYTES) {
          throw storagePayloadTooLarge(buf.byteLength, `object '${msg.path}'`);
        }
        ok(port, msg.id, {
          dataB64: bytesToBase64(new Uint8Array(buf)),
          contentType: meta.contentType,
          size: buf.byteLength,
        });
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
        const storage = lensStorage(ctx, msg.actAs);
        await storageDeleteObject(storageRef(storage, msg.path), opProvenance(msg));
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
