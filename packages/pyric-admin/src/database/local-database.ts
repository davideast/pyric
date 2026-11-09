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
  exportDatabaseVal,
  valueAtChildPath,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { buildSandboxSnap } from './data-snapshot.js';
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
  const refAt = (p: string): Reference => buildSandboxRef(instanceState, db, p, urlMeta);

  const ref = {
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
    toString(): string {
      return formatReferenceUrl(urlMeta.originUrl, segs);
    },

    set(value: unknown, onComplete?: (err: Error | null) => void): Promise<void> {
      const stored = validateValueArg('set', segs, value);
      return settled(() => {
        backend.adminSet(canonical, stored);
      }, onComplete);
    },

    async get(): Promise<DataSnapshot> {
      assertGettablePath(canonical);
      const val = backend.adminGet(canonical);
      return buildSandboxSnap(refAt, canonical, val, exportedValueAt(adminDb, segs, val));
    },

    async once(
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
        const val = backend.adminGet(canonical);
        snap = buildSandboxSnap(refAt, canonical, val, exportedValueAt(adminDb, segs, val));
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

    on(_eventType: EventType, ..._rest: unknown[]): never {
      throw notImplemented('on');
    },
    off(_eventType?: EventType, ..._rest: unknown[]): never {
      throw notImplemented('off');
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
    orderByChild(..._args: unknown[]): never {
      throw notImplemented('orderByChild');
    },
    orderByKey(..._args: unknown[]): never {
      throw notImplemented('orderByKey');
    },
    orderByValue(..._args: unknown[]): never {
      throw notImplemented('orderByValue');
    },
    orderByPriority(..._args: unknown[]): never {
      throw notImplemented('orderByPriority');
    },
    startAt(..._args: unknown[]): never {
      throw notImplemented('startAt');
    },
    startAfter(..._args: unknown[]): never {
      throw notImplemented('startAfter');
    },
    endAt(..._args: unknown[]): never {
      throw notImplemented('endAt');
    },
    endBefore(..._args: unknown[]): never {
      throw notImplemented('endBefore');
    },
    equalTo(..._args: unknown[]): never {
      throw notImplemented('equalTo');
    },
    limitToFirst(..._args: unknown[]): never {
      throw notImplemented('limitToFirst');
    },
    limitToLast(..._args: unknown[]): never {
      throw notImplemented('limitToLast');
    },
    isEqual(other: unknown): boolean {
      return (
        other !== null &&
        typeof other === 'object' &&
        (other as { path?: string }).path === canonical
      );
    },
    toJSON(): string {
      return formatReferenceUrl(urlMeta.originUrl, segs);
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
