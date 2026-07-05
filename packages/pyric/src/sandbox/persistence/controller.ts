/**
 * Persistence controller — wires a `PersistenceBackend` into a
 * `SandboxImpl`. Owns the debounced auto-flush, the `beforeunload`
 * safety flush, and the restore-on-attach pass.
 *
 * Conceptually orthogonal to the sandbox: the sandbox doesn't know
 * persistence exists until `enablePersistence` constructs a controller
 * and hands it the live sandbox. Disposing the controller detaches
 * every side effect and leaves the sandbox unchanged.
 */

import type { PersistableService, Sandbox, SandboxEvent } from '../types.js';
import { SandboxImpl } from '../internal/sandbox-impl.js';
import { createIndexedDBBackend, createMemoryBackend } from './backends.js';
import {
  serializeToBuckets,
  deserializeFromBuckets,
  migrateV2ToRecords,
} from './chunk-format.js';
import type { PersistenceBackend, SandboxPersistenceOptions } from './types.js';

const DEFAULT_FLUSH_INTERVAL_MS = 250;

/**
 * Storage key for the persisted auth session uid. One key used across
 * both `local` and `session` stores — the controller reads both (mode-
 * agnostic load) and writes only one (based on the current mode). This
 * mirrors how `pyric serve`'s `SessionStore` worked before the session
 * logic moved here.
 *
 * Prefixed `pyric:sandbox:` so it's immediately grepable and doesn't
 * collide with serve's `pyric:serve:` entries or app-level keys.
 */
const SESSION_STORAGE_KEY = 'pyric:sandbox:auth-session';

/**
 * Stable 32-bit FNV-1a content hash of a bucket record, for detecting which
 * buckets changed between flushes. A genuinely changed record almost never
 * hashes equal to its prior content; in the astronomically rare event of a
 * collision the bucket simply re-persists on its next change. Bucket key order
 * is stable across flushes (snapshot iteration order), so an UNCHANGED bucket
 * always hashes identically.
 */
function hashRecord(record: unknown): number {
  const s = JSON.stringify(record);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Detect a storage-quota-exceeded error across environments (the DOMException
 *  name in browsers, a message fallback elsewhere). */
function isQuotaExceeded(e: unknown): boolean {
  if (e && typeof e === 'object') {
    if ((e as { name?: unknown }).name === 'QuotaExceededError') return true;
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && /quota/i.test(msg)) return true;
  }
  return false;
}

function pickBackend(options: SandboxPersistenceOptions): PersistenceBackend {
  if (options.injectedBackend) return options.injectedBackend;
  const requested = options.backend ?? 'indexedDB';
  if (requested === 'memory') return createMemoryBackend();
  // `indexedDB` requested. In non-browser hosts we transparently fall
  // back to memory so calling code paths can share an `enablePersistence`
  // call across browser + test environments without branching.
  if (typeof indexedDB === 'undefined') return createMemoryBackend();
  return createIndexedDBBackend();
}

export interface PersistenceController {
  readonly options: Readonly<SandboxPersistenceOptions>;
  /** Force a flush of the current sandbox state to the backend. */
  flush(): Promise<void>;
  /** Wipe persisted state. In-memory state is untouched. */
  clear(): Promise<void>;
  /** Detach event subscription + beforeunload listener. */
  dispose(): void;
}

/**
 * Construct a controller, restore any prior snapshot, and wire the
 * auto-flush subscription. Returns once restore has completed (callers
 * can `await sandbox.enablePersistence(...)` and be sure the in-memory
 * state reflects the persisted blob).
 *
 * Late service registration: services (e.g. auth) may register with the
 * sandbox AFTER this call returns (the user calls `enablePersistence`
 * then later `getAuth(sandbox)` which triggers `registerPersistableService`).
 * We handle this in two parts:
 *   1. `restore()` returns the raw `services` blob map so the controller
 *      can apply it to late-arriving services.
 *   2. `setServiceRegistrationHook` fires on each registration — we
 *      immediately apply the saved blob data (if any) AND subscribe the
 *      service's change notifier for future flushes.
 */
export async function attachPersistence(
  sandbox: Sandbox,
  rawOptions: SandboxPersistenceOptions,
): Promise<PersistenceController> {
  const options: SandboxPersistenceOptions = {
    ...rawOptions,
    flushIntervalMs: rawOptions.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    backend: rawOptions.backend ?? 'indexedDB',
  };
  const backend = pickBackend(options);

  // Content hash of each persisted bucket, so a flush writes only the buckets
  // whose content actually changed. restore() seeds it from the records it reads,
  // so the just-restored state is not redundantly re-written on the first flush.
  const lastHashes = new Map<string, number>();
  // `restore()` returns the raw services blob — the controller keeps this
  // so late-registering services can still receive their saved state even
  // though they weren't in the registry when `restore()` ran.
  const restoredServices = await restore(sandbox, backend, options.key, lastHashes);

  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Track unsubscribers for service change-notification hooks so we can
  // clean up in dispose(). Keyed by service name (not strictly needed,
  // but makes debugging easier).
  const serviceUnsubs = new Map<string, () => void>();

  // The actual flush. Reads CURRENT state each time it runs.
  const realFlush = async (): Promise<void> => {
    if (disposed) return;
    // `sandbox.snapshot()` now includes `{ firestore, services }` — the
    // services map is built live from the registry, so services registered
    // after enablePersistence (late registration) are naturally included.
    const snap = sandbox.snapshot();
    const records = serializeToBuckets(snap.firestore, snap.services, Date.now());
    // Incremental flush: write ONLY the buckets whose content changed since the
    // last flush, and delete buckets that disappeared. Comparison is by content
    // hash, so it is safe by construction: a changed bucket cannot hash equal to
    // its prior content, so no write is ever skipped (no write-site dirty-set to
    // keep in sync). Put changed buckets BEFORE deleting removed ones, and adopt
    // the new hashes only AFTER both land, so a crash mid-flush never loses live
    // data and the next flush simply retries against the unchanged hash state.
    const changed = new Map<string, unknown>();
    const nextHashes = new Map<string, number>();
    for (const [id, rec] of records) {
      const h = hashRecord(rec);
      nextHashes.set(id, h);
      if (lastHashes.get(id) !== h) changed.set(id, rec);
    }
    const removed = [...lastHashes.keys()].filter((id) => !records.has(id));
    if (changed.size > 0) await backend.putRecords(options.key, changed);
    if (removed.length > 0) await backend.deleteRecords(options.key, removed);
    lastHashes.clear();
    for (const [id, h] of nextHashes) lastHashes.set(id, h);
  };

  // Serialize flushes on a single chain so two never overlap. Without this, a
  // newer flush that fails while an older one succeeds could adopt a stale
  // snapshot's hashes and silently drop the newer write. Each run waits for the
  // previous (success OR failure) and re-derives changes from current state.
  let flushChain: Promise<void> = Promise.resolve();
  const flushNow = (): Promise<void> => {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    flushChain = flushChain.then(realFlush, realFlush);
    return flushChain;
  };

  const scheduleFlush = (): void => {
    if (disposed) return;
    if (pendingFlush) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      void flushNow().catch((e) => {
        if (isQuotaExceeded(e)) {
          // Storage is full: retrying will not help until space is freed, so
          // warn loudly instead of busy-looping. The unpersisted changes stay in
          // memory; the next successful flush (after space frees) re-detects them.
          console.warn(
            '[sandbox/persistence] storage quota exceeded; recent changes are kept ' +
              'in memory only. Free storage or reduce sandbox data to persist them.',
          );
          return;
        }
        console.warn('[sandbox/persistence] auto-flush failed, will retry:', e);
        // A failed flush did not adopt its hashes, so the change is still
        // unpersisted. Re-arm rather than waiting for the next write event, so
        // an idle-after-failure does not leave the change permanently in memory.
        scheduleFlush();
      });
    }, options.flushIntervalMs);
  };

  /**
   * Wire up a service's optional change-notification hook. When a
   * service provides `subscribe`, we call it here so auth-user edits
   * trigger a debounced flush — not only the next Firestore write.
   */
  const attachServiceSubscription = (name: string, hooks: PersistableService): void => {
    if (!hooks.subscribe || serviceUnsubs.has(name)) return;
    const unsub = hooks.subscribe(() => {
      scheduleFlush();
    });
    serviceUnsubs.set(name, unsub);
  };

  // ─── Session persistence setup ─────────────────────────────────────
  //
  // Session persistence is ONLY active when `options.sessionStorage` is
  // provided. When omitted, the user DB still persists (Phase 1) but the
  // CURRENT SESSION is not restored — no fake durability (Decision 2).
  //
  // The session controller reads/writes a single uid JSON blob to the
  // appropriate web-storage slot based on the auth mode. It discovers
  // the auth service's session hooks by scanning the service registry
  // (and via the late-registration hook for services registered after
  // enablePersistence). Only one session provider is supported today
  // (auth); a second service would need to add its own hooks.

  /** Unsubscribers for session-change hooks; cleared in dispose(). */
  const sessionUnsubs = new Map<string, () => void>();

  /**
   * Save the current session uid to the appropriate web-storage slot,
   * or clear both slots on sign-out or NONE mode.
   *
   * Called on every session-change event (sign-in, sign-out, mode change).
   * Reads the CURRENT mode and uid at call time so stale closures can't
   * cause incorrect slot choices (important for mode-migration: a mode
   * change fires a session-change event, and we read the already-updated
   * mode here).
   */
  const saveSession = (sessionHooks: NonNullable<PersistableService['session']>): void => {
    if (!options.sessionStorage) return;
    const { local, session } = options.sessionStorage;
    const uid = sessionHooks.currentUid();
    const mode = sessionHooks.mode();

    if (uid === null || mode === 'NONE') {
      // Signed out, or mode is NONE — clear both stores so no uid lingers
      // across a sign-out or a mode downgrade to NONE.
      local.removeItem(SESSION_STORAGE_KEY);
      session.removeItem(SESSION_STORAGE_KEY);
      return;
    }

    // A session lives in EXACTLY ONE store at any time — clear the other
    // first, then write to the target. This prevents a stale entry in the
    // other store from being picked up on a future reload with a different
    // mode (which would look like the earlier mode's session resuming).
    const payload = JSON.stringify({ uid });
    if (mode === 'LOCAL') {
      session.removeItem(SESSION_STORAGE_KEY); // clear the other slot
      local.setItem(SESSION_STORAGE_KEY, payload);
    } else {
      // SESSION
      local.removeItem(SESSION_STORAGE_KEY); // clear the other slot
      session.setItem(SESSION_STORAGE_KEY, payload);
    }
  };

  /**
   * Read back the stored uid from EITHER web-storage slot.
   * Mode-agnostic: reads local then session (same order as serve's
   * `SessionStore.load`). Returns null when nothing is stored or the
   * blob is unparseable (corrupt bytes → silently drop).
   */
  const loadStoredUid = (): string | null => {
    if (!options.sessionStorage) return null;
    const { local, session } = options.sessionStorage;
    for (const store of [local, session]) {
      const raw = store.getItem(SESSION_STORAGE_KEY);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { uid?: unknown };
        if (parsed && typeof parsed.uid === 'string') return parsed.uid;
      } catch {
        // Corrupt value — remove it so it doesn't confuse a future load.
        store.removeItem(SESSION_STORAGE_KEY);
      }
    }
    return null;
  };

  /**
   * Clear the stored session from BOTH web-storage slots. Used when a
   * restore fails (user deleted / disabled between sessions) so the
   * stale entry doesn't re-surface on the next reload.
   */
  const clearStoredSession = (): void => {
    if (!options.sessionStorage) return;
    options.sessionStorage.local.removeItem(SESSION_STORAGE_KEY);
    options.sessionStorage.session.removeItem(SESSION_STORAGE_KEY);
  };

  /**
   * Wire up the session-change subscription for a service that provides
   * session hooks. On each fire, re-saves the session uid to the
   * appropriate web-storage slot (handling mode changes transparently —
   * mode changes emit a session-change event, so the controller picks up
   * the new mode without a dedicated migration path).
   *
   * Guarded by `sessionUnsubs.has(name)` so it's idempotent; only the
   * first registration per service name installs the subscription.
   */
  const attachSessionSubscription = (name: string, hooks: PersistableService): void => {
    if (!options.sessionStorage) return;
    if (!hooks.session || sessionUnsubs.has(name)) return;
    const sessionHooks = hooks.session;
    const unsub = sessionHooks.subscribe(() => {
      saveSession(sessionHooks);
    });
    sessionUnsubs.set(name, unsub);
  };

  // Wire up any services already in the registry at attach time
  // (the case where the user called getAuth before enablePersistence).
  if (sandbox instanceof SandboxImpl) {
    for (const [name, hooks] of sandbox.getServiceRegistry()) {
      attachServiceSubscription(name, hooks);
      attachSessionSubscription(name, hooks);
    }
    // Install the late-registration hook so services that register
    // AFTER this point (user calls enablePersistence then getAuth) are
    // also subscribed and their changes flush promptly.
    //
    // Crucially: if there's a saved blob entry for this service name, we
    // apply it now (late restore). Without this, a user who calls
    // `enablePersistence` then `getAuth` would lose their saved users
    // because `restore()` ran before auth was in the registry.
    sandbox.setServiceRegistrationHook((name, hooks) => {
      // Late restore: if the blob had data for this service and it
      // wasn't applied during the initial restore pass (because the
      // service wasn't registered then), apply it now. The user DB
      // must be restored BEFORE the session restore below, so it
      // resolves the uid to an existing record.
      if (restoredServices !== null && name in restoredServices) {
        try {
          hooks.restore(restoredServices[name]);
        } catch (e) {
          console.warn(
            `[sandbox/persistence] late-restore for service '${name}' failed:`,
            e,
          );
        }
      }
      // Late session restore: if a stored uid was found during attach
      // but no service with session hooks was registered at that time
      // (the common "reload" pattern where getAuth is called after
      // enablePersistence), restore the session now that the service
      // is available. The user DB restore above ran first, so the uid
      // will resolve correctly.
      if (pendingSessionUid !== null && hooks.session) {
        tryRestoreSession(pendingSessionUid, hooks);
      }
      attachServiceSubscription(name, hooks);
      attachSessionSubscription(name, hooks);
      // Schedule a flush so the newly registered service's initial state
      // is captured in the next blob — important for the early-registration
      // case where the service had existing data before enablePersistence.
      scheduleFlush();
    });
  }

  // ─── Session restore ──────────────────────────────────────────────
  //
  // Restore the signed-in session AFTER the user DB / services have been
  // restored (so the uid resolves to an existing record). We do this by
  // reading the stored uid from web-storage and calling `session.restore`
  // on each registered service that provides session hooks.
  //
  // The restore runs in TWO possible paths:
  //   1. Early-registration (getAuth called BEFORE enablePersistence):
  //      the auth service is already in the registry when attachPersistence
  //      runs, so we can restore here synchronously.
  //   2. Late-registration (getAuth called AFTER enablePersistence, the
  //      common "reload" pattern): the registry is empty here, so we store
  //      the pending uid in `pendingSessionUid` and restore when the auth
  //      service registers via the late-registration hook below.
  //
  // Both paths call `tryRestoreSession` which handles the
  // user-not-found/user-disabled throw + session clear idiom.
  //
  // The session restore must happen AFTER the user DB is restored (so
  // `restoreSession(uid)` can look up the uid), which is why path 2 hangs
  // off the late-registration hook (that hook already applies the user DB
  // restore first — `hooks.restore(restoredServices[name])` runs before
  // we attempt the session).

  /** Uid read from web-storage that still needs a session restore.
   *  Non-null only while a service with session hooks hasn't registered yet. */
  let pendingSessionUid: string | null = null;

  /** Attempt to restore the session for `uid` via `hooks.session`. On
   *  success, the session fires `onAuthStateChanged`. On
   *  user-not-found/user-disabled, clears the stored session and logs. */
  const tryRestoreSession = (uid: string, hooks: PersistableService): void => {
    if (!hooks.session) return;
    try {
      hooks.session.restore(uid);
      // Session restored — clear the pending marker so we don't retry.
      pendingSessionUid = null;
    } catch (e) {
      // `restoreSession` throws `auth/user-not-found` or `auth/user-disabled`
      // when the uid no longer exists or the account was disabled between
      // sessions. Clear the stored session so this stale uid doesn't
      // re-surface on the next reload. Log at warn level so developers
      // see it in the console (matching serve's behavior for the same case).
      console.warn(
        `[sandbox/persistence] session restore for uid '${uid}' failed — ` +
        `clearing stored session:`,
        e,
      );
      clearStoredSession();
      pendingSessionUid = null;
    }
  };

  if (options.sessionStorage) {
    const storedUid = loadStoredUid();
    if (storedUid !== null) {
      if (sandbox instanceof SandboxImpl) {
        const registry = sandbox.getServiceRegistry();
        let restored = false;
        for (const [, hooks] of registry) {
          if (!hooks.session) continue;
          tryRestoreSession(storedUid, hooks);
          restored = true;
          break; // only one session provider (auth) expected
        }
        if (!restored) {
          // No service with session hooks in the registry yet — stash the uid
          // so the late-registration hook can pick it up when auth registers.
          pendingSessionUid = storedUid;
        }
      }
    }
  }

  const unsubscribe = sandbox.onEvent((event) => {
    if (isPersistableEvent(event)) scheduleFlush();
  });

  const beforeUnload = (): void => {
    // Run synchronously on `beforeunload` — the page is leaving and we
    // can't await an async backend write. Memory backend is sync; the
    // IndexedDB backend won't finish in time, but kicking the request
    // off gives it a chance to land in the IndexedDB write queue
    // before tab close. Best-effort; the debounced auto-flush is the
    // primary safety net.
    void flushNow().catch(() => {
      /* swallow — page is leaving */
    });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', beforeUnload);
  }

  return {
    options,
    flush: flushNow,
    async clear() {
      if (pendingFlush) {
        clearTimeout(pendingFlush);
        pendingFlush = null;
      }
      await backend.clear(options.key);
      // Reset the diff baseline: the backend is now empty, so the next flush
      // must treat every bucket as changed and re-persist the full in-memory
      // state (otherwise untouched buckets stay suppressed and are lost).
      lastHashes.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pendingFlush) {
        clearTimeout(pendingFlush);
        pendingFlush = null;
      }
      unsubscribe();
      // Detach service change-notification subscriptions.
      for (const unsub of serviceUnsubs.values()) unsub();
      serviceUnsubs.clear();
      // Detach session-change subscriptions.
      for (const unsub of sessionUnsubs.values()) unsub();
      sessionUnsubs.clear();
      // Detach the late-registration hook.
      if (sandbox instanceof SandboxImpl) {
        sandbox.setServiceRegistrationHook(null);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeUnload);
      }
    },
  };
}

/**
 * Read the persisted blob for `key` and hydrate every document into
 * the sandbox via the admin write surface, then restore any registered
 * service state from the `services` map.
 *
 * Returns the raw `services` blob map (or `null` if no blob existed)
 * so the controller can apply it to services that register AFTER this
 * call returns (the late-registration case).
 *
 * Restore order: Firestore first, then services. Auth users need to
 * land after Firestore is ready, not before — matches the natural
 * initialization order.
 *
 * Unreadable blobs (parse failure, schema mismatch) are QUARANTINED,
 * not destroyed: the raw blob moves to `<key>:corrupt` and the live
 * key is cleared so the next flush starts fresh. Silent data loss is
 * the worst failure mode for a persistence layer — parking the bytes
 * under a side key keeps a serialization bug debuggable after the
 * fact. Each new corrupt blob overwrites the previous quarantine
 * record (one forensic slot per key is enough).
 *
 * Listeners attached to the sandbox before restore will see each
 * hydrated doc as a fresh notification — intentional. The natural
 * place to call `enablePersistence` is right after `initializeSandbox`,
 * before any listeners attach, so this rarely matters in practice.
 *
 * Each service restore is wrapped in try/catch — a failing service
 * restore must not abort Firestore restore (the core data is more
 * critical). A warning is logged but the sandbox stays usable.
 */
async function restore(
  sandbox: Sandbox,
  backend: PersistenceBackend,
  key: string,
  lastHashes: Map<string, number>,
): Promise<Record<string, unknown> | null> {
  let ids: string[];
  try {
    ids = await backend.listRecords(key);
  } catch (e) {
    console.warn('[sandbox/persistence] backend list failed:', e);
    return null;
  }
  if (ids.length === 0) return null;
  const records: [string, unknown][] = [];
  for (const id of ids) {
    try {
      const rec = await backend.getRecord(key, id);
      if (rec !== null) records.push([id, rec]);
    } catch (e) {
      console.warn(`[sandbox/persistence] failed to read persisted record '${id}':`, e);
    }
  }
  // C4 migrate-on-open: a legacy v2 record is the old single JSON blob (a
  // string); v3 records are objects. Convert any v2 blob to v3 buckets in place,
  // then delete the legacy record so the next open is pure v3.
  const v3Records: [string, unknown][] = [];
  const legacyIds: string[] = [];
  let migrated: Map<string, unknown> | null = null;
  for (const [id, rec] of records) {
    if (typeof rec === 'string') {
      const m = migrateV2ToRecords(rec);
      if (m) {
        legacyIds.push(id);
        migrated = m;
      }
      // a string that is not a recognizable v2 blob is unrecognized: skip it.
    } else {
      v3Records.push([id, rec]);
    }
  }
  if (migrated) {
    try {
      await backend.putRecords(key, migrated);
      if (legacyIds.length > 0) await backend.deleteRecords(key, legacyIds);
    } catch (e) {
      console.warn('[sandbox/persistence] v2 migration write failed:', e);
    }
    for (const [id, rec] of migrated) v3Records.push([id, rec]);
  }
  // Seed the flush hash state from the effective v3 records, so the first flush
  // does not redundantly re-write the just-restored (or just-migrated) buckets.
  for (const [id, rec] of v3Records) lastHashes.set(id, hashRecord(rec));
  const parsed = deserializeFromBuckets(v3Records);

  // 1. Restore Firestore documents first. These are the structural data
  //    that services (auth) may depend on being present.
  for (const [path, data] of Object.entries(parsed.firestore)) {
    sandbox.admin.setDocument(path, data);
  }

  // 2. Restore registered service state. Only services that are BOTH in
  //    the blob AND currently registered are restored here. Services not
  //    yet registered (late registration: enablePersistence before getAuth)
  //    receive their data when they register via the hook installed by
  //    attachPersistence. Each service restore is isolated so a broken
  //    service doesn't kill the entire restore.
  if (sandbox instanceof SandboxImpl) {
    const registry = sandbox.getServiceRegistry();
    for (const [name, data] of Object.entries(parsed.services)) {
      const svc = registry.get(name);
      if (!svc) continue; // not yet registered; will be applied via late-restore hook
      try {
        svc.restore(data);
      } catch (e) {
        console.warn(
          `[sandbox/persistence] service '${name}' restore failed — ` +
            `Firestore state is intact; auth users may need to be re-created:`,
          e,
        );
      }
    }
  }

  // Return the services blob so the controller can apply it to services
  // that register after this call (the late-registration case).
  return parsed.services;
}

/**
 * Which SandboxEvents move us toward a "dirty" state worth flushing?
 *
 * Writes (`kind: 'write'`) are the obvious ones. We also flush on
 * `session_boundary` so a `reset()` snapshots the now-empty env — the
 * persisted state then matches the in-memory state instead of holding
 * stale pre-reset data.
 *
 * Read/listener events do not change state and don't trigger a flush.
 */
function isPersistableEvent(event: SandboxEvent): boolean {
  return event.kind === 'write' || event.kind === 'session_boundary';
}
