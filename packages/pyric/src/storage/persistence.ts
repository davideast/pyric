/**
 * Persistence contract and entry point for `pyric/storage`.
 *
 * One database (`pyric-storage` by default), two object stores --
 * `blobs` for the file content and `metadata` for the descriptive
 * record. Both stores key on composite bucket and path strings
 * (`${bucket}/${fullPath}`) to isolate storage persistence across
 * buckets. Object upload writes both stores within a single `readwrite`
 * transaction so the pair stays consistent -- a partial failure can't
 * leave a blob without metadata or vice versa.
 *
 * Slice 3 of the v1 scope (per the design rationale):
 *
 * - Internal infrastructure; no public Storage API is exposed yet.
 *   Slice 5 builds `getStorage` / `ref` / `uploadBytes` / `getBytes` on
 *   top of this layer.
 * - The `StoredMetadata` shape mirrors Firebase's `FullMetadata`
 *   minus the `ref` field (computed at consumption time).
 * - Database name is overridable so tests can isolate state per
 *   case via fake-indexeddb without colliding on the production
 *   default `pyric-storage`.
 *
 * Errors raised from this module are raw `DOMException`-shaped
 * objects -- translation into Firebase-shaped `StorageError`s happens
 * in Slice 8 inside `errors.ts`. Keep this layer mechanical.
 */

import type { GenerationIssuer } from './generation.js';
import { IndexedDbStorageBackend, openDatabase } from './sandbox/indexeddb-backend.js';
import { InMemoryStorageBackend } from './sandbox/memory-backend.js';
import type { StorageReferenceRecord } from './sandbox/persistence-state.js';

/**
 * Legacy shared database name -- used only when NO project identity is
 * available (bare library use, tests that don't pass a name).
 *
 * IndexedDB is origin-scoped, so under this fixed name every project served
 * on the same localhost port shared ONE storage database (issue #359,
 * defect B) -- "old data" from unrelated projects surfaced in Studio.
 * Project-scoped callers now open `pyric-storage:<projectId>` via
 * {@link storageDbName} instead.
 *
 * Migration decision (deliberate, recorded here): the old shared
 * `pyric-storage` database is ORPHANED, not migrated -- cross-project data
 * disappearing from Studio is the desired outcome of the fix. It is not
 * deleted either: other pyric versions on the same origin may still read it.
 */
const DEFAULT_DB_NAME = 'pyric-storage';

/**
 * Default sandbox bucket identifier when not explicitly provided.
 */
export const DEFAULT_BUCKET = 'pyric-default';

/**
 * Encode a composite key scoping an object path to its bucket: `${bucket}/${fullPath}`.
 */
export function toStorageKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

/**
 * Decode a composite key into bucket and object path.
 */
export function parseStorageKey(key: string): { bucket: string; path: string } | null {
  const slashIdx = key.indexOf('/');
  if (slashIdx === -1) return null;
  return {
    bucket: key.slice(0, slashIdx),
    path: key.slice(slashIdx + 1),
  };
}

/**
 * Resolve the default IndexedDB database name for a project identity:
 * `pyric-storage:<projectId>`, or the legacy shared {@link DEFAULT_DB_NAME}
 * when no identity is available. An explicit `dbName` option always wins
 * over this derivation (see `StorageOptions`).
 */
export function storageDbName(projectId?: string | null): string {
  if (projectId) {
    return `${DEFAULT_DB_NAME}:${projectId}`;
  }
  return DEFAULT_DB_NAME;
}

/**
 * Persisted metadata for a single stored object. Mirrors Firebase's
 * `FullMetadata` so Slice 6 (the public `getMetadata` /
 * `updateMetadata` surface) can return this shape directly.
 *
 * Server-set fields (`generation`, `metageneration`, `timeCreated`,
 * `updated`, `bucket`, `fullPath`, `name`, `size`) are populated by
 * the upload pipeline before reaching this layer. The client-settable
 * fields (`contentType` through `customMetadata`) flow in from the
 * caller's `SettableMetadata`.
 */
export interface StoredMetadata {
  /** Full path of the object within the bucket. */
  fullPath: string;
  /** Last path segment (`b.txt` in `a/b.txt`). */
  name: string;
  /** Sandbox bucket id. */
  bucket: string;
  /** Monotonically increasing version of the object content. */
  generation: string;
  /** Monotonically increasing version of just the metadata. */
  metageneration: string;
  /** ISO-8601 timestamp of original creation. */
  timeCreated: string;
  /** ISO-8601 timestamp of the most recent update (content or metadata). */
  updated: string;
  /** Size of the blob in bytes. */
  size: number;
  /** Client-settable: MIME type. Defaults to `application/octet-stream`. */
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  /** Free-form key/value annotations the client attached at upload. */
  customMetadata?: Record<string, string>;
  /**
   * Comma-separated download tokens, as Firebase keeps them. A download URL
   * carries one; removing it from this list revokes that URL.
   */
  downloadTokens?: string;
  /** Base64-encoded MD5 hash of the content. Populated on upload. */
  md5Hash?: string;
  /** Base64-encoded 4-byte big-endian Castagnoli CRC32C of the content. Populated on upload. */
  crc32c?: string;
  /** Sandbox synthetic version tag derived from `(generation, metageneration)`. */
  etag?: string;
}

/** An object's bytes and metadata, both from the same write. */
export interface StoredObject {
  blob: Blob;
  metadata: StoredMetadata;
}

/**
 * Reject a prior object that would land somewhere other than where it came
 * from, or whose size disagrees with its bytes. `replaceIfGeneration` on every
 * backend checks this before it writes.
 */
export function assertPriorAt(prior: StoredObject, bucket: string, path: string): void {
  const elsewhere = prior.metadata.bucket !== bucket || prior.metadata.fullPath !== path;
  if (elsewhere) throw new Error('A prior Storage object can only be put back at its own bucket and path.');
  assertMatchingSize(prior.blob, prior.metadata);
}

/** Reject metadata whose size disagrees with the bytes it is stored with. */
export function assertMatchingSize(blob: Blob, metadata: StoredMetadata): void {
  const mismatchedObject = metadata.size !== blob.size;
  if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
}

/**
 * Persistence-layer interface. Higher layers (Slice 4's
 * `StorageService`, Slice 5's reference operations) interact with
 * the backend through this surface only -- the IndexedDB calls stay
 * isolated behind it.
 *
 * All methods are async and return a promise that settles when the
 * underlying IDB transaction completes. Missing keys resolve to
 * `undefined` rather than throwing; the public API translates that
 * to `storage/object-not-found` in Slice 8.
 */
export interface StorageBackend {
  /**
   * Write a blob + its metadata atomically. Both stores update under
   * one `readwrite` transaction so a failure on either path rolls
   * the other back. Existing entries at the same path are replaced.
   * Resolves to the object the write replaced, read in that same
   * transaction, or `undefined` when the path was empty.
   *
   * Every write raises the path's high-water mark to the generation it
   * stores; nothing lowers it, not a delete and not a reset. With `issue`,
   * the backend asks it for the generation inside the transaction, passing the
   * higher of the stored generation and the mark, and sets
   * `metadata.generation` to the answer before writing.
   */
  put(path: string, blob: Blob, metadata: StoredMetadata, issue?: GenerationIssuer): Promise<StoredObject | undefined>;

  /**
   * Delete the object at `path` only while its stored generation is
   * `generation`, checked and deleted in one transaction. Resolves to whether
   * it deleted, so a later write at the path is never removed.
   */
  deleteIfGeneration(path: string, generation: string, bucket?: string): Promise<boolean>;

  /**
   * Put `prior` back at `path`, or leave the path empty when `prior` is
   * `undefined`, only while the stored generation is `generation`, checked and
   * written in one transaction. Resolves to whether it wrote.
   */
  replaceIfGeneration(path: string, generation: string, prior: StoredObject | undefined, bucket?: string): Promise<boolean>;

  /**
   * Read the blob stored at `path` within `bucket`. Resolves to `undefined` when no
   * entry exists -- callers translate that into `object-not-found`.
   */
  getBlob(path: string, bucket?: string): Promise<Blob | undefined>;

  /**
   * Read the metadata record stored at `path` within `bucket`. Resolves to
   * `undefined` when no entry exists.
   */
  getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined>;

  /**
   * Read the blob and metadata stored at `path` within `bucket` as one pair,
   * both from the same write. Resolves to `undefined` when no entry exists.
   */
  getObject(path: string, bucket?: string): Promise<StoredObject | undefined>;

  /**
   * Replace the metadata record at `path` without touching the blob.
   * Used by `updateMetadata` (Slice 6). Caller is responsible for
   * preserving server-set fields (`generation`, `timeCreated`, ...)
   * the spec says metadata-only updates leave intact.
   */
  putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void>;

  /**
   * Delete both the blob and the metadata at `path` atomically.
   * No-op when neither entry exists.
   */
  delete(path: string, bucket?: string): Promise<void>;

  /**
   * Enumerate metadata records whose `fullPath` starts with `prefix`.
   * Returned in key order (lexicographic by path within bucket). The
   * prefix is used verbatim -- no implicit trailing-slash addition,
   * matching the survey's path-semantics call (Section 6).
   */
  listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]>;

  /**
   * Clear stores. If `bucket` is supplied, clears only entries in that bucket;
   * otherwise clears all stores.
   */
  reset(bucket?: string): Promise<void>;

  /**
   * Close the underlying IndexedDB connection. Idempotent.
   */
  close(): void;

  /**
   * Return a view of this backend scoped to a specific bucket.
   */
  scoped?(bucket: string): StorageBackend;

  /**
   * Begin a chunked upload session (ADR 0015).
   */
  beginUpload?(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
    connectionId?: string,
  ): Promise<string>;

  /**
   * Append a staged part to an active upload session.
   */
  putPart?(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number } | void>;

  /**
   * Return an upload's staged bytes in part order as a Blob typed with the
   * upload's content type, verifying they add up to the declared size. The
   * upload stays staged: the caller writes the object through the engine, which
   * passes this Blob to {@link put} unchanged when the content type agrees, and
   * then discards the staging with {@link abortUpload}. A backend may recognize
   * the Blob in `put` and keep the staged bytes rather than copying them.
   */
  readUpload?(uploadId: string): Promise<Blob>;

  /**
   * Abort an active upload session and purge staged parts.
   */
  abortUpload?(uploadId: string): Promise<void>;

  /**
   * Every object in `bucket`, naming its bytes by SHA-256 instead of carrying
   * them. Only a backend that keeps each object's bytes in a content-addressed
   * file has this; a capture by reference needs it.
   */
  references?(bucket?: string): Promise<StorageReferenceRecord[]>;

  /**
   * True when the objects `put` returns as replaced read their bytes from
   * files on disk rather than holding them in memory, so keeping one costs no
   * memory. Only a backend that keeps object files has it.
   */
  readonly replacedObjectsOnDisk?: boolean;

  /**
   * Store an object whose bytes this backend already holds under
   * `reference.sha256`, writing only its metadata.
   */
  putReference?(path: string, reference: { sha256: string; size: number }, mime: string, metadata: StoredMetadata): Promise<void>;
}

/**
 * Open (or create) the backing database and return a backend bound
 * to it. The connection stays open for the lifetime of the returned
 * backend; call `close()` before discarding it so future opens get a
 * clean handle.
 *
 * `dbName` is overridable so tests can isolate per-case state. In
 * production, callers pass nothing and inherit the default
 * `pyric-storage`.
 */
export async function openStorageBackend(
  dbName: string = DEFAULT_DB_NAME,
  defaultBucket?: string,
): Promise<StorageBackend> {
  try {
    const db = await openDatabase(dbName);
    return new IndexedDbStorageBackend(db, defaultBucket);
  } catch (err) {
    // Without IndexedDB (Node, a worker without it) memory is the store.
    // With it, a store this tab cannot open is a fallback the user must hear about.
    const hasIndexedDb = typeof indexedDB !== 'undefined';
    if (hasIndexedDb) warnNotPersisting(dbName, describeOpenFailure(err), 'other tabs reload');
    return new InMemoryStorageBackend(defaultBucket);
  }
}

function describeOpenFailure(err: unknown): string {
  const named = err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException);
  if (named) return `${(err as Error).name}: ${(err as Error).message}`;
  return String(err);
}

export function warnNotPersisting(dbName: string, reason: string, until: string): void {
  console.warn(`[pyric] Storage could not use the IndexedDB store "${dbName}" (${reason}). Storage will not persist until ${until}.`);
}
