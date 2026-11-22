/**
 * Remote worker-relay arm for `pyric-admin/database` (`connectRemoteSandbox()`),
 * pinning the app's lens on every operation and subscription: `actAs: { mode:
 * 'admin' }`, or the identity its `databaseAuthVariableOverride` names.
 */

import type {
  RemoteSandbox,
  RemoteSandboxChannel,
} from 'pyric/sandbox';
import type { DatabaseInstance } from 'pyric/sandbox/internal';
import {
  assertGettablePath,
  emptySpec,
  hasNonFiniteQueryLimit,
  isDefaultQuerySpec,
  normalizeNode,
  type QuerySpec,
} from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  createAdminServiceLifecycle,
  onAdminAppDeleted,
  type AdminServiceLifecycle,
} from '../app/lifecycle.js';
import { remoteDatabaseRulesControls } from './admin-rules.js';
import type { DatabaseAuthLens } from './auth-override.js';
import {
  AdminPathCache,
  runRemoteAdminTransaction,
  type AdminTransactionOnComplete,
  type AdminTransactionUpdate,
} from './admin-transaction.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { AdminListenerTable } from './listener-table.js';
import { emitAdminDatabaseLog } from './logging.js';
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
  absentNodeSetPriorityError,
  assertActivePromise,
  generatePushId,
  joinPath,
  pathSegments,
  validateAdminChildPath,
  validateAdminPriorityArg,
  validateValueArg,
  validateValuesArg,
  withOnComplete,
} from './tree-store.js';
import {
  ADMIN_REFERENCE_BRAND,
  validateCallbackArg,
  type Database,
  type DataSnapshot,
  type OnDisconnect,
  type Reference,
  type ThenableReference,
} from './types.js';


interface RemoteDbState {
  channel: RemoteSandboxChannel;
  /** The identity every operation and subscription carries. */
  lens: DatabaseAuthLens;
  instance: string | undefined;
  cache: AdminPathCache;
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
  lens: DatabaseAuthLens,
): Database {
  const states = remoteStatesForApp(app);
  let state = states.get(cacheKey);
  if (state === undefined) {
    state = {
      channel: sandbox.channel,
      lens,
      instance: instance?.name,
      cache: new AdminPathCache(),
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
    remoteDatabaseRulesControls(state.channel, state.instance, state.lifecycle),
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
    state.channel.op({ ...op, instance: state.instance, actAs: state.lens });
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
  let key: string | null = null;
  if (segs.length > 0) {
    const lastSeg = segs[segs.length - 1];
    if (lastSeg !== undefined) {
      key = lastSeg;
    }
  }
  const formattedUrl = formatReferenceUrl(urlMeta.originUrl, segs);
  const refAt = (p: string): Reference => buildRemoteRef(state, db, p, urlMeta);
  const listenTarget: RemoteListenTarget = {
    channel: state.channel,
    instance: state.instance,
    actAs: state.lens,
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
    onWireSnapshot: (snapPath, wire) => {
      state.cache.recordValue(snapPath, normalizeNode(wire.value ?? null));
    },
    readWarmCachedValue: (lookupPath) => {
      if (!state.cache.isWarm(lookupPath)) {
        return { found: false, stored: null };
      }
      return { found: true, stored: state.cache.read(lookupPath) };
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
        emitAdminDatabaseLog('get', canonical);
        if (hasNonFiniteQueryLimit(spec)) {
          return new Promise<DataSnapshot>(() => {});
        }
        const wireQuery = toWireQuerySpec(spec);
        const opPayload: RemoteRtdbOp = {
          method: 'rtdb.get',
          path: canonical,
        };
        if (wireQuery !== undefined) {
          opPayload.query = wireQuery;
        }
        const wire = (await relayRtdbOp(state, opPayload)) as RemoteWireSnapshot;
        if (isDefaultQuerySpec(spec)) {
          state.cache.recordValue(canonical, normalizeNode(wire.value ?? null));
        }
        return hydrateRemoteWireSnapshot(refAt, canonical, wire);
      },
      once: (spec, eventType, successCb, failureCallbackOrContext, context) => {
        emitAdminDatabaseLog('once', canonical);
        return onceRemoteListener(listenTarget, spec, eventType, successCb, failureCallbackOrContext, context);
      },
      on: (spec, eventType, callback, cancelCallbackOrContext, context) => {
        emitAdminDatabaseLog('on', canonical);
        return attachRemoteListener(listenTarget, spec, eventType, callback, cancelCallbackOrContext, context);
      },
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
      emitAdminDatabaseLog('set', canonical);
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.set',
          path: canonical,
          value: stored,
        }).then(() => {
          state.cache.recordValue(canonical, normalizeNode(stored));
        }),
        onComplete,
      );
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.update', 'onComplete', onComplete, true);
      const patch = validateValuesArg(segs, values);
      emitAdminDatabaseLog('update', canonical);
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.update',
          path: canonical,
          values: patch,
        }).then(() => {
          if (Object.keys(patch).length > 0) {
            state.cache.recordPatch(canonical, patch);
          }
        }),
        onComplete,
      );
    },

    remove(onComplete?: (err: Error | null) => void): Promise<void> {
      validateCallbackArg('Reference.remove', 'onComplete', onComplete, true);
      emitAdminDatabaseLog('remove', canonical);
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, onComplete);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.remove',
          path: canonical,
        }).then(() => {
          state.cache.recordValue(canonical, null);
        }),
        onComplete,
      );
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      validateCallbackArg('Reference.push', 'onComplete', onComplete, true);
      let stored: ReturnType<typeof validateValueArg> | undefined;
      if (value !== undefined) {
        stored = validateValueArg('push', segs, value);
      }
      emitAdminDatabaseLog('push', canonical);
      const id = generatePushId();
      const childPath = joinPath([...segs, id]);
      const deleted = assertActivePromise(state.lifecycle);
      let write: Promise<void>;
      if (deleted !== null) {
        write = deleted;
      } else if (stored === undefined) {
        write = Promise.resolve();
      } else {
        const childStored = stored;
        write = relayRtdbOp(state, {
          method: 'rtdb.push',
          path: canonical,
          key: id,
          value: childStored,
        }).then(() => {
          state.cache.recordValue(childPath, normalizeNode(childStored));
        });
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
      const validated = validateAdminChildPath(segs, p);
      return refAt(joinPath([...segs, ...pathSegments(validated)]));
    },

    onDisconnect(): OnDisconnect {
      return buildRemoteOnDisconnect(
        canonical,
        (op) => relayRtdbOp(state, { ...op, connectionId: state.connection.connectionId }),
        state.connection,
        state.lifecycle,
      );
    },
    transaction(
      transactionUpdate: AdminTransactionUpdate,
      onComplete?: AdminTransactionOnComplete,
      applyLocally?: boolean,
    ): Promise<{ committed: boolean; snapshot: DataSnapshot }> {
      return runRemoteAdminTransaction({
        relayOp: (op) => relayRtdbOp(state, op),
        cache: state.cache,
        lifecycle: state.lifecycle,
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
      const completionCb = onComplete as ((err: Error | null) => void) | undefined;
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, completionCb);
      }
      const runRemoteSetPriority = async (): Promise<void> => {
        if (validatedPriority !== null) {
          const existing = (await relayRtdbOp(state, {
            method: 'rtdb.get',
            path: canonical,
          })) as RemoteWireSnapshot;
          if (existing.exists === false) {
            throw absentNodeSetPriorityError();
          }
        }
        await relayRtdbOp(state, {
          method: 'rtdb.setPriority',
          path: canonical,
          priority: validatedPriority,
        });
      };
      return withOnComplete(runRemoteSetPriority(), completionCb);
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
      const completionCb = onComplete as ((err: Error | null) => void) | undefined;
      const deleted = assertActivePromise(state.lifecycle);
      if (deleted !== null) {
        return withOnComplete(deleted, completionCb);
      }
      return withOnComplete(
        relayRtdbOp(state, {
          method: 'rtdb.setWithPriority',
          path: canonical,
          value: stored,
          priority: validatedPriority,
        }).then(() => {
          state.cache.recordValue(canonical, normalizeNode(stored));
        }),
        completionCb,
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
