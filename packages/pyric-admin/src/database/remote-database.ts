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
import { emptySpec, type QuerySpec } from 'pyric/database/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  buildDatabaseShell,
  formatReferenceUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { AdminListenerTable } from './listener-table.js';
import {
  buildRemoteOnDisconnect,
  remoteDatabaseConnectionControls,
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
  generatePushId,
  joinPath,
  pathSegments,
  validateValueArg,
  validateValuesArg,
  withOnComplete,
} from './tree-store.js';
import {
  notImplemented,
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
  listeners: AdminListenerTable;
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
    listeners: new AdminListenerTable(),
  };
  const state = entry.state;
  return buildDatabaseShell(
    app,
    urlMeta,
    (dbHandle, path, meta) => buildRemoteRef(state, dbHandle, path, meta),
    remoteDatabaseConnectionControls(state.channel, state.instance),
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
    listeners: state.listeners,
    canonical,
    refAt,
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

    onDisconnect(): OnDisconnect {
      return buildRemoteOnDisconnect(canonical, (op) => relayRtdbOp(state, op));
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
