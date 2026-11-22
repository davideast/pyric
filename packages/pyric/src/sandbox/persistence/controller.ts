/**
 * Persistence controller -- wires a `PersistenceBackend` into a
 * `SandboxImpl`. Owns the debounced auto-flush, the `beforeunload`
 * safety flush, and the restore-on-attach pass.
 *
 * Conceptually orthogonal to the sandbox: the sandbox does not know
 * persistence exists until `enablePersistence` constructs a controller
 * and hands it the live sandbox. Disposing the controller detaches
 * every side effect and leaves the sandbox unchanged.
 */

import { getClock } from '../clock.js';
import { SandboxImpl } from '../internal/sandbox-impl.js';
import type { SandboxEvent } from '../types/events.js';
import type { PersistableService } from '../types/persistence.js';
import type { Sandbox } from '../types/service.js';
import { createIndexedDBBackend, createMemoryBackend } from './backends.js';
import { ChangedBuckets } from './changed-buckets.js';
import { CHUNK_FORMAT_VERSION, META_RECORD_ID, serializeToBuckets } from './chunk-format.js';
import { hashSerialized, restoreSnapshot } from './restore.js';
import { isRtdbRecordId, serializeRtdbServiceToRecords } from './rtdb-records.js';
import { createSessionPersistence } from './session-persistence.js';
import type { PersistenceBackend, SandboxPersistenceOptions } from './types.js';

const DEFAULT_FLUSH_INTERVAL_MS = 250;

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

/**
 * Which SandboxEvents move us toward a "dirty" state worth flushing?
 *
 * Writes (`kind: 'write'`) are the obvious ones. We also flush on
 * `session_boundary` so a `reset()` snapshots the now-empty env -- the
 * persisted state then matches the in-memory state instead of holding
 * stale pre-reset data.
 *
 * Read/listener events do not change state and do not trigger a flush.
 */
function isPersistableEvent(event: SandboxEvent): boolean {
  return event.kind === 'write' || event.kind === 'session_boundary';
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
 *   1. `restoreSnapshot()` returns the raw `services` blob map so the
 *      controller can apply it to late-arriving services.
 *   2. `setServiceRegistrationHook` fires on each registration -- we
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
  // whose content actually changed. restoreSnapshot() seeds it from the records
  // it reads, so the just-restored state is not redundantly re-written on the
  // first flush.
  const lastHashes = new Map<string, number>();
  const staleIds = new Set<string>();
  const restored = await restoreSnapshot(sandbox, backend, options.key, lastHashes, staleIds);
  let preserveIncompatible = restored.preserveIncompatible;
  const pendingServices = new Map(Object.entries(restored.services ?? {}));
  const serviceSnapshots = new Map<string, unknown>();

  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Track unsubscribers for service change-notification hooks so we can
  // clean up in dispose(). Keyed by service name.
  const serviceUnsubs = new Map<string, () => void>();

  const localSandbox = sandbox instanceof SandboxImpl ? sandbox : null;
  const isPartitionedServiceRecord = (id: string): boolean => {
    if (isRtdbRecordId(id)) return true;
    if (!localSandbox) return false;
    for (const svc of localSandbox.getServiceRegistry().values()) {
      if (svc.records && id.startsWith(svc.records.prefix)) return true;
    }
    return false;
  };
  let changedBuckets: ChangedBuckets | null = null;
  if (localSandbox !== null) {
    const persistedBucketIds = [...lastHashes.keys()].filter(
      id => id !== META_RECORD_ID && !isPartitionedServiceRecord(id),
    );
    changedBuckets = new ChangedBuckets(
      () => localSandbox.getEnv().snapshot(),
      path => localSandbox.getEnv().getDocument(path),
      persistedBucketIds,
    );
  }

  // Prepare immutable records before awaiting the backend; later mutations stay dirty.
  const realFlush = async (): Promise<void> => {
    if (disposed || preserveIncompatible) return;
    const prepared = changedBuckets?.prepare();
    const servicePrepared: Array<{
      records: Map<string, unknown>;
      removed: string[];
      retry(): void;
    }> = [];
    try {
      const services = { ...Object.fromEntries(pendingServices) };
      if (localSandbox) {
        for (const [name, pending] of localSandbox.getPendingSnapshotServices()) {
          services[name] = structuredClone(pending);
        }
      }
      let records: Map<string, unknown>;
      let removed: string[];
      const usesChangedBuckets = prepared !== undefined && localSandbox !== null;
      if (usesChangedBuckets) {
        // When `restoreSnapshot()` reconstructed `services.rtdb` from `rtdb:*`
        // records before lazy `getDatabase(sandbox)` registered the RTDB service,
        // keep `rtdb` out of `meta.services` (emitting `rtdb:*` records only if
        // none are tracked yet).
        if ('rtdb' in services) {
          const pendingRtdb = services.rtdb;
          delete services.rtdb;
          const hasPersistedRtdb = [...lastHashes.keys()].some(isRtdbRecordId);
          if (!hasPersistedRtdb) {
            const reemitted = serializeRtdbServiceToRecords(pendingRtdb);
            if (reemitted !== null) {
              servicePrepared.push({ records: reemitted, removed: [], retry() {} });
            }
          }
        }
        for (const [name, service] of localSandbox.getServiceRegistry()) {
          if (service.records) {
            delete services[name];
            servicePrepared.push(service.records.prepare());
            continue;
          }
          const needsSnapshot = !service.subscribe || !serviceSnapshots.has(name);
          if (needsSnapshot) serviceSnapshots.set(name, structuredClone(service.snapshot()));
          services[name] = serviceSnapshots.get(name);
        }
        records = new Map(prepared.records);
        removed = [...prepared.removed];
        for (const svcPrep of servicePrepared) {
          for (const [id, rec] of svcPrep.records) records.set(id, rec);
          removed.push(...svcPrep.removed);
        }
        records.set(META_RECORD_ID, {
          version: CHUNK_FORMAT_VERSION,
          savedAt: getClock(sandbox).now(),
          services,
        });
      } else {
        const snap = sandbox.snapshot();
        records = serializeToBuckets(
          snap.firestore,
          { ...services, ...snap.services },
          getClock(sandbox).now(),
        );
        removed = [...lastHashes.keys()].filter(id => !records.has(id));
      }
      if (staleIds.size > 0) {
        const removedSet = new Set(removed);
        for (const id of staleIds) {
          if (!records.has(id) && !removedSet.has(id)) {
            removed.push(id);
            removedSet.add(id);
          }
        }
      }
      const changed = new Map<string, unknown>();
      const serializedChanged = new Map<string, string>();
      const nextHashes = new Map<string, number>();
      for (const [id, record] of records) {
        const serialized = JSON.stringify(record);
        const hash = serialized === undefined ? 0 : hashSerialized(serialized);
        nextHashes.set(id, hash);
        const changedHash = lastHashes.get(id) !== hash || staleIds.has(id);
        if (changedHash) {
          changed.set(id, record);
          if (serialized !== undefined) serializedChanged.set(id, serialized);
        }
      }
      const applyChanges = backend.applyChanges;
      const commitsAtomically = applyChanges !== undefined;
      if (commitsAtomically) {
        await applyChanges(options.key, changed, removed, serializedChanged);
      } else {
        const hasChanges = changed.size > 0;
        if (hasChanges) await backend.putRecords(options.key, changed);
        const hasRemovals = removed.length > 0;
        if (hasRemovals) await backend.deleteRecords(options.key, removed);
      }
      staleIds.clear();
      for (const id of removed) lastHashes.delete(id);
      for (const [id, hash] of nextHashes) lastHashes.set(id, hash);
    } catch (error) {
      prepared?.retry();
      for (const svcPrep of servicePrepared) svcPrep.retry();
      throw error;
    }
  };

  // Serialize flushes on a single chain so two never overlap, and coalesce
  // concurrent callers onto one queued flush behind any in-flight flush.
  let flushChain: Promise<void> = Promise.resolve();
  let queuedFlush: Promise<void> | null = null;
  const flushNow = (): Promise<void> => {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    if (queuedFlush !== null) return queuedFlush;
    const next = flushChain.then(() => {
      queuedFlush = null;
      return realFlush();
    });
    queuedFlush = next;
    flushChain = next.then(() => {}, () => {});
    return next;
  };

  const scheduleFlush = (): void => {
    if (disposed || preserveIncompatible) return;
    const alreadyScheduled = pendingFlush !== null;
    if (alreadyScheduled) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      void flushNow().catch((e) => {
        const quotaExceeded = isQuotaExceeded(e);
        if (quotaExceeded) {
          // Storage is full: retrying will not help until space is freed, so
          // warn loudly instead of busy-looping. The unpersisted changes stay in
          // memory; the next successful flush (after space frees) re-detects them.
          console.warn(
            '[sandbox/persistence] storage quota exceeded; recent changes are kept ' +
              'in memory only. Free storage or reduce sandbox data to persist them.',
          );
          return;
        }
        const requiresRepair = backend.retryFailedFlush === false;
        if (requiresRepair) {
          console.warn('[sandbox/persistence] auto-flush failed; repair and restart required.');
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
   * trigger a debounced flush -- not only the next Firestore write.
   */
  const attachServiceSubscription = (name: string, hooks: PersistableService): void => {
    if (!hooks.subscribe || serviceUnsubs.has(name)) return;
    const unsub = hooks.subscribe(() => {
      serviceSnapshots.delete(name);
      scheduleFlush();
    });
    serviceUnsubs.set(name, unsub);
  };

  const sessions = createSessionPersistence(options.sessionStorage);

  const ownsServiceRegistry = sandbox instanceof SandboxImpl;
  if (ownsServiceRegistry) {
    for (const [name, hooks] of sandbox.getServiceRegistry()) {
      pendingServices.delete(name);
      if (hooks.records) {
        const prefix = hooks.records.prefix;
        hooks.records.init?.([...lastHashes.keys()].filter(id => id.startsWith(prefix)));
      }
      attachServiceSubscription(name, hooks);
      sessions.restoreSessionForService(name, hooks);
      // Restore before subscribing: restore(mode, uid) can emit session
      // changes, and a fresh Auth backend defaults to LOCAL. Subscribing first
      // would rewrite a stored SESSION uid into localStorage mid-restore.
      sessions.attachSessionSubscription(name, hooks);
    }
    sandbox.setServiceRegistrationHook((name, hooks) => {
      serviceSnapshots.delete(name);
      const hasPendingState = pendingServices.has(name);
      if (hasPendingState) {
        try {
          hooks.restore(pendingServices.get(name));
          pendingServices.delete(name);
        } catch (error) {
          console.warn(`[sandbox/persistence] late-restore for service '${name}' failed:`, error);
        }
      }
      if (hooks.records) {
        const prefix = hooks.records.prefix;
        hooks.records.init?.([...lastHashes.keys()].filter(id => id.startsWith(prefix)));
      }
      sessions.loadAndRememberPending(name);
      sessions.restoreSessionForService(name, hooks);
      attachServiceSubscription(name, hooks);
      sessions.attachSessionSubscription(name, hooks);
      scheduleFlush();
    });
    sandbox.setServiceUnregistrationHook((name) => {
      serviceSnapshots.delete(name);
      serviceUnsubs.get(name)?.();
      serviceUnsubs.delete(name);
      sessions.unregisterService(name);
      // Keep the web-storage uid: deleting and recreating a FirebaseApp does
      // not mean signing that app name out. A replacement registration may
      // restore it through the normal late-registration path.
      scheduleFlush();
    });
  }

  const unsubscribeDocuments = localSandbox?.onDocumentChange(path => {
    changedBuckets?.mark(path);
    const replacesState = path === null;
    if (replacesState) {
      serviceSnapshots.clear();
      pendingServices.clear();
      const rtdbRegistered = localSandbox.getServiceRegistry().has('rtdb');
      if (!rtdbRegistered) {
        for (const id of [...lastHashes.keys()]) {
          if (isRtdbRecordId(id)) {
            staleIds.add(id);
            lastHashes.delete(id);
          }
        }
      }
    }
    scheduleFlush();
  });
  const unsubscribe = sandbox.onEvent((event) => {
    if (isPersistableEvent(event)) scheduleFlush();
  });

  const beforeUnload = (): void => {
    // Run synchronously on `beforeunload` -- the page is leaving and we
    // cannot await an async backend write. Memory backend is sync; the
    // IndexedDB backend will not finish in time, but kicking the request
    // off gives it a chance to land in the IndexedDB write queue
    // before tab close. Best-effort; the debounced auto-flush is the
    // primary safety net.
    void flushNow().catch(() => {
      // Page is leaving; best-effort flush errors cannot be recovered here.
    });
  };

  const inBrowser = typeof window !== 'undefined';
  if (inBrowser) {
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
      preserveIncompatible = false;
      // Reset the diff baseline: the backend is now empty, so the next flush
      // must treat every bucket as changed and re-persist the full in-memory
      // state (otherwise untouched buckets stay suppressed and are lost).
      lastHashes.clear();
      staleIds.clear();
      changedBuckets?.mark(null);
      if (localSandbox) {
        for (const svc of localSandbox.getServiceRegistry().values()) {
          svc.records?.markAll?.();
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pendingFlush) {
        clearTimeout(pendingFlush);
        pendingFlush = null;
      }
      unsubscribe();
      unsubscribeDocuments?.();
      for (const unsub of serviceUnsubs.values()) unsub();
      serviceUnsubs.clear();
      sessions.dispose();
      if (sandbox instanceof SandboxImpl) {
        sandbox.setServiceRegistrationHook(null);
        sandbox.setServiceUnregistrationHook(null);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeUnload);
      }
    },
  };
}
