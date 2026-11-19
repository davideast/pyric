/**
 * Local in-process `pyric-admin/database` arm backed by the shared
 * `pyric/database` `RtdbBackend` per `(Sandbox, DatabaseInstance)`.
 */

import type { Sandbox } from 'pyric/sandbox';
import type { DatabaseInstance } from 'pyric/sandbox/internal';
import {
  getAdminDatabase,
  TARGET_SYMBOL,
  type Database as ModularDatabase,
} from 'pyric/database';
import {
  assertGettablePath,
  emptySpec,
  hasNonFiniteQueryLimit,
  isDefaultQuerySpec,
  loadsAllData,
  type Priority,
  type QueryReadResult,
  type QuerySpec,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  createAdminServiceLifecycle,
  onAdminAppDeleted,
  type AdminServiceLifecycle,
} from '../app/lifecycle.js';
import {
  localDatabaseRulesControls,
  type LocalRulesBackend,
} from './admin-rules.js';
import {
  AdminPathCache,
  runLocalAdminTransaction,
  type AdminTransactionOnComplete,
  type AdminTransactionUpdate,
} from './admin-transaction.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { buildSandboxSnap } from './data-snapshot.js';
import { AdminListenerTable } from './listener-table.js';
import {
  attachLocalListener,
  buildLocalQuerySnapshot,
  detachLocalListener,
  exportedLocalValueAt,
  onceLocalListener,
  type LocalListenBackend,
  type LocalListenTarget,
} from './local-listeners.js';
import { emitAdminDatabaseLog } from './logging.js';
import {
  buildLocalOnDisconnect,
  localDatabaseConnectionControls,
} from './on-disconnect.js';
import { createQuerySurface } from './query.js';
import {
  absentNodeSetPriorityError,
  generatePushId,
  joinPath,
  pathSegments,
  settled,
  validateAdminPriorityArg,
  validateValueArg,
  validateValuesArg,
} from './tree-store.js';
import {
  ADMIN_REFERENCE_BRAND,
  validateCallbackArg,
  type Database,
  type DataSnapshot,
  type JsonValue,
  type OnDisconnect,
  type Reference,
  type ThenableReference,
} from './types.js';

interface SharedRtdbBackend extends LocalListenBackend, LocalRulesBackend {
  adminGetQuery(path: string, spec: QuerySpec): QueryReadResult;
  adminSet(path: string, value: JsonValue): void;
  adminSetWithPriority(path: string, value: JsonValue, priority: Priority): void;
  adminSetPriority(path: string, priority: Priority): void;
  adminUpdate(path: string, patch: Record<string, JsonValue>): void;
  adminRemove(path: string): void;
  mintKey(): string;
  resetTree(preserveRules?: boolean): void;
}

interface LocalInstance {
  adminDb?: ModularDatabase;
  backend?: SharedRtdbBackend;
  readonly cache: AdminPathCache;
  readonly lifecycle: AdminServiceLifecycle;
  readonly listeners: AdminListenerTable;
  readonly sandbox: Sandbox;
}

const localInstancesByApp = new WeakMap<PyricAdminApp, Map<string, LocalInstance>>();
const resetBackendsBySandbox = new WeakMap<Sandbox, Set<SharedRtdbBackend>>();

function registerBackendForReset(sandbox: Sandbox, backend: SharedRtdbBackend): void {
  let tracked = resetBackendsBySandbox.get(sandbox);
  if (tracked === undefined) {
    tracked = new Set();
    resetBackendsBySandbox.set(sandbox, tracked);
    sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        for (const registered of tracked!) {
          registered.resetTree(true);
        }
      }
    });
  }
  tracked.add(backend);
}

function resolveSharedHandle(
  sandbox: Sandbox,
  instance: DatabaseInstance | undefined,
): { adminDb: ModularDatabase; backend: SharedRtdbBackend } {
  const adminDb = getAdminDatabase(sandbox, instance?.url);
  const { backend } = (adminDb as unknown as {
    [TARGET_SYMBOL]: { backend: SharedRtdbBackend };
  })[TARGET_SYMBOL];
  registerBackendForReset(sandbox, backend);
  return { adminDb, backend };
}

function localInstances(app: PyricAdminApp): Map<string, LocalInstance> {
  const existing = localInstancesByApp.get(app);
  if (existing !== undefined) return existing;
  const instances = new Map<string, LocalInstance>();
  localInstancesByApp.set(app, instances);
  onAdminAppDeleted(app, async () => {
    const drains: Promise<void>[] = [];
    for (const [, entry] of instances.entries()) {
      entry.listeners.detachAll();
      if (entry.adminDb !== undefined) {
        const { connection } = (entry.adminDb as unknown as {
          [TARGET_SYMBOL]: { connection: { drain(): Promise<void> } };
        })[TARGET_SYMBOL];
        drains.push(connection.drain().catch(() => undefined));
      }
    }
    if (drains.length > 0) {
      await Promise.all(drains);
    }
  });
  return instances;
}

export function getLocalDatabase(
  app: PyricAdminApp,
  sandbox: Sandbox,
  cacheKey: string,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  const instances = localInstances(app);
  let entry = instances.get(cacheKey);
  if (entry === undefined) {
    const cache = new AdminPathCache();
    sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        cache.reset();
      }
    });
    entry = {
      sandbox,
      cache,
      lifecycle: createAdminServiceLifecycle(app),
      listeners: new AdminListenerTable(),
    };
    instances.set(cacheKey, entry);
  }
  if (entry.backend === undefined || entry.adminDb === undefined) {
    const resolved = resolveSharedHandle(sandbox, instance);
    entry.adminDb = resolved.adminDb;
    entry.backend = resolved.backend;
  }
  const instanceState = entry as Required<LocalInstance>;
  return buildDatabaseShell(
    app,
    urlMeta,
    (handle, path, meta) => buildSandboxRef(instanceState, handle, path, meta),
    localDatabaseConnectionControls(instanceState.adminDb),
    instanceState.lifecycle,
    localDatabaseRulesControls(instanceState.backend, instanceState.lifecycle),
  );
}

function buildSandboxRef(
  instanceState: Required<LocalInstance>,
  db: Database,
  path: string,
  urlMeta: DatabaseUrlMetadata,
): Reference {
  const { adminDb, backend, cache, lifecycle, listeners } = instanceState;
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  let key: string | null = null;
  if (segs.length > 0) {
    const lastSeg = segs[segs.length - 1];
    if (lastSeg !== undefined) {
      key = lastSeg;
    }
  }
  const formattedUrl = formatReferenceUrl(urlMeta.originUrl, segs);
  const refAt = (p: string): Reference => buildSandboxRef(instanceState, db, p, urlMeta);
  const listenTarget: LocalListenTarget = {
    adminDb,
    backend,
    lifecycle,
    listeners,
    canonical,
    refAt,
  };

  const querySurface = createQuerySurface(
    {
      repoToken: instanceState,
      canonicalPath: canonical,
      formattedUrl,
      getBaseRef: () => ref as unknown as Reference,
      async get(spec: QuerySpec): Promise<DataSnapshot> {
        assertGettablePath(canonical);
        lifecycle.assertActive();
        emitAdminDatabaseLog('get', canonical);
        if (hasNonFiniteQueryLimit(spec)) {
          return new Promise<DataSnapshot>(() => {});
        }
        if (!isDefaultQuerySpec(spec)) {
          const result = backend.adminGetQuery(canonical, spec);
          return buildLocalQuerySnapshot(refAt, adminDb, canonical, segs, result.rows, loadsAllData(spec), result.val);
        }
        const val = backend.adminGet(canonical);
        cache.markWarm(canonical);
        return buildSandboxSnap(refAt, canonical, val, exportedLocalValueAt(adminDb, segs, val));
      },
      once: (spec, eventType, successCb, failureCallbackOrContext, context) => {
        emitAdminDatabaseLog('once', canonical);
        if (isDefaultQuerySpec(spec)) {
          cache.markWarm(canonical);
        }
        return onceLocalListener(listenTarget, spec, eventType, successCb, failureCallbackOrContext, context);
      },
      on: (spec, eventType, callback, cancelCallbackOrContext, context) => {
        emitAdminDatabaseLog('on', canonical);
        if (isDefaultQuerySpec(spec)) {
          cache.markWarm(canonical);
        }
        return attachLocalListener(listenTarget, spec, eventType, callback, cancelCallbackOrContext, context);
      },
      off: (spec, eventType, callback, context) =>
        detachLocalListener(listenTarget, spec, eventType, callback, context),
    },
    emptySpec(),
  );

  const ref = {
    [ADMIN_REFERENCE_BRAND]: true,
    ...querySurface,
    key,
    get parent(): Reference | null {
      if (segs.length === 0) return null;
      return refAt(joinPath(segs.slice(0, -1)));
    },
    get root(): Reference {
      return refAt('/');
    },
    get path(): string {
      return canonical;
    },

    set(value: unknown, onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.set', 'onComplete', onComplete, true);
      const stored = validateValueArg('set', segs, value);
      emitAdminDatabaseLog('set', canonical);
      return settled(() => {
        lifecycle.assertActive();
        backend.adminSet(canonical, stored);
        cache.markWarm(canonical);
      }, onComplete);
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.update', 'onComplete', onComplete, true);
      const patch = validateValuesArg(segs, values);
      emitAdminDatabaseLog('update', canonical);
      return settled(() => {
        lifecycle.assertActive();
        if (Object.keys(patch).length > 0) {
          backend.adminUpdate(canonical, patch);
          for (const relKey of Object.keys(patch)) {
            const relSegs = pathSegments(relKey);
            if (relSegs[relSegs.length - 1] !== '.priority') {
              cache.markWarm(joinPath([...segs, ...relSegs]));
            }
          }
        }
      }, onComplete);
    },

    remove(onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.remove', 'onComplete', onComplete, true);
      emitAdminDatabaseLog('remove', canonical);
      return settled(() => {
        lifecycle.assertActive();
        backend.adminRemove(canonical);
        cache.markWarm(canonical);
      }, onComplete);
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      validateCallbackArg('Reference.push', 'onComplete', onComplete, true);
      let stored: JsonValue | undefined;
      if (value !== undefined) {
        stored = validateValueArg('push', segs, value);
      }
      emitAdminDatabaseLog('push', canonical);
      let id: string;
      let writeOutcome: Promise<void>;
      if (lifecycle.isDeleted) {
        id = generatePushId();
        writeOutcome = settled(() => {
          lifecycle.assertActive();
        }, onComplete);
      } else {
        id = backend.mintKey();
        const activeChildPath = joinPath([...segs, id]);
        if (stored !== undefined) {
          writeOutcome = settled(() => {
            backend.adminSet(activeChildPath, stored);
            cache.markWarm(activeChildPath);
          }, onComplete);
        } else {
          writeOutcome = settled(() => {}, onComplete);
        }
      }
      const childPath = joinPath([...segs, id]);
      writeOutcome.catch(() => {});
      const childRef = refAt(childPath);
      const resolvedRef = refAt(childPath);
      const outcome = writeOutcome.then(() => resolvedRef);
      outcome.catch(() => {});
      const thenable = childRef as Reference & PromiseLike<Reference>;
      (thenable as unknown as { then: PromiseLike<Reference>['then'] }).then = (
        onFulfilled,
        onRejected,
      ) => outcome.then(onFulfilled, onRejected);
      (thenable as unknown as { catch: <U>(onRejected: (reason: unknown) => U | PromiseLike<U>) => Promise<Reference | U> }).catch = (
        onRejected,
      ) => outcome.catch(onRejected);
      return thenable as ThenableReference;
    },

    child(p: string): Reference {
      const absSegs = [...segs, ...pathSegments(p)];
      return refAt(joinPath(absSegs));
    },

    onDisconnect(): OnDisconnect {
      return buildLocalOnDisconnect(adminDb, canonical, lifecycle);
    },
    transaction(
      transactionUpdate: AdminTransactionUpdate,
      onComplete?: AdminTransactionOnComplete,
      applyLocally?: boolean,
    ): Promise<{ committed: boolean; snapshot: DataSnapshot }> {
      return runLocalAdminTransaction({
        adminDb,
        cache,
        lifecycle,
        canonical,
        segs,
        refAt,
        transactionUpdate,
        onComplete,
        applyLocally,
      });
    },
    setPriority(
      priority: string | number | null,
      onComplete?: (error: Error | null) => unknown,
    ): Promise<void> {
      const validatedPriority = validateAdminPriorityArg('setPriority', priority);
      validateCallbackArg('Reference.setPriority', 'onComplete', onComplete, true);
      emitAdminDatabaseLog('setPriority', canonical);
      return settled(
        () => {
          lifecycle.assertActive();
          if (validatedPriority !== null && backend.adminGet(canonical) === null) {
            throw absentNodeSetPriorityError();
          }
          backend.adminSetPriority(canonical, validatedPriority);
        },
        onComplete as ((err: Error | null) => void) | undefined,
      );
    },
    setWithPriority(
      newVal: unknown,
      newPriority: string | number | null,
      onComplete?: (error: Error | null) => unknown,
    ): Promise<void> {
      const stored = validateValueArg('setWithPriority', segs, newVal);
      const validatedPriority = validateAdminPriorityArg('setWithPriority', newPriority);
      validateCallbackArg('Reference.setWithPriority', 'onComplete', onComplete, true);
      emitAdminDatabaseLog('setWithPriority', canonical);
      return settled(
        () => {
          lifecycle.assertActive();
          backend.adminSetWithPriority(canonical, stored, validatedPriority);
          cache.markWarm(canonical);
        },
        onComplete as ((err: Error | null) => void) | undefined,
      );
    },
    get database(): Database {
      return db;
    },
    get ref(): Reference {
      return ref as unknown as Reference;
    },
  };

  return ref as unknown as Reference;
}
