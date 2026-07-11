/**
 * Types for the sandbox-level persistence contract: the interface a
 * service implements to participate in snapshot/restore, and the
 * coarse cross-service snapshot shape itself.
 */

/**
 * Contract for a service that can contribute its state to the sandbox
 * persistence layer. Services (auth, storage, database) register
 * themselves via {@link Sandbox.registerPersistableService} so the
 * sandbox core stays service-agnostic — the sandbox doesn't know what
 * auth or storage look like; it just calls `snapshot()` / `restore()`.
 *
 * `subscribe` is optional but strongly recommended: without it, a
 * service's changes (e.g. new users created via auth) only reach the
 * persisted blob on the next Firestore write. With `subscribe`, the
 * controller debounces a flush on every user-DB change — same latency
 * as Firestore writes.
 */
export interface PersistableService {
  /**
   * Return a plain-JSON-serializable snapshot of this service's state.
   * Called by the persistence controller on every flush. The return
   * value is stored under the service's registered name in the
   * `services` map of the persisted blob.
   */
  snapshot(): unknown;

  /**
   * Restore previously snapshotted state. Called once during
   * `enablePersistence`, AFTER Firestore docs have been restored (so
   * any service that needs Firestore to be hydrated first can rely on
   * that ordering). Guard against bad data — the blob came from disk
   * and may be stale or from a schema migration.
   */
  restore(data: unknown): void;

  /**
   * Optional: subscribe to changes in this service's state. When
   * provided, the persistence controller hooks it up and schedules
   * a debounced flush on each change — ensuring auth-user edits reach
   * the backend promptly, not only on the next Firestore write.
   *
   * Must return an unsubscribe function. The controller unsubscribes
   * on `dispose()`.
   */
  subscribe?: (onChange: () => void) => () => void;

  /**
   * Optional: session-level persistence hooks. When provided, the
   * persistence controller uses these to save and restore the CURRENTLY
   * SIGNED-IN user (not the user database — that's `snapshot`/`restore`).
   *
   * The controller calls `session.subscribe` so it hears every sign-in /
   * sign-out, then writes the uid to the appropriate web-storage slot
   * (determined by `session.mode()`). On init, the controller reads the
   * stored uid and calls `session.restore(uid)` to re-establish the
   * session, firing `onAuthStateChanged` as if the user just signed in.
   *
   * Only active when `SandboxPersistenceOptions.sessionStorage` is
   * provided; omitting `sessionStorage` causes the controller to skip
   * session persistence entirely (no fake durability).
   *
   * Auth is the only service that provides session hooks today. The
   * field is on the generic interface so the controller stays
   * service-agnostic — if a second service ever needs session-style
   * semantics it can add its own hooks without changing the controller.
   */
  session?: {
    /**
     * The uid of the currently signed-in user, or null when signed out.
     * Read by the controller after a subscription fires, and before a
     * save, to snapshot the current state.
     */
    currentUid(): string | null;

    /**
     * Re-establish the signed-in session for `uid`. Fires
     * `onAuthStateChanged` as if the user just signed in. May throw
     * `auth/user-not-found` or `auth/user-disabled` — the controller
     * catches and clears the stored session so a stale uid (user deleted
     * between sessions) doesn't crash init.
     */
    restore(uid: string): void;

    /**
     * Current persistence mode. Determines which web-storage slot the
     * controller writes to:
     *   LOCAL   → localStorage  (survives reload + restart; Firebase default)
     *   SESSION → sessionStorage (survives reload, cleared on tab close)
     *   NONE    → not stored
     *
     * Read on every save so a `setPersistence` call is reflected in the
     * next write without an explicit migration step.
     */
    mode(): 'LOCAL' | 'SESSION' | 'NONE';

    /**
     * Subscribe to sign-in / sign-out changes. The controller installs
     * exactly one subscription here and uses it to drive session saves.
     * Must return an unsubscribe function.
     *
     * Note: this fires on any currentUser change, including external
     * mutations (sandbox.reset(), another handle's sign-in). The
     * controller reads `currentUid()` + `mode()` on each fire and
     * re-computes the correct storage slot — no stale references.
     */
    subscribe(onChange: () => void): () => void;
  };
}

/**
 * Sandbox-level snapshot — a coarse capture of every service's state
 * keyed by service name. The `firestore` key is always present; the
 * `services` map holds one entry per registered persistable service
 * (auth users, future storage objects, etc.). Service-specific
 * snapshot types live in their service modules; `/app` keeps the index
 * structural so it stays decoupled from service implementations.
 *
 * v2 shape — `services` was added when the persistable-service registry
 * landed. Prior `{ firestore }` v1 blobs are treated as having an empty
 * `services` map on restore.
 */
export interface SandboxSnapshot {
  /** Firestore documents, keyed by full path. Always present — empty
   *  `{}` for a fresh or just-reset sandbox. Per-document values are
   *  the post-resolution state the keyspace stored. */
  firestore: Record<string, Record<string, unknown>>;
  /**
   * Per-service opaque state, keyed by service name (e.g. `'auth'`).
   * Each entry is whatever the service's `PersistableService.snapshot()`
   * returned. May be `{}` when no services are registered.
   */
  services: Record<string, unknown>;
}
