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
  exportDatabaseVal,
  isDefaultQuerySpec,
  valueAtChildPath,
  type QueryRow,
  type QuerySpec,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { buildSandboxSnap, type SnapshotChildEntry } from './data-snapshot.js';
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
  resolveOnceCallbacks,
  type Database,
  type DataSnapshot,
  type EventType,
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
  sandbox: Sandbox;
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
    create: () => ({ sandbox }),
  });
  localInstancesBySandbox.set(sandbox, registry);
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'reset') {
      for (const [, entry] of registry.entries()) entry.backend?.resetTree(true);
    }
  });
  return registry;
}

function exportedValueAt(
  adminDb: ModularDatabase,
  segs: readonly string[],
  val: JsonValue,
): unknown {
  if (val === null) return null;
  const rootExported = exportDatabaseVal(adminDb);
  return segs.length === 0 ? rootExported : valueAtChildPath(rootExported, segs);
}

function buildQuerySnapshot(
  refAt: (path: string) => Reference,
  adminDb: ModularDatabase,
  canonical: string,
  segs: readonly string[],
  rows: readonly QueryRow[],
): DataSnapshot {
  if (rows.length === 0) {
    return buildSandboxSnap(refAt, canonical, null, null, []);
  }
  const stored: Record<string, JsonValue> = {};
  for (const row of rows) {
    stored[row.key] = row.value;
  }
  const fullExport = exportedValueAt(adminDb, segs, stored);
  const exportedWindow: Record<string, unknown> = {};
  const isExportRecord =
    fullExport !== null &&
    typeof fullExport === 'object' &&
    !Array.isArray(fullExport);
  if (isExportRecord && Object.hasOwn(fullExport, '.priority')) {
    exportedWindow['.priority'] = (fullExport as Record<string, unknown>)['.priority'];
  }
  const entries: SnapshotChildEntry[] = [];
  for (const row of rows) {
    const rawChildExport = isExportRecord ? valueAtChildPath(fullExport, [row.key]) : null;
    const childExport = rawChildExport ?? row.value;
    exportedWindow[row.key] = childExport;
    entries.push({
      key: row.key,
      value: row.value,
      exportValue: childExport,
    });
  }
  return buildSandboxSnap(refAt, canonical, stored, exportedWindow, entries);
}

function readOneShotQueryRows(
  backend: SharedRtdbBackend,
  canonical: string,
  spec: QuerySpec,
): QueryRow[] {
  let capturedRows: QueryRow[] = [];
  const detach = backend.adminOnValue(
    canonical,
    (raw) => {
      capturedRows = raw.rows ?? [];
    },
    spec,
  );
  detach();
  return capturedRows;
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
  const instanceState = entry as Required<Pick<LocalInstance, 'adminDb' | 'backend' | 'sandbox'>>;
  return buildDatabaseShell(app, urlMeta, (handle, path, meta) =>
    buildSandboxRef(instanceState, handle, path, meta),
  );
}

function buildSandboxRef(
  instanceState: { adminDb: ModularDatabase; backend: SharedRtdbBackend; sandbox: Sandbox },
  db: Database,
  path: string,
  urlMeta: DatabaseUrlMetadata,
): Reference {
  const { adminDb, backend } = instanceState;
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const formattedUrl = formatReferenceUrl(urlMeta.originUrl, segs);
  const refAt = (p: string): Reference => buildSandboxRef(instanceState, db, p, urlMeta);

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
          return buildQuerySnapshot(refAt, adminDb, canonical, segs, rows);
        }
        const val = backend.adminGet(canonical);
        return buildSandboxSnap(refAt, canonical, val, exportedValueAt(adminDb, segs, val));
      },
      async once(
        spec: QuerySpec,
        eventType: EventType,
        successCb?: unknown,
        failureCallbackOrContext?: unknown,
        context?: unknown,
      ): Promise<DataSnapshot> {
        if (eventType !== 'value') {
          throw notImplemented(`once('${eventType}')`);
        }
        const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
        let snap: DataSnapshot;
        try {
          assertGettablePath(canonical);
          if (!isDefaultQuerySpec(spec)) {
            const rows = readOneShotQueryRows(backend, canonical, spec);
            snap = buildQuerySnapshot(refAt, adminDb, canonical, segs, rows);
          } else {
            const val = backend.adminGet(canonical);
            snap = buildSandboxSnap(refAt, canonical, val, exportedValueAt(adminDb, segs, val));
          }
        } catch (err) {
          if (failureCb !== undefined) {
            try {
              failureCb.call(boundContext, err as Error);
            } catch {
              // Ignore secondary callback throw before rejecting with the read error.
            }
          }
          throw err;
        }
        if (typeof successCb === 'function') {
          try {
            (successCb as (s: DataSnapshot) => unknown).call(boundContext, snap);
          } catch {
            // Callback error does not reject the once() promise once snapshot arrived.
          }
        }
        return snap;
      },
      on(_spec: QuerySpec, _eventType: EventType): never {
        throw notImplemented('on');
      },
      off(_spec: QuerySpec, _eventType?: EventType): never {
        throw notImplemented('off');
      },
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
