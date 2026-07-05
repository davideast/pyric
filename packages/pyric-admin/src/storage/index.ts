/**
 * `pyric-admin/storage` — Phase 3 + Phase 4b implementation.
 *
 * Mirrors `firebase-admin/storage` with sandbox + prod backends, both
 * selected at {@link initializeApp} time on `pyric-admin/app` (ADR-001
 * D6). Dispatch reads the {@link ADMIN_APP_TARGET} brand on the
 * `PyricAdminApp` handle — no structural duck-typing, no per-call
 * shape probing.
 *
 *   - **Prod path** — delegates to `firebase-admin/storage`'s
 *     `getStorage(adminApp)`. The returned object is the genuine
 *     production `Storage`, so every method on `Storage` / `Bucket` /
 *     `File` (from `@google-cloud/storage`) is present unchanged.
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
 *     policies, lifecycle rules, ACLs, copy/move, notifications. The
 *     prod path keeps every one of these — only the sandbox stub omits
 *     them.
 */

import type { App as AdminApp } from 'firebase-admin/app';
import type { Storage as ProdStorage } from 'firebase-admin/storage';
import { getStorage as getProdStorage } from 'firebase-admin/storage';

import type { Sandbox } from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
  type ProdAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * `pyric-admin/storage`'s `Storage` handle. On the prod path this is
 * literally `firebase-admin/storage`'s `Storage`. On the sandbox path
 * this is an in-process surface that exposes the subset of methods
 * documented in the module header.
 *
 * The shared `bucket(name?)` shape is the contract — consumers code
 * against it without caring which backend is live, the same way they
 * code against `firebase-admin/storage` in production.
 */
export interface Storage {
  /**
   * Get a {@link Bucket} handle. When `name` is omitted, returns the
   * default bucket (sandbox: `'pyric-default'`; prod: whatever
   * `firebase-admin/storage`'s `bucket()` resolves to from app config).
   */
  bucket(name?: string): Bucket;
}

/**
 * A storage bucket handle. The sandbox and prod paths both implement
 * this interface — the prod path delegates to `@google-cloud/storage`'s
 * `Bucket` and exposes every method that class carries; the sandbox
 * path implements only the documented subset.
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
 * / getSignedUrl, etc.) so consumer code is identical across backends.
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
   * sees a stable shape. Prod returns real signed URLs from GCS.
   */
  getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
}

/** Options bag for {@link File.save}. Subset of `@google-cloud/storage`'s `SaveOptions`. */
export interface SaveOptions {
  /**
   * Arbitrary metadata stored alongside the file. The sandbox stores
   * it verbatim; consumers that need to round-trip `contentType`,
   * `metadata.custom`, etc. get it back via internal admin tooling
   * (not exposed on `File` itself yet). The prod path forwards to
   * `@google-cloud/storage`.
   */
  metadata?: Record<string, unknown>;
  /**
   * Content type hint. Sandbox stores it on the entry; prod forwards.
   * Convenience shortcut for `metadata.contentType`.
   */
  contentType?: string;
  /**
   * `resumable: false` is the only mode the sandbox models (single-
   * shot writes). Pass-through on prod. Sandbox throws when set to
   * `true` since resumable uploads are deferred.
   */
  resumable?: boolean;
}

/** Options bag for {@link File.download}. Subset of `@google-cloud/storage`'s `DownloadOptions`. */
export interface DownloadOptions {
  /** Sandbox accepts but ignores `validation` — prod forwards. */
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
 * the canonical shape; calling without an argument is rejected because
 * `pyric-admin/storage` has no notion of a default app (unlike
 * `firebase-admin/storage`, where `getStorage()` resolves the default
 * App from a global registry).
 */
export type StorageApp = PyricAdminApp;

/**
 * Get the {@link Storage} service for the given app.
 *
 * - **Prod app** → returns `firebase-admin/storage`'s `Storage` for
 *   the underlying `adminApp`. Drop-in compatible with production
 *   code that uses `firebase-admin/storage` directly.
 * - **Sandbox app** → returns a sandbox-backed `Storage` whose state
 *   lives on the `Sandbox`. `sandbox.reset()` wipes it.
 */
export function getStorage(app: StorageApp): Storage {
  if (app[ADMIN_APP_TARGET] === 'sandbox') {
    return getSandboxStorage(app);
  }
  if (app[ADMIN_APP_TARGET] === 'prod') {
    return getProdStorageHandle(app);
  }
  // Defensive: the union is closed at the type level. A runtime value
  // that lands here means a caller forged a handle without going
  // through `initializeApp`.
  throw new TypeError(
    'pyric-admin/storage: getStorage expected a PyricAdminApp from `initializeApp`; ' +
      'received a value with no recognized ADMIN_APP_TARGET brand.',
  );
}

// ─── Prod path ──────────────────────────────────────────────────────────

/**
 * Resolve the prod path. The returned `Storage` is the unmodified
 * `firebase-admin/storage` handle — every `Bucket` / `File` method
 * works exactly as documented in `@google-cloud/storage`.
 *
 * We assert-cast the result to our local {@link Storage} interface:
 * structurally it's a superset (same `bucket(name?)` shape) and
 * exposing the broader surface gives callers full access without
 * forcing them back into a `firebase-admin/storage` import.
 */
function getProdStorageHandle(app: ProdAdminApp): Storage {
  const prod: ProdStorage = getProdStorage(app.adminApp as AdminApp);
  return prod as unknown as Storage;
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
    const expiresMs = normalizeExpires(options.expires);
    const url = `pyric-sandbox-storage://${this.bucket.name}/${this.name}?expires=${expiresMs}&action=${options.action}`;
    return [url];
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

// ─── Helpers ────────────────────────────────────────────────────────────

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
  // strictness because the prod path delegates this to GCS anyway.
  return new Date(expires).getTime();
}
