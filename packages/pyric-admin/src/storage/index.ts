/**
 * `pyric-admin/storage` — sandbox mirror for the Admin Storage shape.
 *
 * Mirrors the useful `firebase-admin/storage` shape for local and remote
 * sandbox apps selected at {@link initializeApp} time. Dispatch reads the
 * {@link ADMIN_APP_TARGET} brand on the `PyricAdminApp` handle.
 *
 *   - **Remote sandbox path** — a handle branded by `@pyric/cli`'
 *     `connectRemoteSandbox()`/`remoteSandbox()` relays every data
 *     operation over the bridge to the browser-hosted SharedWorker's
 *     object store (admin lens pinned — rules bypass). Single bucket;
 *     8 MiB per-op byte cap; `getSignedUrl` stays the local stub. See
 *     the remote arm section below.
 *
 *   - **Sandbox path** — returns an in-process {@link Storage} backed
 *     by an in-memory `Map<bucketName, Map<path, FileEntry>>`. State
 *     lives on the {@link Sandbox} via a `WeakMap`, so `sandbox.reset()`
 *     wipes it alongside Firestore / Auth state. Multi-bucket isolation
 *     is real — buckets are independent maps.
 *
 *     Supported sandbox surface (the minimum a session-archive flow
 *     needs):
 *       - `storage.bucket(name?)` → {@link Bucket}-shaped handle
 *       - `bucket.file(path)` → {@link File}-shaped handle
 *       - `file.save(data, options?)` — `Buffer | string | Uint8Array`
 *       - `file.download(options?)` → `[Buffer]`
 *       - `file.delete()` — idempotent
 *       - `file.exists()` → `[boolean]`
 *       - `file.getSignedUrl(options)` → `['pyric-sandbox-storage://…']`
 *
 *     **Deferred in the sandbox backend** (throws `"not implemented in
 *     pyric-admin/storage sandbox backend"`): streaming uploads
 *     (`createWriteStream`), resumable uploads, signed cookies, IAM
 *     policies, lifecycle rules, ACLs, copy/move, notifications.
 */

import {
  isRemoteSandbox,
  type RemoteSandbox,
  type RemoteSandboxChannel,
  type Sandbox,
} from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  getApp,
  type PyricAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * `pyric-admin/storage`'s sandbox `Storage` handle. It exposes the subset
 * documented in the module header.
 *
 * The shared `bucket(name?)` shape is the contract — consumers code
 * against it without caring whether the local or remote sandbox is live.
 */
export interface Storage {
  /**
   * Get a {@link Bucket} handle. When `name` is omitted, returns the
   * sandbox default bucket (`'pyric-default'`).
   */
  bucket(name?: string): Bucket;
}

/**
 * A storage bucket handle implemented by both local and remote sandbox
 * paths. Only the documented subset is supported.
 */
export interface Bucket {
  /** Name of the bucket. Stable across `file()` lookups. */
  readonly name: string;
  /** Get a {@link File} handle for `path`. The file may or may not exist. */
  file(path: string): File;
}

/**
 * A file handle within a bucket. Method shapes mirror
 * `@google-cloud/storage`'s `File` (return tuples for download / exists
 * / getSignedUrl, etc.) so common consumer code retains the familiar shape.
 *
 * The sandbox backend implements the methods documented here. Any
 * other `File` method from `@google-cloud/storage` (`createWriteStream`,
 * `createReadStream`, `copy`, `move`, `setMetadata` beyond the basic
 * `save` options, etc.) throws on the sandbox path — see module header.
 */
export interface File {
  /** Name (path) of the file within its bucket. */
  readonly name: string;
  /** Bucket the file belongs to. Same handle the `file()` call came from. */
  readonly bucket: Bucket;
  /**
   * Persist `data` at this file's path. Replaces any existing content
   * (no append semantics). `options.metadata` is stored alongside the
   * bytes and surfaces on later reads via the in-memory state — the
   * sandbox doesn't expose a full `Metadata` API yet, but the payload
   * round-trips so future expansion is non-breaking.
   */
  save(data: Buffer | string | Uint8Array, options?: SaveOptions): Promise<void>;
  /**
   * Read the file's bytes. Returns a `[Buffer]` tuple to mirror
   * `@google-cloud/storage`'s `File.download` (which returns
   * `[Buffer, ...]`). Throws if the file does not exist.
   */
  download(options?: DownloadOptions): Promise<[Buffer]>;
  /**
   * Remove the file from its bucket. Idempotent — deleting a missing
   * file is a no-op (matches `@google-cloud/storage`'s
   * `ignoreNotFound: true`, which is the only mode the sandbox models).
   */
  delete(): Promise<void>;
  /** `[true]` if the file exists, `[false]` otherwise. Tuple shape mirrors `@google-cloud/storage`. */
  exists(): Promise<[boolean]>;
  /**
   * Return a stub signed URL of the form
   * `pyric-sandbox-storage://${path}?expires=${expires}`. The sandbox
   * does NOT serve the URL — it's a deterministic placeholder so
   * agent code that round-trips signed URLs (logs, fixtures, replay)
   * sees a stable shape.
   */
  getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
}

/** Options bag for {@link File.save}. Subset of `@google-cloud/storage`'s `SaveOptions`. */
export interface SaveOptions {
  /**
   * Arbitrary metadata stored alongside the file. The sandbox stores
   * it verbatim; consumers that need to round-trip `contentType`,
   * `metadata.custom`, etc. get it back via internal admin tooling
   * (not exposed on `File` itself yet).
   */
  metadata?: Record<string, unknown>;
  /**
   * Content type hint stored on the sandbox entry.
   * Convenience shortcut for `metadata.contentType`.
   */
  contentType?: string;
  /**
   * `resumable: false` is the only mode the sandbox models (single-
   * shot writes). The sandbox throws when set to `true` since resumable
   * uploads are deferred.
   */
  resumable?: boolean;
}

/** Options bag for {@link File.download}. Subset of `@google-cloud/storage`'s `DownloadOptions`. */
export interface DownloadOptions {
  /** The sandbox accepts but ignores `validation`. */
  validation?: 'md5' | 'crc32c' | boolean;
}

/** Options bag for {@link File.getSignedUrl}. Mirrors `@google-cloud/storage`'s shape. */
export interface GetSignedUrlOptions {
  /** `'read' | 'write' | 'delete' | 'resumable'`. Sandbox stamps it into the URL only as a hint. */
  action: 'read' | 'write' | 'delete' | 'resumable';
  /**
   * Expiration. Accepts ms-since-epoch (number), ISO date string, or
   * `Date`. Sandbox normalizes to ms-since-epoch and embeds in the
   * stub URL's `expires=` query.
   */
  expires: number | string | Date;
}

/**
 * Input accepted by {@link getStorage}. The branded `PyricAdminApp` is
 * the canonical shape; calling without an argument resolves the default
 * app from the `pyric-admin/app` registry (mirroring
 * `firebase-admin/storage`, where `getStorage()` resolves the default App),
 * and throws the captured `app/no-app` error when nothing is initialized.
 */
export type StorageApp = PyricAdminApp;

/**
 * Get the {@link Storage} service for the given app.
 *
 * Returns a sandbox-backed `Storage` whose state
 *   lives on the `Sandbox`. `sandbox.reset()` wipes it.
 */
export function getStorage(app?: StorageApp): Storage {
  // No-arg call resolves the default app; nothing initialized → captured
  // `app/no-app` FirebaseAppError (see pyric-admin/app getApp).
  const resolved: PyricAdminApp = app === undefined ? getApp() : (app as PyricAdminApp);
  assertAdminAppActive(resolved);
  if (resolved[ADMIN_APP_TARGET] === 'sandbox') {
    // Remote brand checked BEFORE the local arm (same dispatch order as
    // auth/database): the local arm's WeakMap state + `onEvent` reset hook
    // must never touch a remote handle — local state keyed off a remote
    // handle would be a private server-side store the browser never sees,
    // and `onEvent` throws on remote handles by design.
    if (isRemoteSandbox(resolved.sandbox)) {
      return getRemoteStorage(resolved.sandbox);
    }
    return getSandboxStorage(resolved);
  }
  // Defensive: the union is closed at the type level. A runtime value
  // that lands here means a caller forged a handle without going
  // through `initializeApp`.
  throw new TypeError(
    'pyric-admin/storage: getStorage expected a PyricAdminApp from `initializeApp`; ' +
      'received a value with no recognized ADMIN_APP_TARGET brand.',
  );
}

// ─── Sandbox path ───────────────────────────────────────────────────────

/**
 * Default sandbox bucket name. Matches the `pyric-default` used by the
 * `pyric/storage` modular sandbox so consumers that switch between
 * surfaces don't see an unexpected bucket name change.
 */
const DEFAULT_SANDBOX_BUCKET = 'pyric-default';

/** A single file's bytes + opaque metadata in the in-memory store. */
interface FileEntry {
  data: Uint8Array;
  metadata: Record<string, unknown>;
  contentType?: string;
}

/** Per-sandbox state: bucket name → (file path → entry). */
type BucketMap = Map<string, Map<string, FileEntry>>;

/**
 * State + reset-handler registry keyed on `Sandbox` so a single
 * Sandbox shares its storage across every `getStorage` call. The
 * `WeakMap` lets a discarded `Sandbox` (and its state) be GC'd
 * naturally.
 */
const SANDBOX_STATE = new WeakMap<Sandbox, BucketMap>();

/**
 * Reset-subscription bookkeeping. We subscribe to `sandbox.onEvent`
 * once per Sandbox and re-create the bucket map on
 * `session_boundary` events with `phase: 'reset'`. Without this,
 * `sandbox.reset()` would wipe Firestore but leave storage untouched —
 * a leak the sandbox model deliberately avoids.
 */
const RESET_HOOKED = new WeakSet<Sandbox>();

function ensureBucketMap(sandbox: Sandbox): BucketMap {
  let map = SANDBOX_STATE.get(sandbox);
  if (!map) {
    map = new Map();
    SANDBOX_STATE.set(sandbox, map);
  }
  if (!RESET_HOOKED.has(sandbox)) {
    RESET_HOOKED.add(sandbox);
    sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        // Replace the map in place so existing Storage / Bucket / File
        // handles keep working but observe an empty state.
        const existing = SANDBOX_STATE.get(sandbox);
        if (existing) existing.clear();
      }
    });
  }
  return map;
}

function getSandboxStorage(app: SandboxAdminApp): Storage {
  const sandbox = app.sandbox;
  const buckets = ensureBucketMap(sandbox);
  return new SandboxStorage(buckets);
}

/**
 * Sandbox `Storage` implementation. Holds a reference to the per-
 * sandbox bucket map; each `bucket()` call returns a fresh `Bucket`
 * handle bound to the same underlying map, mirroring how
 * `@google-cloud/storage` returns lightweight per-call handles.
 */
class SandboxStorage implements Storage {
  constructor(private readonly buckets: BucketMap) {}

  bucket(name?: string): Bucket {
    const bucketName = name ?? DEFAULT_SANDBOX_BUCKET;
    let files = this.buckets.get(bucketName);
    if (!files) {
      files = new Map();
      this.buckets.set(bucketName, files);
    }
    return new SandboxBucket(bucketName, files);
  }
}

class SandboxBucket implements Bucket {
  constructor(
    readonly name: string,
    private readonly files: Map<string, FileEntry>,
  ) {}

  file(path: string): File {
    return new SandboxFile(path, this, this.files);
  }
}

class SandboxFile implements File {
  constructor(
    readonly name: string,
    readonly bucket: Bucket,
    private readonly files: Map<string, FileEntry>,
  ) {}

  async save(
    data: Buffer | string | Uint8Array,
    options: SaveOptions = {},
  ): Promise<void> {
    if (options.resumable === true) {
      throw new Error(
        'not implemented in pyric-admin/storage sandbox backend: resumable uploads',
      );
    }
    const bytes = toBytes(data);
    const metadata = options.metadata ?? {};
    const entry: FileEntry = {
      data: bytes,
      metadata,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    };
    this.files.set(this.name, entry);
  }

  async download(_options: DownloadOptions = {}): Promise<[Buffer]> {
    const entry = this.files.get(this.name);
    if (!entry) {
      // Mirror the gcs/firebase-admin error message shape so consumer
      // catch-blocks that string-match `No such object` keep working.
      throw new Error(
        `No such object: ${this.bucket.name}/${this.name}`,
      );
    }
    return [Buffer.from(entry.data)];
  }

  async delete(): Promise<void> {
    this.files.delete(this.name);
  }

  async exists(): Promise<[boolean]> {
    return [this.files.has(this.name)];
  }

  async getSignedUrl(options: GetSignedUrlOptions): Promise<[string]> {
    return [stubSignedUrl(this.bucket.name, this.name, options)];
  }

  // ─── Deferred surface (declared so TS callers see a clear error) ────

  /** @deprecated Streaming writes are deferred — see module header. */
  createWriteStream(): never {
    throw new Error(
      'not implemented in pyric-admin/storage sandbox backend: createWriteStream',
    );
  }

  /** @deprecated Streaming reads are deferred — see module header. */
  createReadStream(): never {
    throw new Error(
      'not implemented in pyric-admin/storage sandbox backend: createReadStream',
    );
  }
}

// ─── Remote sandbox arm (remote sandbox, slice 2) ───────────────────────
//
// The app's `Sandbox` is a Node-side handle onto the browser-hosted
// SharedWorker sandbox. Every data operation relays over the handle's
// worker channel with `actAs: { mode: 'admin' }` pinned — firebase-admin's
// rules-bypass semantics against the ONE object store the app + Studio +
// agents share (the host resolves the lens to `pyric/storage/internal`'s
// admin plane). There is deliberately NO local state here: a `WeakMap`
// bucket map keyed off a remote handle would be private server-side data
// the browser never sees, and the local arm's `onEvent` reset hook throws
// on remote handles by design.
//
// Divergences from the local arm, all LOUD:
//   - single bucket: the worker's `pyric/storage` store is single-bucket
//     ("the data store is shared" — bucket names only round-trip in
//     metadata), so `bucket('non-default')` throws instead of silently
//     merging buckets. The default bucket name matches the local arm.
//   - byte payloads are capped at 8 MiB per op (whole-object buffering
//     over four relay hops; streaming stays unsupported on both sandbox arms).
// `getSignedUrl` does NOT relay: it stays the byte-identical local stub.

/** firebase-admin's rules-bypass lens, pinned on every relayed operation. */
const STORAGE_REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

/**
 * Raw per-op byte cap for relayed storage payloads. MUST mirror
 * `@pyric/cli`' `MAX_STORAGE_OP_BYTES` (serve/worker/protocol.ts) — the
 * worker host enforces the same cap on its end. Inlined (like the RTDB
 * push-id generator) because `pyric-admin` deliberately does not depend on
 * `@pyric/cli`.
 */
const MAX_REMOTE_STORAGE_OP_BYTES = 8 * 1024 * 1024;

/** One remote `Storage` per remote handle (handles only — never data). */
const remoteStorageBySandbox = new WeakMap<Sandbox, Storage>();

function getRemoteStorage(sandbox: RemoteSandbox): Storage {
  let storage = remoteStorageBySandbox.get(sandbox);
  if (!storage) {
    storage = new RemoteStorage(sandbox.channel);
    remoteStorageBySandbox.set(sandbox, storage);
  }
  return storage;
}

/** Wire shape of the worker's `storage.getBytes` result. */
interface RemoteGetBytesResult {
  dataB64: string;
  contentType?: string;
  size: number;
}

class RemoteStorage implements Storage {
  constructor(private readonly channel: RemoteSandboxChannel) {}

  bucket(name?: string): Bucket {
    // The worker's object store is single-bucket. A non-default name can't
    // be faithfully relayed — throw loudly instead of silently merging
    // buckets (the local arm has REAL multi-bucket isolation; this is the
    // sharpest local/remote divergence, so it must be explicit).
    if (name !== undefined && name !== DEFAULT_SANDBOX_BUCKET) {
      throw new Error(
        `pyric-admin/storage: the remote (browser) sandbox has a single bucket — ` +
          `bucket('${name}') cannot be isolated. Use bucket() (the default ` +
          `'${DEFAULT_SANDBOX_BUCKET}' bucket) instead.`,
      );
    }
    return new RemoteBucket(DEFAULT_SANDBOX_BUCKET, this.channel);
  }
}

class RemoteBucket implements Bucket {
  constructor(
    readonly name: string,
    private readonly channel: RemoteSandboxChannel,
  ) {}

  file(path: string): File {
    return new RemoteFile(path, this, this.channel);
  }
}

class RemoteFile implements File {
  constructor(
    readonly name: string,
    readonly bucket: Bucket,
    private readonly channel: RemoteSandboxChannel,
  ) {}

  async save(
    data: Buffer | string | Uint8Array,
    options: SaveOptions = {},
  ): Promise<void> {
    if (options.resumable === true) {
      throw new Error(
        'not implemented in pyric-admin/storage remote sandbox backend: resumable uploads',
      );
    }
    const bytes = toBytes(data);
    if (bytes.byteLength > MAX_REMOTE_STORAGE_OP_BYTES) {
      throw payloadTooLarge(bytes.byteLength, `save() payload for '${this.name}'`);
    }
    await this.channel.op({
      method: 'storage.putBytes',
      path: this.name,
      dataB64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      actAs: STORAGE_REMOTE_ADMIN_LENS,
    });
  }

  async download(_options: DownloadOptions = {}): Promise<[Buffer]> {
    let wire: RemoteGetBytesResult;
    try {
      wire = (await this.channel.op({
        method: 'storage.getBytes',
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      })) as RemoteGetBytesResult;
    } catch (err) {
      if (isObjectNotFound(err)) {
        // Mirror the gcs/firebase-admin (and local arm) message shape so
        // consumer catch-blocks that string-match `No such object` work
        // identically across arms.
        throw new Error(`No such object: ${this.bucket.name}/${this.name}`);
      }
      throw err;
    }
    return [Buffer.from(wire.dataB64, 'base64')];
  }

  async delete(): Promise<void> {
    try {
      await this.channel.op({
        method: 'storage.deleteObject',
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
    } catch (err) {
      // The worker store's delete is already idempotent, but swallow a
      // not-found defensively so the local arm's idempotent-delete contract
      // holds even if `pyric/storage` adopts stricter delete semantics later.
      if (isObjectNotFound(err)) return;
      throw err;
    }
  }

  async exists(): Promise<[boolean]> {
    try {
      await this.channel.op({
        method: 'storage.getMetadata',
        path: this.name,
        actAs: STORAGE_REMOTE_ADMIN_LENS,
      });
      return [true];
    } catch (err) {
      if (isObjectNotFound(err)) return [false];
      throw err;
    }
  }

  /** Local stub — byte-identical to the local arm's (no data needed, so it
   *  never relays). The sandbox does NOT serve the URL. */
  async getSignedUrl(options: GetSignedUrlOptions): Promise<[string]> {
    return [stubSignedUrl(this.bucket.name, this.name, options)];
  }

  // ─── Deferred surface (remediating throws, remote-flavored) ─────────

  createWriteStream(): never {
    throw new Error(
      'not implemented in pyric-admin/storage remote sandbox backend: createWriteStream — ' +
        'streams cannot span the bridge relay; use file.save(buffer) (≤ 8 MiB) instead.',
    );
  }

  createReadStream(): never {
    throw new Error(
      'not implemented in pyric-admin/storage remote sandbox backend: createReadStream — ' +
        'streams cannot span the bridge relay; use file.download() (≤ 8 MiB) instead.',
    );
  }
}

/** Is this relayed error the worker's `storage/object-not-found`? */
function isObjectNotFound(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'storage/object-not-found';
}

/** Over-cap rejection (code `payload-too-large`) — mirrors the worker host's
 *  message shape and names the streaming gap. */
function payloadTooLarge(sizeBytes: number, what: string): Error & { code: string } {
  const err = new Error(
    `pyric-admin/storage: ${what} is ${sizeBytes} bytes — over the ` +
      `${MAX_REMOTE_STORAGE_OP_BYTES / (1024 * 1024)} MiB remote storage op cap. ` +
      'Streaming/resumable transfers are not supported on the sandbox backend; ' +
      'split the object or keep it under the cap.',
  ) as Error & { code: string };
  err.code = 'payload-too-large';
  return err;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * The deterministic sandbox signed-URL stub, shared by the local and remote
 * arms so their output is byte-identical (the URL is never served — it's a
 * stable placeholder for logs/fixtures/replay).
 */
function stubSignedUrl(
  bucketName: string,
  path: string,
  options: GetSignedUrlOptions,
): string {
  const expiresMs = normalizeExpires(options.expires);
  return `pyric-sandbox-storage://${bucketName}/${path}?expires=${expiresMs}&action=${options.action}`;
}

/**
 * Normalize `Buffer | string | Uint8Array` into a fresh `Uint8Array`.
 * We copy on ingest so callers can mutate their input buffer without
 * corrupting stored state — mirrors how `firebase-admin/storage` /
 * `@google-cloud/storage` treat `save` inputs.
 */
function toBytes(data: Buffer | string | Uint8Array): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  // Both Buffer (Node) and Uint8Array land here — copy into a new
  // Uint8Array so the stored bytes are independent of the caller's
  // reference. `slice()` produces a copy in both cases.
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/**
 * Normalize the `expires` field into ms-since-epoch. Mirrors the
 * accepted shapes from `@google-cloud/storage`'s `GetSignedUrlOptions`.
 * The sandbox doesn't enforce expiration — the value is only embedded
 * in the stub URL so consumers can round-trip it.
 */
function normalizeExpires(expires: number | string | Date): number {
  if (typeof expires === 'number') return expires;
  if (expires instanceof Date) return expires.getTime();
  // String form — accept anything `Date` parses. Bogus input becomes
  // `NaN`, which is still embeddable in the URL; we don't enforce
  // strictness because the value only feeds the deterministic sandbox stub.
  return new Date(expires).getTime();
}
