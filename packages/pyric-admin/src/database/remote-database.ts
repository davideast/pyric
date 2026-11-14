/**
 * Remote worker-relay arm for `pyric-admin/database` (`connectRemoteSandbox()`),
 * pinning `actAs: { mode: 'admin' }` on every operation and subscription.
 */

import type {
  RemoteSandbox,
  RemoteSandboxChannel,
} from 'pyric/sandbox';
import type { DatabaseInstance } from 'pyric/sandbox/internal';
import { assertGettablePath, emptySpec, type QuerySpec } from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  createAdminServiceLifecycle,
  onAdminAppDeleted,
  type AdminServiceLifecycle,
} from '../app/lifecycle.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { AdminListenerTable } from './listener-table.js';
import {
  buildRemoteOnDisconnect,
  createRemoteConnectionState,
  observeRemoteConnection,
  remoteDatabaseConnectionControls,
  severRemoteConnection,
  type RemoteConnectionState,
} from './on-disconnect.js';
import { createQuerySurface, toWireQuerySpec } from './query.js';
import {
  attachRemoteListener,
  detachRemoteListener,
  hydrateRemoteWireSnapshot,
  onceRemoteListener,
  type RemoteListenTarget,
  type RemoteWireSnapshot,
} from './remote-listeners.js';
import {
  assertActivePromise,
  generatePushId,
  joinPath,
  pathSegments,
  validateValueArg,
  validateValuesArg,
  withOnComplete,
} from './tree-store.js';
import {
  ADMIN_REFERENCE_BRAND,
  notImplemented,
  validateCallbackArg,
  type Database,
  type DataSnapshot,
  type OnDisconnect,
  type Reference,
  type ThenableReference,
} from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

interface RemoteDbState {
  channel: RemoteSandboxChannel;
  instance: string | undefined;
  lifecycle: AdminServiceLifecycle;
  listeners: AdminListenerTable;
  connection: RemoteConnectionState;
}

const remoteStatesByApp = new WeakMap<PyricAdminApp, Map<string, RemoteDbState>>();

function remoteStatesForApp(app: PyricAdminApp): Map<string, RemoteDbState> {
  const existing = remoteStatesByApp.get(app);
  if (existing !== undefined) return existing;
  const states = new Map<string, RemoteDbState>();
  remoteStatesByApp.set(app, states);
  onAdminAppDeleted(app, async () => {
    const drains: Promise<void>[] = [];
    for (const [, state] of states.entries()) {
      state.listeners.detachAll();
      drains.push(severRemoteConnection(state.channel, state.instance, state.connection));
    }
    if (drains.length > 0) {
      await Promise.all(drains);
    }
  });
  return states;
}

export function getRemoteDatabase(
  app: PyricAdminApp,
  sandbox: RemoteSandbox,
  cacheKey: string,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  const states = remoteStatesForApp(app);
  let state = states.get(cacheKey);
  if (state === undefined) {
    state = {
      channel: sandbox.channel,
      instance: instance?.name,
      lifecycle: createAdminServiceLifecycle(app),
      listeners: new AdminListenerTable(),
      connection: createRemoteConnectionState(sandbox.channel),
    };
    states.set(cacheKey, state);
  }
  return buildDatabaseShell(
    app,
    urlMeta,
    (dbHandle, path, meta) => buildRemoteRef(state, dbHandle, path, meta),
    remoteDatabaseConnectionControls(state.channel, state.instance, state.connection),
    state.lifecycle,
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
  const dispatch = (): Promise<unknown> =>
    state.channel.op({ ...op, instance: state.instance, actAs: REMOTE_ADMIN_LENS });
  if (state.connection.channelBarrier.pending > 0) {
    return state.connection.channelBarrier.barrier.then(dispatch).catch(normalizeRelayedError);
  }
  return dispatch().catch(normalizeRelayedError);
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
  const listenTarget: RemoteListenTarget = {
    channel: state.channel,
    instance: state.instance,
    lifecycle: state.lifecycle,
    listeners: state.listeners,
    canonical,
    refAt,
    observeConnection: (next) => observeRemoteConnection(state.connection, next),
    waitConnectionBarrier: () => {
      if (state.connection.channelBarrier.pending > 0) {
        return state.connection.channelBarrier.barrier;
      }
      return null;
    },
  };

  const querySurface = createQuerySurface(
    {
      repoToken: state,
      canonicalPath: canonical,
      formattedUrl,
      getBaseRef: () => ref as unknown as Reference,
      async get(spec: QuerySpec): Promise<DataSnapshot> {
        assertGettablePath(canonical);
        state.lifecycle.assertActive();
        const wireQuery = toWireQuerySpec(spec);
        const opPayload: RemoteRtdbOp = {
          method: 'rtdb.get',
          path: canonical,
        };
        if (wireQuery !== undefined) {
          opPayload.query = wireQuery;
        }
        const wire = (await relayRtdbOp(state, opPayload)) as RemoteWireSnapshot;
        return hydrateRemoteWireSnapshot(refAt, canonical, wire);
      },
      once: (spec, eventType, successCb, failureCallbackOrContext, context) =>
        onceRemoteListener(listenTarget, spec, eventType, successCb, failureCallbackOrContext, context),
      on: (spec, eventType, callback, cancelCallbackOrContext, context) =>
        attachRemoteListener(listenTarget, spec, eventType, callback, cancelCallbackOrContext, context),
      off: (spec, eventType, callback, context) =>
        detachRemoteListener(listenTarget, spec, eventType, callback, context),
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
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.set',
          path: canonical,
          value: stored,
        }).then(() => undefined),
        onComplete,
      );
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.update', 'onComplete', onComplete, true);
      const patch = validateValuesArg(segs, values);
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
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
      validateCallbackArg('Reference.remove', 'onComplete', onComplete, true);
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.remove',
          path: canonical,
        }).then(() => undefined),
        onComplete,
      );
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      validateCallbackArg('Reference.push', 'onComplete', onComplete, true);
      let stored: ReturnType<typeof validateValueArg> | undefined;
      if (value !== undefined) {
        stored = validateValueArg('push', segs, value);
      }
      const id = generatePushId();
      const childPath = joinPath([...segs, id]);
      const deleted = assertActivePromise(state.lifecycle);
      let write: Promise<void>;
      if (deleted !== null) {
        write = deleted;
      } else if (stored === undefined) {
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

    onDisconnect(): OnDisconnect {
      return buildRemoteOnDisconnect(
        canonical,
        (op) => relayRtdbOp(state, { ...op, connectionId: state.connection.connectionId }),
        state.connection,
        state.lifecycle,
      );
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
