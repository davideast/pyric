/**
 * The sandbox service contract: init config, the admin (rule-bypass)
 * surface, and the `Sandbox` interface itself.
 */

import type { SandboxPersistenceOptions } from '../persistence/types.js';
import type { LOCAL_SANDBOX } from '../internal/local-brand.js';
import type { TabSyncOptions } from '../tab-sync/index.js';
import type { AuthState } from './auth-state.js';
import type { SandboxContext } from './context.js';
import type { EventProvenance, SandboxEvent } from './events.js';
import type { PersistableService, SandboxSnapshot } from './persistence.js';

/**
 * Initialization config for a sandbox. All fields are optional; an
 * empty config produces a sandbox with no rules and no seeded data.
 *
 * **No `auth` field.** Identity belongs to {@link SandboxContext}, not
 * the sandbox. Service handles always require an explicit context.
 */
export interface SandboxConfig {
  // Reserved for future service-agnostic config (rules, documents,
  // etc., once the multi-service architecture lands). Empty for now.
}

/**
 * Admin-plane access — bypasses rules, intended for test assertions
 * ("did the write actually land?"). Surfaced only on the root sandbox
 * because admin reads are identity-agnostic and presenting them on a
 * fork (which exists to *carry* an identity) is conceptually muddled.
 *
 * The shape is intentionally flat for v1 since only Firestore exists.
 * When other services land, this surface namespaces by service
 * (`admin.firestore.getDocument`, `admin.storage.getObject`) and the
 * current flat methods will move under `admin.firestore.*`. Document
 * the migration loudly when it happens.
 */
export interface SandboxAdmin {
  /**
   * Read a Firestore document by full path, ignoring rules. Returns
   * `null` if the document doesn't exist.
   */
  getDocument(path: string): unknown | null;

  /**
   * List Firestore documents under a collection path, ignoring rules.
   * Returns `{ path, data, phantom? }` records — `phantom: true` marks
   * synthesized parent docs that have descendants but no stored data
   * of their own (matches what a live Firestore listing would expose).
   */
  listDocuments(prefix: string): { path: string; data: unknown; phantom?: true }[];

  /**
   * Write a Firestore document by full path, ignoring rules. Creates
   * or overwrites the doc — same "replace" semantics as the user-plane
   * `setDoc(ref, data)` (no merge). Intended for admin tools like the
   * playground's Firestore explorer where the operator should be able
   * to seed/edit data regardless of what rules say.
   *
   * Listeners fire as if the write had gone through the rules path,
   * so subscriptions see the change live. Emits a `request` event with
   * `result: 'allow'` and an `auth: null` shape — admin writes leave
   * a trace in the event log, but aren't gated.
   */
  setDocument(path: string, data: Record<string, unknown>): void;

  /**
   * Delete a Firestore document by full path, ignoring rules. Returns
   * `{ deleted }` reflecting whether a doc was actually removed
   * (`false` if the path didn't exist). Idempotent.
   *
   * Same listener / event-log semantics as {@link setDocument}.
   */
  deleteDocument(path: string): { deleted: boolean };
}

/**
 * A Firebase sandbox — an isolated environment with one auth identity.
 *
 * Created via `initializeSandbox(config)`. Use `fork({ auth })` to
 * derive a new sandbox with a different identity that shares the
 * underlying environment (rules, data, state). Fork is the only
 * identity-switching mechanism — there are no per-op auth overrides
 * and no in-place mutation.
 */
export interface Sandbox {
  /**
   * Derive a context bound to this sandbox under the given auth
   * identity. Operations through services attached to the returned
   * context evaluate rules under that identity. Many contexts can
   * coexist for one sandbox; data is shared.
   *
   * `null` is anonymous; an `AuthState` object names the user (and
   * optional custom claims). Passing `undefined` is a deliberate
   * error — say `withAuth(null)` for anonymous so the call site is
   * unambiguous.
   *
   * @example
   * ```ts
   * const sandbox = initializeSandbox();
   * const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
   * const dbAnon  = getFirestore(sandbox.withAuth(null));
   * ```
   */
  withAuth(auth: AuthState): SandboxContext;

  /**
   * Subscribe to every event the sandbox emits — see {@link SandboxEvent}
   * for the discriminated-union shape. One subscription covers
   * request/denial/snapshot-error/listener-lifecycle/session-boundary;
   * filter on `event.kind` to recover individual streams.
   *
   * Replaces the prior three-channel surface (`onRequest` / `onDenial`
   * / `onSnapshotError`) — see issue #307. Filter cookbook:
   *   - All denials:    `event.kind === 'request' && event.result === 'deny'`
   *   - Stream errors:  `event.kind === 'listener_errored'`
   *   - Per-op traffic: `event.kind === 'request'`
   *
   * Survives `sandbox.reset()` — the subscription is held on the
   * sandbox, not on the underlying environment. A `session_boundary`
   * event with `phase: 'reset'` fires before the env swap so consumers
   * can segment their stream.
   *
   * Returns an unsubscribe function. Listener errors are swallowed so a
   * faulty subscriber can't change rule semantics or hide other events.
   * Both synchronous throws and rejected Promises from async callbacks
   * are silently discarded — subscribers are **observational**, the
   * sandbox doesn't await them and doesn't propagate their errors.
   */
  onEvent(cb: (event: SandboxEvent) => void): () => void;

  /**
   * Run `fn` with ambient {@link EventProvenance} defaults: every event
   * emitted SYNCHRONOUSLY during `fn` that doesn't already carry a
   * provenance field (on the event itself or via an explicit per-emit
   * override) is stamped with these values instead of the global
   * defaults. This is the mechanical "who issued this op" seam the
   * serve worker uses to tag Studio-issued ops (`actor: { kind:
   * 'studio' }`) and to stamp the auth lens an op ran under
   * (`authLens`) — declared by the caller that issues the op, never
   * inferred from the op's shape.
   *
   * SYNCHRONOUS WINDOW: the ambient values apply only until `fn`
   * returns (for an async `fn`, its synchronous prefix — which covers
   * the local environment's rules eval + event emission, since those
   * run before the op's promise is handed back). Work an op DEFERS
   * (snapshot-listener deliveries and re-evals drain on a microtask,
   * off-stack) is intentionally OUTSIDE the window: a listener re-eval
   * belongs to the listener's owner, not to whoever's write triggered
   * it. Nested calls stack — the innermost window wins per field, and
   * each window restores the previous one on exit (including on throw).
   *
   * OPTIONAL because remote sandbox proxies can't provide an ambient
   * emit window (events are emitted in the worker they front). Callers
   * spell `sandbox.runWithProvenance?.(prov, fn) ?? fn()`.
   */
  runWithProvenance?<T>(provenance: EventProvenance, fn: () => T): T;

  /**
   * Every {@link SandboxEvent} this sandbox has emitted since init or
   * the last `reset()`. Returns a defensive copy.
   *
   * Use this for replay: hand the array to `replay(events, rules)`
   * from `pyric/sandbox` and the engine re-issues every
   * captured write against a fresh sandbox.
   *
   * Unlike {@link onEvent} (live stream from the moment of subscribe),
   * `history()` returns *every* event the sandbox has seen — useful
   * for consumers that attach late (e.g., loading a saved session
   * before subscribing) or that need a snapshot at a particular moment.
   *
   * `reset()` and `dispose()` each append a closing `session_boundary`
   * event; `reset()` then clears the history. Consumers that took a
   * snapshot *before* reset retain the boundary in their copy.
   */
  history(): SandboxEvent[];

  /**
   * Admin-plane access (rule-bypass reads). Identity-agnostic by
   * design — admin reads aren't gated on auth, so they live on the
   * sandbox, not on a context. See {@link SandboxAdmin}.
   */
  readonly admin: SandboxAdmin;

  /**
   * Reset the underlying environment to a fresh state — wipes data,
   * rules, and any service-specific configuration.
   *
   * Snapshot listeners attached to the OLD environment are dropped at
   * the swap — they can't survive because their target docs have been
   * wiped. `onEvent` subscribers DO survive — the registry lives on
   * the sandbox, and a `session_boundary` event with `phase: 'reset'`
   * fires before the swap so subscribers know the rollover happened.
   * Existing {@link SandboxContext}s continue to work — their sandbox
   * reference is stable; subsequent operations resolve to the new env.
   */
  reset(): void;

  /**
   * Reset the WHOLE sandbox: {@link reset} (Firestore env + signed-in
   * session), then clear every registered persistable service that
   * provides a {@link PersistableService.reset} hook — auth users, the
   * RTDB tree, storage objects. This is the one sandbox-owned "wipe
   * everything" path: because it iterates the service registry, a new
   * service that registers with a `reset` hook is cleared automatically,
   * and a consumer (Pyric Studio's reset) cannot forget one.
   *
   * Service resets may be async (storage clears IndexedDB stores); the
   * returned promise resolves when every service has finished clearing.
   * A service whose `reset` throws is isolated (warned, others still
   * clear) — mirroring `loadSnapshot`'s per-service isolation.
   */
  resetAll(): Promise<void>;

  /**
   * Tear down listener registries on this sandbox's environment without
   * replacing it. Use this when you're about to discard the sandbox
   * itself (e.g. `runner.reseed()` builds a fresh sandbox rather than
   * calling `reset()`) and want to drop callback references on the
   * outgoing instance defensively. Idempotent. Does not touch data.
   */
  dispose(): void;

  /**
   * Capture a snapshot of every service's state. For v1 with only
   * Firestore, the return value carries a `firestore` key mapping doc
   * paths to data. Future services will add their own keys.
   */
  snapshot(): SandboxSnapshot;

  /**
   * CLOBBER-restore the sandbox's entire state from a prior {@link snapshot}:
   * `reset()` (clears firestore + the signed-in session), then rebuild firestore
   * from `data` and restore each registered service. This is a TOTAL replace —
   * documents absent from `data` do NOT survive — and is the counterpart to
   * {@link snapshot}. It is what makes "transfer (clobber) one instance's data
   * into another" and named-branch switching possible.
   *
   * Fires a `session_boundary` (reset phase), re-evaluates live listeners against
   * the loaded state, and the next persistence flush writes the loaded state.
   * Services present in `data` but not currently registered are skipped (a
   * snapshot taken via {@link snapshot} always includes every registered
   * service, so this only affects cross-instance imports from a sandbox that had
   * a service this one lacks).
   */
  loadSnapshot(data: SandboxSnapshot): void;

  /**
   * Current authenticated user across the sandbox.
   *
   * Mutated by `pyric/auth`'s `signInAnonymously` /
   * `signInWithEmailAndPassword` / `signOut` / `sandbox.setUser`. Read
   * per-call by service factories (e.g. a future
   * `getFirestore(sandbox)` overload) so they see auth state changes
   * without re-binding handles. Defaults to `null` (anonymous /
   * signed out).
   *
   * **Independent of `withAuth({uid})`** — `withAuth` still produces a
   * frozen {@link SandboxContext} that carries its own identity for
   * the runner's test code (the existing pattern: explicit identity
   * per service call). `currentUser` exists for the `pyric/auth`
   * mirror, where consumer app code drives identity through a
   * stateful `Auth` handle rather than naming it per call.
   */
  currentUser: AuthState;

  /**
   * Subscribe to `currentUser` changes. Fires on every mutation —
   * sign-in, sign-out, user swap. Does NOT fire on subscribe.
   *
   * Survives `reset()` and `dispose()` only as a no-op: a disposed
   * sandbox emits nothing further; a reset sandbox clears
   * `currentUser` to `null` (and fires the change) before swapping
   * the env.
   *
   * Returns an unsubscribe function. Listener errors are swallowed —
   * subscribers are observational, the sandbox does not propagate
   * their errors.
   */
  onCurrentUserChanged(cb: (user: AuthState) => void): () => void;

  /**
   * Enable cross-tab realtime sync via `BroadcastChannel`. A write in
   * this tab will propagate to every OTHER tab of the same origin that
   * also called `enableTabSync`, causing their `onSnapshot` listeners to
   * re-evaluate — restoring production's cross-client realtime behavior.
   *
   * **Opt-in, OFF by default.** Firestore only (RTDB is a follow-on).
   *
   * Returns a disable function. Calling it removes the `onEvent`
   * subscription, the channel message listener, and closes the channel
   * (when it was created internally). After disable, no further propagation
   * occurs in either direction.
   *
   * **Multi-writer note:** concurrent writes from two tabs to the same doc
   * produce last-write-wins divergence — there is no conflict resolution.
   * The intended model is one active writer (one user, one tab) with
   * observers in other tabs; this covers the overwhelming majority of
   * local development scenarios.
   *
   * @see {@link TabSyncOptions} for channel injection (tests) and originId.
   *
   * @example
   * ```ts
   * // In every tab that should participate in realtime:
   * const sandbox = initializeSandbox();
   * const disableSync = sandbox.enableTabSync();
   * // Later, to stop syncing:
   * disableSync();
   * ```
   */
  enableTabSync(options?: TabSyncOptions): () => void;

  /**
   * Persist the sandbox's data to a backend and restore it on next
   * `enablePersistence` call. The default `'indexedDB'` backend turns
   * the sandbox into the host page's local Firestore — writes flush
   * automatically and a fresh `initializeSandbox()` rehydrates from
   * the prior session.
   *
   * Restoration happens before the promise resolves; awaiting this
   * call is sufficient to guarantee in-memory state matches the
   * persisted blob.
   *
   * Idempotent across the same `key` — calling twice in one process
   * is a no-op on the second call. Different keys are rejected as an
   * error (a sandbox can persist to at most one backend at a time).
   *
   * Listener semantics: every write event the sandbox emits triggers
   * a debounced flush (default 250ms). Browser hosts additionally
   * flush on `beforeunload` so a page navigation doesn't lose the
   * tail of the debounce window.
   *
   * See {@link SandboxPersistenceOptions} for backend selection and
   * tuning.
   */
  enablePersistence(options: SandboxPersistenceOptions): Promise<void>;

  /**
   * Force a snapshot to the configured persistence backend right now.
   * Useful before a manual navigation, or in tests that need
   * deterministic ordering against the debounce window. Resolves once
   * the write hits the backend.
   *
   * Throws if persistence is not enabled.
   */
  flush(): Promise<void>;

  /**
   * Wipe the persisted blob for this sandbox's `key`. In-memory state
   * is left intact — call `reset()` if you want both. Useful for
   * "sign out and forget" flows.
   *
   * No-op when persistence is not enabled.
   */
  clearPersistence(): Promise<void>;

  /**
   * Register a service (auth, storage, …) as a persistence participant.
   * The sandbox calls `hooks.snapshot()` on every flush and
   * `hooks.restore(data)` on restore. If `hooks.subscribe` is provided,
   * the persistence controller subscribes and schedules a debounced
   * flush on each change — so auth-user edits flush promptly, not only
   * on the next Firestore write.
   *
   * Returns an unregister function — call it if the service is torn
   * down before the sandbox is disposed (uncommon in practice; the
   * sandbox's `dispose()` clears the registry anyway).
   *
   * Throws `failed-precondition` when a service with the same `name` is
   * already registered — the auth package registers `'auth'` once when
   * `getAuth(sandbox)` first creates a backend, so accidental double-
   * registration is a caller bug, not a no-op.
   *
   * **Advanced / internal API.** Service packages (auth, storage) call
   * this when they first attach to a sandbox. Consumer app code should
   * not need to call this directly.
   */
  registerPersistableService(name: string, hooks: PersistableService): () => void;
}

/**
 * An in-process sandbox created by {@link initializeSandbox}.
 *
 * Service controls whose implementation requires synchronous access to local
 * state accept this type. Remote worker handles remain {@link Sandbox}s, but
 * are deliberately not assignable to this local-only interface.
 */
export interface LocalSandbox extends Sandbox {
  readonly [LOCAL_SANDBOX]: true;
}
