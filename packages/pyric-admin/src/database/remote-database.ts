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
import { normalizeNode } from 'pyric/database/internal';
import { buildDatabaseShell } from './database-shell.js';
import { buildSandboxSnap } from './data-snapshot.js';
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
  type ThenableReference,
} from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

interface RemoteWireSnapshot {
  key: string | null;
  exists: boolean;
  value: unknown;
  exportValue?: unknown;
  size: number;
}

interface RemoteDbState {
  channel: RemoteSandboxChannel;
  instance: string | undefined;
  listeners: Map<string, Map<unknown, () => void>>;
}

const remoteDbsBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<{ db?: Database }>>();

export function getRemoteDatabase(
  sandbox: RemoteSandbox,
  instance: DatabaseInstance | undefined,
): Database {
  let registry = remoteDbsBySandbox.get(sandbox);
  if (registry === undefined) {
    registry = createDatabaseInstanceRegistry({ create: () => ({}) });
    remoteDbsBySandbox.set(sandbox, registry);
  }
  const entry = registry.getOrCreate(registry.keyOf(instance));
  if (entry.db !== undefined) return entry.db;
  const state: RemoteDbState = {
    channel: sandbox.channel,
    instance: instance?.name,
    listeners: new Map(),
  };
  entry.db = buildDatabaseShell(instance, (dbHandle, path) => buildRemoteRef(state, dbHandle, path));
  return entry.db;
}

type RemoteRtdbOp = { method: `rtdb.${string}`; path: string } & Record<string, unknown>;

function relayRtdbOp(state: RemoteDbState, op: RemoteRtdbOp): Promise<unknown> {
  return state.channel.op({ ...op, instance: state.instance, actAs: REMOTE_ADMIN_LENS });
}

function subscribeRtdbValue(
  state: RemoteDbState,
  path: string,
  onSnap: (value: unknown) => void,
  onError: (err: Error & { code: string }) => void,
): () => void {
  return state.channel.subscribe(
    { target: { service: 'rtdb', instance: state.instance, path }, actAs: REMOTE_ADMIN_LENS },
    onSnap,
    onError,
  );
}

function buildRemoteRef(
  state: RemoteDbState,
  db: Database,
  path: string,
): Reference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const refAt = (p: string): Reference => buildRemoteRef(state, db, p);
  const snapFromWire = (wire: RemoteWireSnapshot): DataSnapshot =>
    buildSandboxSnap(refAt, canonical, normalizeNode(wire.value ?? null), wire.exportValue);

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
      return `sandbox://rtdb${canonical}`;
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

    async get(): Promise<DataSnapshot> {
      const wire = (await relayRtdbOp(state, {
        method: 'rtdb.get',
        path: canonical,
      })) as RemoteWireSnapshot;
      return snapFromWire(wire);
    },

    once(
      eventType: EventType,
      successCb?: unknown,
      failureCallbackOrContext?: unknown,
      context?: unknown,
    ): Promise<DataSnapshot> {
      if (eventType !== 'value') {
        throw notImplemented(`once('${eventType}')`);
      }
      const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
      return new Promise<DataSnapshot>((resolve, reject) => {
        let detach: (() => void) | null = null;
        let settled = false;
        const failOnce = (err: Error) => {
          if (settled) return;
          settled = true;
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
            (value) => {
              if (settled) return;
              settled = true;
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
          if (settled) detach();
        } catch (err) {
          failOnce(err as Error);
        }
      });
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

    on(
      eventType: EventType,
      callback: (snap: DataSnapshot, prevChildKey?: string | null) => unknown,
      cancelCallbackOrContext?: ((err: Error) => unknown) | object | null,
      _context?: object | null,
    ): (snap: DataSnapshot, prevChildKey?: string | null) => unknown {
      if (eventType !== 'value') {
        throw notImplemented(`on('${eventType}')`);
      }
      const cancelCallback =
        typeof cancelCallbackOrContext === 'function'
          ? (cancelCallbackOrContext as (err: Error) => unknown)
          : undefined;
      const detach = subscribeRtdbValue(
        state,
        canonical,
        (value) => {
          callback(snapFromWire(value as RemoteWireSnapshot));
        },
        (err) => {
          detachListener(state, canonical, callback);
          if (cancelCallback) cancelCallback(err);
          else console.error(`pyric-admin/database: on('value') subscription failed at ${canonical}:`, err);
        },
      );
      let atPath = state.listeners.get(canonical);
      if (atPath === undefined) {
        atPath = new Map();
        state.listeners.set(canonical, atPath);
      }
      atPath.get(callback)?.();
      atPath.set(callback, detach);
      return callback;
    },

    off(
      eventType?: EventType,
      callback?: (snap: DataSnapshot, prevChildKey?: string | null) => unknown,
      _context?: object | null,
    ): void {
      if (eventType !== undefined && eventType !== 'value') return;
      if (callback !== undefined) {
        detachListener(state, canonical, callback);
        return;
      }
      const atPath = state.listeners.get(canonical);
      if (atPath === undefined) return;
      for (const detach of atPath.values()) detach();
      state.listeners.delete(canonical);
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
    toJSON(): object {
      return { path: canonical };
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

function detachListener(
  state: RemoteDbState,
  path: string,
  callback: unknown,
): void {
  const atPath = state.listeners.get(path);
  const detach = atPath?.get(callback);
  if (atPath === undefined || detach === undefined) return;
  atPath.delete(callback);
  if (atPath.size === 0) state.listeners.delete(path);
  detach();
}
