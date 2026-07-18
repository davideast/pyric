/**
 * Internal `Sandbox` implementation — backs the public interface from
 * `/app` and exposes the hook (`getEnv`) that other in-package modules
 * (notably `/firestore`) need to reach the underlying
 * `LocalEnvironment`.
 *
 * Not in the package's `exports` map — external consumers can't import
 * this module. Internal modules can because workspace path resolution
 * doesn't go through the exports gate.
 *
 * Why a class plus a private accessor: `/app` keeps its dependency
 * direction clean by exposing only the `Sandbox` interface. Service
 * modules need `LocalEnvironment` access but should not couple to
 * `/app`'s implementation; they read it through {@link getEnv}.
 *
 * The class is identity-agnostic per the multi-context redesign — it
 * holds the env, listener registries, and lifecycle. Identity belongs
 * to {@link SandboxContext}, derived via `withAuth`.
 */

import { LocalEnvironment } from '../../firestore/sandbox/local-environment.js';
import type { AuthState } from '../types/auth-state.js';
import type { SandboxContext } from '../types/context.js';
import { SandboxError } from '../types/errors.js';
import type {
  EventProvenance,
  ListenerLifecycleEvent,
  SandboxCommitEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
  SandboxRuntimeErrorEvent,
  ServiceMutationEvent,
  SessionBoundaryEvent,
} from '../types/events.js';
import type { PersistableService, SandboxSnapshot } from '../types/persistence.js';
import type { LocalSandbox, Sandbox, SandboxAdmin } from '../types/service.js';
import { LOCAL_SANDBOX } from './local-brand.js';
import { SandboxContextImpl, validateAuthState } from '../sandbox-context.js';
import {
  attachPersistence,
  type PersistenceController,
} from '../persistence/controller.js';
import type { SandboxPersistenceOptions } from '../persistence/types.js';
import { attachTabSync } from '../tab-sync/index.js';
import type { TabSyncOptions } from '../tab-sync/index.js';
import {
  mergeAmbientProvenance,
  mergeProvenance,
  stampProvenance,
} from './provenance.js';

// Kept for internal import compatibility; the implementation lives in the
// focused provenance module so this class remains an orchestration shell.
export { stampProvenance } from './provenance.js';

let nextSandboxEventId = 1;
function makeSandboxEventId(): string {
  const seq = (nextSandboxEventId++).toString(36);
  const rnd = Math.random().toString(36).slice(2, 7);
  return `sbe-${seq}-${rnd}`;
}

/**
 * Concrete `Sandbox`. Holds the live `LocalEnvironment` directly and
 * swaps it on `reset()`. Existing `SandboxContext`s continue to work
 * after reset because they hold a reference to *this* sandbox object,
 * not to a particular env — the next operation calls back through
 * `getEnv()` and gets whatever env is current.
 *
 * Subscriber registries (`onDenial` / `onSnapshotError` / `onRequest`)
 * live on the sandbox, NOT on `LocalEnvironment`. `reset()` swaps the
 * env without invalidating user callbacks — see #307 probe (E7) for
 * the bug that motivated this layout. The sandbox installs ONE adapter
 * subscription per channel on the current env that fans out to the
 * user registry; on swap, the adapter subscriptions get re-attached
 * to the new env while user callbacks stay put.
 */
export class SandboxImpl implements LocalSandbox {
  declare readonly [LOCAL_SANDBOX]: true;
  private _env: LocalEnvironment;
  /** User callbacks; stable across `reset()`. */
  private eventSubs = new Set<(event: SandboxEvent) => void>();
  /** Adapter unsubscribers for the current env; refreshed on reset. */
  private envUnsubs: Array<() => void> = [];
  /** Monotonic — surfaced on session_boundary events so consumers can
   *  segment a persisted stream. Increments on every dispatched event. */
  private dispatchedCount = 0;
  /** Append-only history of every SandboxEvent emitted on this sandbox.
   *  Cleared on `reset()` AFTER the session_boundary event is appended,
   *  so the boundary is the last entry of the old session's history.
   *  v1 doesn't cap; consumers persist the snapshot they need. */
  private eventHistory: SandboxEvent[] = [];

  /** Ambient provenance for the current {@link runWithProvenance} window
   *  (undefined outside any window). Purely synchronous — set on entry,
   *  restored in `finally` — so deferred work (microtask listener drains)
   *  never observes a window it didn't open. */
  private ambientProvenance: EventProvenance | undefined;

  /**
   * Currently authenticated user. Mutated by `pyric/auth` (and any
   * future stateful identity bridge). Read per-call by service
   * factories that want to see auth changes without re-binding.
   * Defaults to `null` (anonymous / signed out).
   */
  private _currentUser: AuthState = null;
  /** Subscribers to currentUser changes. Stable across reset() and
   *  dispose() the same way `eventSubs` is — dispose clears them. */
  private currentUserSubs = new Set<(user: AuthState) => void>();

  /** Persistence controller. Null until `enablePersistence` is called.
   *  Survives `reset()` so the next write re-flushes the empty state;
   *  cleared by `dispose()` so the sandbox releases its event listeners. */
  private persistence: PersistenceController | null = null;
  /** In-flight `enablePersistence` call. Awaiting this lets concurrent
   *  enable calls share the same attach work (and same restored state)
   *  rather than racing two restores. */
  private enablePersistencePromise: Promise<void> | null = null;

  /**
   * Persistable-service registry. Each entry is one service (auth,
   * storage, …) that contributes its own state to the sandbox snapshot.
   * The sandbox stays service-agnostic: it just calls `snapshot()` /
   * `restore()` and defers the shape entirely to each service.
   *
   * Cleared in `dispose()`. The controller is notified via
   * `_onServiceRegistered` whenever a new entry arrives so it can
   * subscribe the service's change notifications without requiring the
   * service to register BEFORE `enablePersistence` is called.
   */
  private serviceRegistry = new Map<string, PersistableService>();

  /**
   * Optional callback set by the persistence controller so it learns
   * about services registered AFTER `enablePersistence`. Supports the
   * late-registration case: `enablePersistence` then later `getAuth()`
   * (which registers 'auth'). The controller wires up the subscribe
   * hook and schedules a flush.
   *
   * Only one controller at a time (enforced by `enablePersistence`),
   * so a single slot is sufficient.
   */
  private _onServiceRegistered: ((name: string, hooks: PersistableService) => void) | null = null;
  private _onServiceUnregistered: ((name: string) => void) | null = null;

  private constructor(env: LocalEnvironment) {
    this._env = env;
    this.attachToEnv();
  }

  /** Factory used by `initializeSandbox`. */
  static createRoot(): SandboxImpl {
    return new SandboxImpl(new LocalEnvironment());
  }

  /**
   * Resolve the live `LocalEnvironment`. Stable across resets — the
   * sandbox holds whatever env is current, and consumers of `getEnv`
   * always see the latest one.
   */
  getEnv(): LocalEnvironment {
    return this._env;
  }

  withAuth(auth: AuthState): SandboxContext {
    validateAuthState(auth);
    return new SandboxContextImpl(this, auth);
  }

  /**
   * Install one adapter subscription per env-level channel. Each adapter
   * translates the env's payload into a `SandboxEvent` and dispatches
   * through {@link emit}. Refreshed on `reset()` after the env swap.
   */
  private attachToEnv(): void {
    this.envUnsubs.push(
      this._env.onRequest((event) => {
        // RequestEvent already carries `kind: 'request'` from buildRequestEvent.
        this.emitEvent(event);
      }),
    );

    this.envUnsubs.push(
      this._env.onWrite((event) => {
        // WriteSandboxEvent already carries `kind: 'write'` from emitWrite.
        this.emitEvent(event);
      }),
    );

    this.envUnsubs.push(
      this._env.onSnapshotDelivery((event) => this.emitEvent(event)),
    );
    this.envUnsubs.push(
      this._env.onSnapshotSuppressed((event) => this.emitEvent(event)),
    );
    this.envUnsubs.push(
      this._env.onListenerLifecycle((event) => this.emitEvent(event)),
    );

    // Listener errored events surface via the env's onSnapshotError
    // channel. attach/detach come from onListenerLifecycle (registered
    // below). `listenerId` is now plumbed through emitSnapshotError, so
    // consumers can correlate errored events with the prior attach.
    this.envUnsubs.push(
      this._env.onSnapshotError((err, target, listenerId) => {
        const ev: ListenerLifecycleEvent = {
          kind: 'listener_errored',
          id: makeSandboxEventId(),
          at: Date.now(),
          listenerId,
          target:
            target.kind === 'doc'
              ? { kind: 'doc', path: target.path }
              : { kind: 'query', collection: target.collection },
          auth: err.request?.auth ?? null,
          error: {
            code: 'permission-denied',
            message: err.message,
          },
        };
        this.emitEvent(ev);
      }),
    );

    // onDenial is intentionally NOT bridged into a distinct event kind —
    // denials are `kind === 'request' && result === 'deny'` events, which
    // the onRequest bridge above already covers. Subscribing to onDenial
    // here would double-emit.
  }

  /**
   * THE unified emit choke-point. Every SandboxEvent — from any service —
   * flows through here so provenance is stamped in exactly one place
   * ({@link stampProvenance}) and the event lands on the single
   * `onEvent`/`history()` stream.
   *
   * `provenance` lets a non-default emitter (a future Auth/Storage/RTDB
   * emit site, or a Studio admin/agent/impersonation path) declare its
   * `service`/`actor`/`authLens`/`planId`. Omitted source is recorded as
   * `unattributed`; service handles bind known app/Studio sources explicitly.
   */
  emitEvent(event: SandboxEvent, provenance?: EventProvenance): void {
    // Ambient window values ({@link runWithProvenance}) fill in for fields
    // the explicit per-emit override doesn't name; fields the event itself
    // carries still win inside stampProvenance.
    const merged = mergeProvenance(this.ambientProvenance, provenance);
    this.dispatch(stampProvenance(event, merged));
  }

  /**
   * See `Sandbox.runWithProvenance` (types.ts) for the contract: ambient
   * provenance defaults for events emitted synchronously during `fn`.
   * Nested windows merge (innermost wins per field) and restore on exit.
   */
  runWithProvenance<T>(provenance: EventProvenance, fn: () => T): T {
    const prev = this.ambientProvenance;
    this.ambientProvenance = mergeAmbientProvenance(prev, provenance);
    try {
      return fn();
    } finally {
      this.ambientProvenance = prev;
    }
  }

  /**
   * Dispatch a (already-stamped) SandboxEvent to all user subscribers.
   * Synchronous, with sync-throw + async-rejection isolation so a faulty
   * subscriber can't destabilize the sandbox or crash the process via
   * unhandledRejection. All callers go through {@link emitEvent}; this is
   * the raw fan-out + history append it wraps.
   */
  private dispatch(event: SandboxEvent): void {
    // Append to history unconditionally — consumers that call
    // sandbox.history() expect every event the sandbox saw, regardless
    // of whether onEvent subscribers were attached at emit time.
    this.eventHistory.push(event);
    this.dispatchedCount++;
    if (this.eventSubs.size === 0) return;
    for (const cb of this.eventSubs) {
      try {
        const result = cb(event) as unknown;
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<unknown>).catch(() => { /* swallow */ });
        }
      } catch { /* swallow — observational */ }
    }
  }

  /**
   * Internal entry point for sandbox-level event sources (snapshot
   * deliveries / lifecycle / session_boundary) that don't have an
   * env-level channel to ride on. Exposed only to the same package via
   * {@link emitSandboxEvent}. Stamps provenance like every other emit.
   */
  emitInternal(event: SandboxEvent, provenance?: EventProvenance): void {
    this.emitEvent(event, provenance);
  }

  /**
   * Subscribe to every event the sandbox emits. Survives `reset()`.
   */
  onEvent(cb: (event: SandboxEvent) => void): () => void {
    this.eventSubs.add(cb);
    return () => { this.eventSubs.delete(cb); };
  }

  /**
   * Every SandboxEvent emitted on this sandbox since init (or since
   * the last `reset()`). Returns a defensive copy — mutating the
   * returned array doesn't affect future history() calls.
   *
   * Replay engine consumes this: hand the array to
   * `replay(events, rules)` from `pyric/sandbox` and the
   * engine re-issues every captured write against a fresh sandbox.
   *
   * `reset()` clears the history AFTER emitting the closing
   * session_boundary event, so the last entry of a pre-reset history
   * is always `{ kind: 'session_boundary', phase: 'reset' }`. Likewise
   * `dispose()` leaves the boundary as the final entry.
   */
  history(): SandboxEvent[] {
    return [...this.eventHistory];
  }

  /**
   * Prime the event-history log with events from a PRIOR session of the
   * SAME origin (the served `.pyric/last-session.json` capture), for display
   * continuity after a SharedWorker death — Traffic / activity / metrics read
   * `history()` (and history-first `onEvent` batches), so a fresh worker would
   * otherwise show an empty feed even though the data restored from IDB.
   *
   * This is history-priming ONLY:
   *  - events are APPENDED to `eventHistory` so `history()` and any consumer
   *    that subscribes AFTER boot (Studio's history-first batch) sees them;
   *  - they are NOT dispatched to live `onEvent` subscribers (no re-emission);
   *  - no operation is re-executed — the underlying data is restored
   *    separately from persistence, these events are the record of it;
   *  - `dispatchedCount` is untouched (it counts THIS session's live
   *    dispatches, which drive session_boundary's priorOpCount).
   *
   * No-op unless history is empty, so a warm sandbox (live events already
   * accumulated during boot) is never disturbed and primed events can never
   * interleave after live ones. Returns the number of events primed.
   */
  primeEventHistory(events: readonly SandboxEvent[]): number {
    if (this.eventHistory.length > 0) return 0;
    if (events.length === 0) return 0;
    this.eventHistory.push(...events);
    return events.length;
  }

  /**
   * Admin-plane access. Identity-agnostic: admin reads aren't gated on
   * auth, so they're a sandbox property — not something contexts carry.
   */
  get admin(): SandboxAdmin {
    return {
      getDocument: (path: string) => this._env.getDocument(path),
      listDocuments: (prefix: string) => this._env.listDocuments(prefix),
      setDocument: (path: string, data: Record<string, unknown>) =>
        this._env.adminSetDocument(path, data),
      deleteDocument: (path: string) => this._env.adminDeleteDocument(path),
    };
  }

  reset(): void {
    // Emit the boundary BEFORE the swap so consumers see "session N
    // closed" before any post-reset events arrive. Subscribers in
    // eventSubs survive the swap.
    const boundary: SessionBoundaryEvent = {
      kind: 'session_boundary',
      id: makeSandboxEventId(),
      at: Date.now(),
      phase: 'reset',
      priorOpCount: this.dispatchedCount,
    };
    this.emitEvent(boundary);
    // The boundary is now the last entry in eventHistory; clear the
    // history AFTER emit so consumers that took a snapshot before
    // reset() retain the boundary in their copy.
    this.eventHistory = [];

    // Clear currentUser to null and notify — a reset wipes everything
    // including signed-in identity. Subscribers see the sign-out so
    // their UI / Firestore handles reflect the post-reset state.
    if (this._currentUser !== null) {
      this._currentUser = null;
      this.notifyCurrentUserSubs(null);
    }

    // Detach adapter subscriptions from the outgoing env first
    // (otherwise dispose() would invoke them with cleared registries —
    // harmless but wasteful). Then dispose, swap, re-attach.
    for (const unsub of this.envUnsubs) unsub();
    this.envUnsubs = [];
    this._env.dispose();
    this._env = new LocalEnvironment();
    this.attachToEnv();
  }

  async resetAll(): Promise<{ errors: string[] }> {
    // Firestore env + signed-in session first (emits the session_boundary),
    // then every registered service that opted into `reset`. Iterating the
    // REGISTRY — not a hand-maintained service list — is the point: a service
    // that registers with a `reset` hook is cleared automatically, so a
    // consumer-side reset (Pyric Studio) can't silently skip one.
    this.reset();
    const errors: string[] = [];
    const clears: Promise<void>[] = [];
    for (const [name, svc] of this.serviceRegistry) {
      if (!svc.reset) continue;
      // Isolate each service (sync throw or async rejection) so one broken
      // service doesn't abort the wipe — mirrors loadSnapshot's isolation.
      // Failures are REPORTED, not just logged: a reset that leaves data
      // behind must never look successful to the caller (issue #359 was
      // exactly that experience).
      clears.push(
        Promise.resolve()
          .then(() => svc.reset!())
          .catch((e) => {
            errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
          }),
      );
    }
    await Promise.all(clears);
    return { errors };
  }

  dispose(): void {
    // Emit dispose boundary so consumers can flush their buffers /
    // close out forensic logs cleanly.
    const boundary: SessionBoundaryEvent = {
      kind: 'session_boundary',
      id: makeSandboxEventId(),
      at: Date.now(),
      phase: 'dispose',
      priorOpCount: this.dispatchedCount,
    };
    this.emitEvent(boundary);

    for (const unsub of this.envUnsubs) unsub();
    this.envUnsubs = [];
    this._env.dispose();
    // Detach persistence first so its event subscription doesn't fire
    // after we clear `eventSubs` below — the controller registers via
    // `onEvent`, so its unsubscribe is the safe way out.
    if (this.persistence) {
      this.persistence.dispose();
      this.persistence = null;
    }
    // Clear the service registry and detach the late-registration hook.
    // The controller's dispose() (above) is responsible for unsubscribing
    // any service change notifications it hooked up — we just drop our
    // reference here so a dead sandbox doesn't hold service closures.
    this.serviceRegistry.clear();
    this._onServiceRegistered = null;
    this._onServiceUnregistered = null;
    // Drop user callbacks too — a disposed sandbox is dead, holding
    // subscriptions on it would leak.
    this.eventSubs.clear();
    this.currentUserSubs.clear();
  }

  snapshot(): SandboxSnapshot {
    // Collect each registered service's snapshot under its name. The
    // snapshot is taken at call time — the registry is live, so services
    // registered after `enablePersistence` are naturally included the
    // next time flush calls this.
    const services: Record<string, unknown> = {};
    for (const [name, svc] of this.serviceRegistry) {
      services[name] = svc.snapshot();
    }
    return { firestore: this._env.snapshot(), services };
  }

  loadSnapshot(data: SandboxSnapshot): void {
    // Clobber: reset() to a clean env + cleared session, then rebuild firestore
    // and restore services from the snapshot. This mirrors the persistence
    // controller's boot restore (admin.setDocument per doc + svc.restore per
    // service), but reset()s FIRST so the result is a TOTAL replace — documents
    // absent from `data` do not survive — rather than the controller's
    // onto-an-empty-env overlay. reset() emits the session_boundary and
    // re-attaches the env; the per-doc writes below re-evaluate live listeners
    // and dirty the controller so the loaded state is flushed.
    this.reset();
    for (const [path, docData] of Object.entries(data.firestore)) {
      this._env.adminSetDocument(path, docData);
    }
    // Only services that are BOTH in the snapshot AND currently registered are
    // restored; each is isolated so one broken service doesn't abort the load.
    for (const [name, svc] of this.serviceRegistry) {
      if (!(name in data.services)) continue;
      try {
        svc.restore(data.services[name]);
      } catch (e) {
        console.warn(
          `[sandbox] loadSnapshot: service '${name}' restore failed — ` +
            `Firestore is intact; that service's state may be incomplete:`,
          e,
        );
      }
    }
  }

  /**
   * Current authenticated user across the sandbox. See the doc on
   * {@link Sandbox.currentUser} — used by `pyric/auth` to thread
   * identity through stateful Auth handles.
   */
  get currentUser(): AuthState {
    return this._currentUser;
  }

  set currentUser(user: AuthState) {
    // Validate per `withAuth` rules so the surface stays consistent —
    // null is anonymous; anything else must be a well-formed AuthState.
    validateAuthState(user);
    // No-op when the new value is structurally equal to the old —
    // saves a wasted listener fire on idempotent sign-in/out flows.
    if (currentUserEqual(this._currentUser, user)) return;
    this._currentUser = user;
    this.notifyCurrentUserSubs(user);
  }

  onCurrentUserChanged(cb: (user: AuthState) => void): () => void {
    this.currentUserSubs.add(cb);
    return () => { this.currentUserSubs.delete(cb); };
  }

  private notifyCurrentUserSubs(user: AuthState): void {
    // Re-evaluate LIVE Firestore listeners against the new identity BEFORE
    // notifying currentUser subscribers. A `getFirestore(sandbox)`
    // `onSnapshot` follows `sandbox.currentUser`, so a sign-out / sign-in
    // must re-establish it under the new auth (an auth-gated listener loses
    // access on sign-out) — matching production's listener re-establishment.
    // `_currentUser` is already updated by the caller (setter / reset), so
    // `user` IS the new auth. `AuthState` is structurally the `ListenerAuth`
    // shape the env expects (`{ uid, token? } | null`). No-op when there are
    // no live listeners (e.g. the post-`reset()` env is freshly empty).
    this._env.reevaluateLiveListeners(user);
    if (this.currentUserSubs.size === 0) return;
    for (const cb of this.currentUserSubs) {
      try {
        const result = cb(user) as unknown;
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<unknown>).catch(() => { /* swallow */ });
        }
      } catch { /* swallow — observational */ }
    }
  }

  /**
   * Wire a persistence controller into this sandbox. Restores any
   * prior snapshot before resolving so the in-memory state matches
   * the backend by the time the caller's await returns.
   *
   * Concurrent calls share the same in-flight attach; the second
   * caller sees the same restored state without a duplicate restore
   * pass. Repeat calls after the first resolves are accepted only when
   * the `key` matches — different keys would mean re-pointing the
   * sandbox at a new backend mid-flight, which is conceptually muddled
   * and rejected.
   */
  async enablePersistence(options: SandboxPersistenceOptions): Promise<void> {
    if (this.persistence) {
      if (this.persistence.options.key !== options.key) {
        throw new SandboxError(
          'failed-precondition',
          `Persistence already enabled with key '${this.persistence.options.key}'; ` +
            `cannot re-enable with key '${options.key}'. Dispose and recreate the sandbox.`,
        );
      }
      return;
    }
    if (this.enablePersistencePromise) return this.enablePersistencePromise;
    this.enablePersistencePromise = (async () => {
      const controller = await attachPersistence(this, options);
      // Race-safe: if `dispose()` ran while attach was awaiting, drop
      // the controller on the floor immediately rather than leaving a
      // detached event subscription dangling on the (now-dead) sandbox.
      this.persistence = controller;
    })();
    try {
      await this.enablePersistencePromise;
    } finally {
      this.enablePersistencePromise = null;
    }
  }

  /**
   * Enable cross-tab realtime sync. Delegates to `attachTabSync` which
   * wires the `BroadcastChannel` + `onEvent` subscription. Returns the
   * disable function from `attachTabSync` so the caller can tear down
   * sync without knowing the internals. Mirrors the pattern used by
   * `enablePersistence` → `attachPersistence`.
   */
  enableTabSync(options?: TabSyncOptions): () => void {
    return attachTabSync(this, options);
  }

  async flush(): Promise<void> {
    if (!this.persistence) {
      throw new SandboxError(
        'failed-precondition',
        'flush() called before enablePersistence()',
      );
    }
    await this.persistence.flush();
  }

  async clearPersistence(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.clear();
  }

  registerPersistableService(name: string, hooks: PersistableService): () => void {
    if (this.serviceRegistry.has(name)) {
      throw new SandboxError(
        'failed-precondition',
        `registerPersistableService: a service named '${name}' is already registered on this sandbox. ` +
          `Each service name must be unique — the auth package registers 'auth' exactly once per sandbox.`,
      );
    }
    this.serviceRegistry.set(name, hooks);
    // Notify the persistence controller so it can subscribe to change
    // notifications from this service even if it was registered AFTER
    // `enablePersistence` was called (the late-registration path: user
    // calls `enablePersistence`, later calls `getAuth(sandbox)` which
    // triggers this registration).
    if (this._onServiceRegistered) {
      this._onServiceRegistered(name, hooks);
    }
    return () => {
      if (this.serviceRegistry.get(name) !== hooks) return;
      this.serviceRegistry.delete(name);
      this._onServiceUnregistered?.(name);
    };
  }

  /**
   * Internal hook for the persistence controller: called once at attach
   * time so the controller can be notified when a service registers
   * AFTER `enablePersistence`. Only one controller can be active at a
   * time, so a single callback slot is sufficient.
   *
   * Pass `null` to detach (called by the controller's `dispose()`).
   */
  setServiceRegistrationHook(
    cb: ((name: string, hooks: PersistableService) => void) | null,
  ): void {
    this._onServiceRegistered = cb;
  }

  /** Internal persistence hook paired with service registration. */
  setServiceUnregistrationHook(cb: ((name: string) => void) | null): void {
    this._onServiceUnregistered = cb;
  }

  /**
   * Internal: iterate the current service registry. Used by the
   * persistence controller's restore path to apply each service's
   * saved state from the blob.
   */
  getServiceRegistry(): ReadonlyMap<string, PersistableService> {
    return this.serviceRegistry;
  }
}

/**
 * Structural equality on AuthState — both null, or same uid + same
 * `token` JSON. Used by the `currentUser` setter to skip no-op
 * notifications (matches `firebase/auth`'s observer behavior: it does
 * NOT re-fire when the user object is set to the same identity).
 */
function currentUserEqual(a: AuthState, b: AuthState): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.uid !== b.uid) return false;
  // Token comparison via JSON — tokens are plain object claim maps,
  // not expected to contain non-serializable values.
  const aTok = a.token === undefined ? undefined : JSON.stringify(a.token);
  const bTok = b.token === undefined ? undefined : JSON.stringify(b.token);
  return aTok === bTok;
}

/**
 * Internal helper for service modules: given a `Sandbox` (or a
 * `SandboxContext`'s underlying sandbox), return its `LocalEnvironment`.
 * Throws if the handle isn't a `SandboxImpl` (i.e. somebody hand-rolled
 * one) — custom Sandbox implementations are not supported.
 */
export function getInternalEnv(sandbox: Sandbox): LocalEnvironment {
  if (!(sandbox instanceof SandboxImpl)) {
    throw new SandboxError(
      'invalid-argument',
      'Sandbox handle was not produced by initializeSandbox(); custom Sandbox implementations are not supported.',
    );
  }
  return sandbox.getEnv();
}

/**
 * Prime a sandbox's `history()` log with events from a prior session of the
 * same origin (the served capture file), WITHOUT dispatching them to live
 * `onEvent` subscribers or re-executing any op. History-priming seam for the
 * served worker's boot-time event hydration — see
 * {@link SandboxImpl.primeEventHistory}. No-op unless history is empty.
 * Returns the number of events primed.
 *
 * Throws if `sandbox` wasn't produced by `initializeSandbox()` (same guard
 * as {@link getInternalEnv}).
 */
export function primeEventHistory(
  sandbox: Sandbox,
  events: readonly SandboxEvent[],
): number {
  if (!(sandbox instanceof SandboxImpl)) {
    throw new SandboxError(
      'invalid-argument',
      'Sandbox handle was not produced by initializeSandbox(); custom Sandbox implementations are not supported.',
    );
  }
  return sandbox.primeEventHistory(events);
}

/**
 * Emit a `SandboxEvent` onto a sandbox's unified `onEvent`/`history()`
 * stream, stamping {@link EventProvenance} through the single
 * {@link SandboxImpl.emitEvent} choke-point.
 *
 * **This is the seam the Pyric Studio event-unification keystone reserves
 * for non-Firestore services.** Firestore already emits via the env→sandbox
 * fan-out in {@link SandboxImpl.attachToEnv} (no caller needs this for it).
 * Auth / Storage / RTDB are meant to call this from their own emit sites so
 * their activity lands on the same stream — e.g.
 *   `emitSandboxEvent(sandbox, userCreatedEvent, { service: 'auth' })`.
 *
 * STATUS (Wave 1.5, Gap #1): Auth / Storage / RTDB now emit here. They share
 * one additive union variant — {@link ServiceMutationEvent} (`kind:
 * 'service_mutation'`) — built via {@link makeServiceMutationEvent}, rather
 * than bending into Firestore's rule-eval-shaped `request`/`write` kinds.
 * Wired emit sites:
 *   - auth:    user create/update/delete, users-clear, sign-in, sign-out
 *              (`SandboxBackend` in `pyric/auth`).
 *   - storage: object put / delete / metadata-update (`pyric/storage`).
 *   - rtdb:    set / update / remove / transaction-commit
 *              (`RtdbBackend` in `pyric/database`, via the modular surface).
 * Firestore still rides the env→sandbox fan-out and is unchanged. See
 * the design rationale.
 *
 * Throws if `sandbox` wasn't produced by `initializeSandbox()` (same guard
 * as {@link getInternalEnv}).
 */
export function emitSandboxEvent(
  sandbox: Sandbox,
  event: SandboxEvent,
  provenance?: EventProvenance,
): void {
  if (!(sandbox instanceof SandboxImpl)) {
    throw new SandboxError(
      'invalid-argument',
      'Sandbox handle was not produced by initializeSandbox(); custom Sandbox implementations are not supported.',
    );
  }
  sandbox.emitInternal(event, provenance);
}

/**
 * Build a {@link ServiceMutationEvent} with a fresh `id` + `at` minted from
 * the same monotonic counter Firestore events use — so a non-Firestore
 * service (auth/storage/rtdb) doesn't have to re-implement id minting or
 * worry about colliding with the Firestore stream's ids.
 *
 * The returned event is NOT yet dispatched; hand it to
 * {@link emitSandboxEvent} (which stamps provenance and lands it on the
 * unified stream). The convenience seam for the keystone: a service emit
 * site is `emitSandboxEvent(sandbox, makeServiceMutationEvent({ ... }), { service })`.
 */
export function makeServiceMutationEvent(
  fields: Omit<ServiceMutationEvent, 'kind' | 'id' | 'at'>,
): ServiceMutationEvent {
  return {
    kind: 'service_mutation',
    id: makeSandboxEventId(),
    at: Date.now(),
    ...fields,
  };
}

export function makeSandboxOperationEvent(
  fields: Omit<SandboxOperationEvent, 'kind' | 'id' | 'at'> & { at?: number },
): SandboxOperationEvent {
  const { at, ...rest } = fields;
  return {
    kind: 'operation',
    id: makeSandboxEventId(),
    at: at ?? Date.now(),
    ...rest,
  };
}

export function makeSandboxCommitEvent(
  fields: Omit<SandboxCommitEvent, 'kind' | 'id' | 'at'> & { at?: number },
): SandboxCommitEvent {
  const { at, ...rest } = fields;
  return {
    kind: 'commit',
    id: makeSandboxEventId(),
    at: at ?? Date.now(),
    ...rest,
  };
}

export function makeSandboxListenerEvent(
  fields: Omit<SandboxListenerEvent, 'kind' | 'id' | 'at'> & { at?: number },
): SandboxListenerEvent {
  const { at, ...rest } = fields;
  return {
    kind: 'listener',
    id: makeSandboxEventId(),
    at: at ?? Date.now(),
    ...rest,
  };
}

export function makeSandboxRuntimeErrorEvent(
  fields: Omit<SandboxRuntimeErrorEvent, 'kind' | 'id' | 'at'> & { at?: number },
): SandboxRuntimeErrorEvent {
  const { at, ...rest } = fields;
  return {
    kind: 'runtime_error',
    id: makeSandboxEventId(),
    at: at ?? Date.now(),
    ...rest,
  };
}
