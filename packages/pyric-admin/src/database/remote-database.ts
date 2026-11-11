/**
 * Remote worker-relay arm for `pyric-admin/database` (`connectRemoteSandbox()`),
 * pinning `actAs: { mode: 'admin' }` on every operation and subscription.
 */

import type {
  RemoteSandbox,
  RemoteSandboxChannel,
  Sandbox,
} from 'pyric/sandbox';
import {
  createDatabaseInstanceRegistry,
  type DatabaseInstance,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import {
  emptySpec,
  normalizeNode,
  type QuerySpec,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { buildSandboxSnap } from './data-snapshot.js';
import { createQuerySurface, toWireQuerySpec, type WireQuerySpec } from './query.js';
import {
  generatePushId,
  joinPath,
  pathSegments,
  validateValueArg,
  validateValuesArg,
  withOnComplete,
} from './tree-store.js';
import {
  notImplemented,
  resolveOnceCallbacks,
  type Database,
  type DataSnapshot,
  type EventType,
  type Reference,
  type SnapshotCallback,
  type ThenableReference,
} from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

interface RemoteWireEntry {
  key: string;
  value: unknown;
  priority?: string | number | null;
  exportValue?: unknown;
}

interface RemoteWireSnapshot {
  key: string | null;
  exists: boolean;
  value: unknown;
  exportValue?: unknown;
  entries?: RemoteWireEntry[];
  size: number;
}

interface RemoteValueListenerEntry {
  callback: unknown;
  context: unknown;
  detach: () => void;
}

interface RemoteDbState {
  channel: RemoteSandboxChannel;
  instance: string | undefined;
  listeners: Map<string, RemoteValueListenerEntry[]>;
}

const remoteStatesBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<{ state?: RemoteDbState }>>();

export function getRemoteDatabase(
  app: PyricAdminApp,
  sandbox: RemoteSandbox,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  let registry = remoteStatesBySandbox.get(sandbox);
  if (registry === undefined) {
    registry = createDatabaseInstanceRegistry({ create: () => ({}) });
    remoteStatesBySandbox.set(sandbox, registry);
  }
  const entry = registry.getOrCreate(registry.keyOf(instance));
  entry.state ??= {
    channel: sandbox.channel,
    instance: instance?.name,
    listeners: new Map(),
  };
  const state = entry.state;
  return buildDatabaseShell(app, urlMeta, (dbHandle, path, meta) =>
    buildRemoteRef(state, dbHandle, path, meta),
  );
}

type RemoteRtdbOp = { method: `rtdb.${string}`; path: string } & Record<string, unknown>;

function normalizeRelayedError(error: unknown): never {
  const isCodedError = error instanceof Error && 'code' in error;
  if (isCodedError && (error as { code?: unknown }).code === 'unknown') {
    delete (error as { code?: unknown }).code;
  }
  throw error;
}

function relayRtdbOp(state: RemoteDbState, op: RemoteRtdbOp): Promise<unknown> {
  return state.channel
    .op({ ...op, instance: state.instance, actAs: REMOTE_ADMIN_LENS })
    .catch(normalizeRelayedError);
}

function subscribeRtdbValue(
  state: RemoteDbState,
  path: string,
  wireQuery: WireQuerySpec | undefined,
  onSnap: (value: unknown) => void,
  onError: (err: Error & { code: string }) => void,
): () => void {
  const target: Record<string, unknown> = {
    service: 'rtdb',
    instance: state.instance,
    path,
  };
  if (wireQuery !== undefined) {
    target.query = wireQuery;
  }
  return state.channel.subscribe(
    { target, actAs: REMOTE_ADMIN_LENS },
    onSnap,
    onError,
  );
}

function buildRemoteRef(
  state: RemoteDbState,
  db: Database,
  path: string,
  urlMeta: DatabaseUrlMetadata,
): Reference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const formattedUrl = formatReferenceUrl(urlMeta.originUrl, segs);
  const refAt = (p: string): Reference => buildRemoteRef(state, db, p, urlMeta);
  const snapFromWire = (wire: RemoteWireSnapshot): DataSnapshot => {
    const orderedEntries = wire.entries?.map((entry) => ({
      key: entry.key,
      value: normalizeNode(entry.value ?? null),
      exportValue: entry.exportValue,
    }));
    return buildSandboxSnap(
      refAt,
      canonical,
      normalizeNode(wire.value ?? null),
      wire.exportValue,
      orderedEntries,
    );
  };

  const querySurface = createQuerySurface(
    {
      repoToken: state,
      canonicalPath: canonical,
      formattedUrl,
      getBaseRef: () => ref as unknown as Reference,
      async get(spec: QuerySpec): Promise<DataSnapshot> {
        const wireQuery = toWireQuerySpec(spec);
        const opPayload: RemoteRtdbOp = {
          method: 'rtdb.get',
          path: canonical,
        };
        if (wireQuery !== undefined) {
          opPayload.query = wireQuery;
        }
        const wire = (await relayRtdbOp(state, opPayload)) as RemoteWireSnapshot;
        return snapFromWire(wire);
      },
      once(
        spec: QuerySpec,
        eventType: EventType,
        successCb?: unknown,
        failureCallbackOrContext?: unknown,
        context?: unknown,
      ): Promise<DataSnapshot> {
        if (eventType !== 'value') {
          throw notImplemented(`once('${eventType}')`);
        }
        const wireQuery = toWireQuerySpec(spec);
        const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
        return new Promise<DataSnapshot>((resolve, reject) => {
          let detach: (() => void) | null = null;
          let isSettled = false;
          const failOnce = (err: Error) => {
            if (isSettled) return;
            isSettled = true;
            if (failureCb !== undefined) {
              try {
                failureCb.call(boundContext, err);
              } catch {
                // Ignore secondary callback throw before rejecting with the read error.
              }
            }
            reject(err);
            if (detach) detach();
          };
          try {
            detach = subscribeRtdbValue(
              state,
              canonical,
              wireQuery,
              (value) => {
                if (isSettled) return;
                isSettled = true;
                const snap = snapFromWire(value as RemoteWireSnapshot);
                if (typeof successCb === 'function') {
                  try {
                    (successCb as (s: DataSnapshot) => unknown).call(boundContext, snap);
                  } catch {
                    // Callback error does not reject the once() promise once snapshot arrived.
                  }
                }
                resolve(snap);
                if (detach) detach();
              },
              (err) => {
                failOnce(err);
              },
            );
            if (isSettled) detach();
          } catch (err) {
            failOnce(err as Error);
          }
        });
      },
      on(
        spec: QuerySpec,
        eventType: EventType,
        callback: SnapshotCallback,
        cancelCallbackOrContext?: ((err: Error) => unknown) | object | null,
        context?: object | null,
      ): SnapshotCallback {
        if (eventType !== 'value') {
          throw notImplemented(`on('${eventType}')`);
        }
        const wireQuery = toWireQuerySpec(spec);
        const { failureCb, boundContext } = resolveOnceCallbacks(cancelCallbackOrContext, context);
        const normalizedContext = boundContext ?? undefined;
        let erroredSynchronously = false;
        const entry: RemoteValueListenerEntry = {
          callback,
          context: normalizedContext,
          detach: () => {},
        };
        let atPath = state.listeners.get(canonical);
        if (atPath === undefined) {
          atPath = [];
          state.listeners.set(canonical, atPath);
        }
        atPath.push(entry);
        const detach = subscribeRtdbValue(
          state,
          canonical,
          wireQuery,
          (value) => {
            callback.call(normalizedContext, snapFromWire(value as RemoteWireSnapshot), null);
          },
          (err) => {
            erroredSynchronously = true;
            detachExactListener(state, canonical, entry);
            if (failureCb) failureCb.call(normalizedContext, err);
            else console.error(`pyric-admin/database: on('value') subscription failed at ${canonical}:`, err);
          },
        );
        entry.detach = detach;
        if (erroredSynchronously) detach();
        return callback;
      },
      off(
        _spec: QuerySpec,
        eventType?: EventType,
        callback?: SnapshotCallback,
        context?: object | null,
      ): void {
        if (eventType !== undefined && eventType !== 'value') return;
        if (callback !== undefined) {
          detachMatchingListeners(state, canonical, callback, context ?? undefined);
          return;
        }
        const atPath = state.listeners.get(canonical);
        if (atPath === undefined) return;
        state.listeners.delete(canonical);
        for (const entry of atPath) entry.detach();
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
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.set',
          path: canonical,
          value: validateValueArg('set', segs, value),
        }).then(() => undefined),
        onComplete,
      );
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      const patch = validateValuesArg(segs, values);
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.update',
          path: canonical,
          values: patch,
        }).then(() => undefined),
        onComplete,
      );
    },

    remove(onComplete?: (err: Error | null) => void): Promise<void> {
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.remove',
          path: canonical,
        }).then(() => undefined),
        onComplete,
      );
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      const stored = value === undefined ? undefined : validateValueArg('push', segs, value);
      const id = generatePushId();
      const childPath = joinPath([...segs, id]);
      let write: Promise<void>;
      if (stored === undefined) {
        write = Promise.resolve();
      } else {
        write = relayRtdbOp(state, {
          method: 'rtdb.push',
          path: canonical,
          key: id,
          value: stored,
        }).then(() => undefined);
      }
      const settledWrite = withOnComplete(write, onComplete);
      settledWrite.catch(() => {});
      const childRef = refAt(childPath);
      const resolvedRef = refAt(childPath);
      const outcome = settledWrite.then(() => resolvedRef);
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
      return refAt(joinPath([...segs, ...pathSegments(p)]));
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

function detachExactListener(
  state: RemoteDbState,
  path: string,
  target: RemoteValueListenerEntry,
): void {
  const atPath = state.listeners.get(path);
  if (atPath === undefined) return;
  const idx = atPath.indexOf(target);
  if (idx === -1) return;
  atPath.splice(idx, 1);
  if (atPath.length === 0) state.listeners.delete(path);
  target.detach();
}

function detachMatchingListeners(
  state: RemoteDbState,
  path: string,
  callback: unknown,
  context: unknown,
): void {
  const atPath = state.listeners.get(path);
  if (atPath === undefined) return;
  const removed: RemoteValueListenerEntry[] = [];
  const kept: RemoteValueListenerEntry[] = [];
  for (const entry of atPath) {
    const matchesContext = context === undefined || entry.context === context;
    if (entry.callback === callback && matchesContext) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  if (removed.length === 0) return;
  if (kept.length === 0) state.listeners.delete(path);
  else state.listeners.set(path, kept);
  for (const entry of removed) entry.detach();
}
