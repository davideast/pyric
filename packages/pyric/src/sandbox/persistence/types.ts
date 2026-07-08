/**
 * Public types for `pyric/sandbox` persistence. The sandbox itself is
 * an in-memory dev Firestore; persistence lets a host (browser
 * playground, agent harness) snapshot the sandbox's data to a backend
 * and restore it on next init — turning the sandbox into the local
 * Firestore for a long-running app session.
 *
 * The IndexedDB backend is the default in browsers; `memory` is the
 * opt-out (same as not enabling persistence at all, but useful for
 * tests that exercise the controller). Future backends (filesystem,
 * remote KV) plug in via the `PersistenceBackend` contract — `key` is
 * always the bucket name.
 */

/**
 * Minimal web-storage-like contract the session persistence controller
 * reads/writes. Matches the `localStorage` / `sessionStorage` browser
 * API subset that `pyric dev`'s `SessionStore` already uses, so
 * browsers pass real storages and tests pass in-memory Map-backed fakes.
 *
 * Why the minimal subset (get/set/remove) instead of the full
 * `Storage` interface: this library targets multiple environments
 * (browser, Bun, Node) and the full `Storage` interface carries
 * length + key() + clear() that aren't needed here — narrowing the
 * contract keeps tests simple and Node/Bun hosts from having to
 * implement a complete polyfill.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Controller options. See {@link Sandbox.enablePersistence}. */
export interface SandboxPersistenceOptions {
  /**
   * IndexedDB database name (or generic bucket key for other backends).
   * Different keys persist to different storage locations — use one
   * key per logical sandbox if you run several in parallel.
   */
  key: string;
  /**
   * Storage backend. `indexedDB` requires a browser environment; in
   * non-browser hosts (Bun, Node, tests) the controller falls back to
   * `memory` automatically unless an `injectedBackend` is supplied.
   * Default: `indexedDB`.
   */
  backend?: 'indexedDB' | 'memory';
  /**
   * Debounce window before write events are flushed to the backend.
   * Buffers rapid bursts (e.g., a batch of seed writes) into one flush.
   * Default: 250ms.
   */
  flushIntervalMs?: number;
  /**
   * Override the backend with an injected implementation. Used by tests
   * and hosts that have their own storage adapter. When set, `backend`
   * is ignored.
   */
  injectedBackend?: PersistenceBackend;

  /**
   * Optional web-storage pair for current-session persistence.
   *
   * When provided, the controller reads and writes the signed-in uid
   * here (honoring the auth `setPersistence` mode) so page reloads
   * restore the signed-in user — exactly like `browserLocalPersistence`
   * in prod Firebase.
   *
   * When omitted, the user DATABASE still persists (Phase 1), but the
   * CURRENT SESSION is not restored on reload. This is the honest
   * no-fake-durability choice for environments where web storage isn't
   * available (Bun tests, Node servers, etc.).
   *
   * `local` maps to `localStorage` semantics (survives reload + restart);
   * `session` maps to `sessionStorage` semantics (survives reload, cleared
   * on tab close). The controller picks which store to write based on the
   * auth `setPersistence` mode recorded on the backend:
   *   LOCAL   → local  (default; matches Firebase's default)
   *   SESSION → session
   *   NONE    → neither (uid is not stored)
   *
   * Both storages are read on restore (mode-agnostic — a prior session
   * may have used a different mode). Exactly one store holds the uid at
   * any time; a mode change migrates the uid to the new store.
   */
  sessionStorage?: {
    local: WebStorageLike;
    session: WebStorageLike;
  };
}

/**
 * Backend contract: read/write/list/delete RECORDS under a key. The controller
 * partitions a snapshot into structured-clone bucket records (chunk-format.ts) so
 * the backend stores many small records natively, never one keyspace-sized blob.
 * Record values are structured-clone-safe objects; the backend never interprets
 * them. (v2 and earlier used a single string blob; v3 is record-shaped.)
 */
export interface PersistenceBackend {
  /** Read one record by id under `key`. Resolves `null` when absent. */
  getRecord(key: string, recordId: string): Promise<unknown | null>;
  /** List all record ids under `key`, any order. */
  listRecords(key: string): Promise<string[]>;
  /** Write each `[recordId, value]` under `key`, replacing any prior value. */
  putRecords(key: string, records: ReadonlyMap<string, unknown>): Promise<void>;
  /** Delete the given record ids under `key`. No-op for ids that don't exist. */
  deleteRecords(key: string, recordIds: readonly string[]): Promise<void>;
  /** Remove ALL records under `key`. No-op if none exist. */
  clear(key: string): Promise<void>;
  /**
   * Best-effort storage usage estimate (bytes used + the quota ceiling), or
   * `null` when the backend can't report it. Surfaced by the metadata API so a
   * host can show how close the sandbox is to its storage limit. Optional: a
   * backend that can't estimate simply omits it.
   */
  estimate?(): Promise<{ usage: number; quota: number } | null>;
}
