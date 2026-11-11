/**
 * Local in-process `pyric-admin/database` arm backed by the shared
 * `pyric/database` `RtdbBackend` per `(Sandbox, DatabaseInstance)`.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  createDatabaseInstanceRegistry,
  type DatabaseInstance,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import {
  getAdminDatabase,
  TARGET_SYMBOL,
  type Database as ModularDatabase,
} from 'pyric/database';
import {
  assertGettablePath,
  emptySpec,
  isDefaultQuerySpec,
  type QueryRow,
  type QuerySpec,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
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
  type LocalListenTarget,
} from './local-listeners.js';
import { createQuerySurface } from './query.js';
import {
  joinPath,
  pathSegments,
  settled,
  validateValueArg,
  validateValuesArg,
} from './tree-store.js';
import {
  notImplemented,
  type Database,
  type DataSnapshot,
  type JsonValue,
  type Reference,
  type ThenableReference,
} from './types.js';

interface SharedRtdbBackend {
  adminGet(path: string): JsonValue;
  adminGetQuery(path: string, spec: QuerySpec): QueryRow[];
  adminOnValue(
    path: string,
    cb: (snap: { val: JsonValue; exists: boolean; key: string | null; rows?: QueryRow[] }) => void,
    query?: QuerySpec,
  ): () => void;
  adminSet(path: string, value: JsonValue): void;
  adminUpdate(path: string, patch: Record<string, JsonValue>): void;
  adminRemove(path: string): void;
  mintKey(): string;
  resetTree(preserveRules?: boolean): void;
}

interface LocalInstance {
  adminDb?: ModularDatabase;
  backend?: SharedRtdbBackend;
  readonly listeners: AdminListenerTable;
  readonly sandbox: Sandbox;
}

const localInstancesBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<LocalInstance>>();

function resolveSharedHandle(
  sandbox: Sandbox,
  instance: DatabaseInstance | undefined,
): { adminDb: ModularDatabase; backend: SharedRtdbBackend } {
  const adminDb = getAdminDatabase(sandbox, instance?.url);
  const { backend } = (adminDb as unknown as {
    [TARGET_SYMBOL]: { backend: SharedRtdbBackend };
  })[TARGET_SYMBOL];
  return { adminDb, backend };
}

function localInstances(sandbox: Sandbox): DatabaseInstanceRegistry<LocalInstance> {
  const existing = localInstancesBySandbox.get(sandbox);
  if (existing !== undefined) return existing;
  const registry: DatabaseInstanceRegistry<LocalInstance> = createDatabaseInstanceRegistry({
    create: () => ({ sandbox, listeners: new AdminListenerTable() }),
  });
  localInstancesBySandbox.set(sandbox, registry);
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'reset') {
      for (const [, entry] of registry.entries()) entry.backend?.resetTree(true);
    }
  });
  return registry;
}

export function getLocalDatabase(
  app: PyricAdminApp,
  sandbox: Sandbox,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  const registry = localInstances(sandbox);
  const entry = registry.getOrCreate(registry.keyOf(instance));
  if (entry.backend === undefined || entry.adminDb === undefined) {
    const resolved = resolveSharedHandle(sandbox, instance);
    entry.adminDb = resolved.adminDb;
    entry.backend = resolved.backend;
  }
  const instanceState = entry as Required<LocalInstance>;
  return buildDatabaseShell(app, urlMeta, (handle, path, meta) =>
    buildSandboxRef(instanceState, handle, path, meta),
  );
}

function buildSandboxRef(
  instanceState: Required<LocalInstance>,
  db: Database,
  path: string,
  urlMeta: DatabaseUrlMetadata,
): Reference {
  const { adminDb, backend, listeners } = instanceState;
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const formattedUrl = formatReferenceUrl(urlMeta.originUrl, segs);
  const refAt = (p: string): Reference => buildSandboxRef(instanceState, db, p, urlMeta);
  const listenTarget: LocalListenTarget = {
    adminDb,
    backend,
    listeners,
    canonical,
    refAt,
  };

  const querySurface = createQuerySurface(
    {
      repoToken: backend,
      canonicalPath: canonical,
      formattedUrl,
      getBaseRef: () => ref as unknown as Reference,
      async get(spec: QuerySpec): Promise<DataSnapshot> {
        assertGettablePath(canonical);
        if (!isDefaultQuerySpec(spec)) {
          const rows = backend.adminGetQuery(canonical, spec);
          return buildLocalQuerySnapshot(refAt, adminDb, canonical, segs, rows);
        }
        const val = backend.adminGet(canonical);
        return buildSandboxSnap(refAt, canonical, val, exportedLocalValueAt(adminDb, segs, val));
      },
      once: (spec, eventType, successCb, failureCallbackOrContext, context) =>
        onceLocalListener(listenTarget, spec, eventType, successCb, failureCallbackOrContext, context),
      on: (spec, eventType, callback, cancelCallbackOrContext, context) =>
        attachLocalListener(listenTarget, spec, eventType, callback, cancelCallbackOrContext, context),
      off: (spec, eventType, callback, context) =>
        detachLocalListener(listenTarget, spec, eventType, callback, context),
    },
    emptySpec(),
  );

  const ref = {
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
      const stored = validateValueArg('set', segs, value);
      return settled(() => {
        backend.adminSet(canonical, stored);
      }, onComplete);
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      const patch = validateValuesArg(segs, values);
      return settled(() => {
        if (Object.keys(patch).length > 0) {
          backend.adminUpdate(canonical, patch);
        }
      }, onComplete);
    },

    remove(onComplete?: (err: Error | null) => void): Promise<void> {
      return settled(() => backend.adminRemove(canonical), onComplete);
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      const stored = value === undefined ? undefined : validateValueArg('push', segs, value);
      const id = backend.mintKey();
      const childPath = joinPath([...segs, id]);
      let writeOutcome: Promise<void>;
      if (stored !== undefined) {
        writeOutcome = settled(() => {
          backend.adminSet(childPath, stored);
        }, onComplete);
      } else {
        writeOutcome = settled(() => {}, onComplete);
      }
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

    onDisconnect(): never {
      throw notImplemented('onDisconnect');
    },
    transaction(..._args: unknown[]): never {
      throw notImplemented('transaction');
    },
    setPriority(..._args: unknown[]): never {
      throw notImplemented('setPriority');
    },
    setWithPriority(..._args: unknown[]): never {
      throw notImplemented('setWithPriority');
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
