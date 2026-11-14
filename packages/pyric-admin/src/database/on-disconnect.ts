/**
 * Shared validation, local `pyric/database` delegation, and remote worker-relay
 * wiring for `pyric-admin/database` `Reference#onDisconnect()` and
 * `Database#goOffline()` / `Database#goOnline()`.
 *
 * `setWithPriority` validates `priority` synchronously and forwards it across
 * both local and remote sandboxes; inline `.priority` values and `.priority`
 * update keys remain validated and dropped consistently with `Reference#set` /
 * `Reference#update` (conformance row `AS1`).
 */

import type { RemoteSandboxChannel } from 'pyric/sandbox';
import {
  goOffline as modularGoOffline,
  goOnline as modularGoOnline,
  onDisconnect as modularOnDisconnect,
  ref as modularRef,
  type Database as ModularDatabase,
} from 'pyric/database';
import {
  errorPrefix,
  inlinePriorities,
  normalizeNode,
  validatePriorityArg,
  validateUpdate,
  validateWritablePath,
  validateWrite,
} from 'pyric/database/internal';
import type { DatabaseConnectionControls } from './database-shell.js';
import { pathSegments, withOnComplete } from './tree-store.js';
import { validateCallbackArg, type JsonValue, type OnDisconnect } from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

type DisconnectCompleteCallback = ((a: Error | null) => unknown) | null | undefined;

interface RemoteBarrierState {
  barrier: Promise<void>;
  pending: number;
}

export interface RemoteConnectionState {
  readonly connectionId: string;
  readonly channelBarrier: RemoteBarrierState;
  online: boolean;
  hasPendingDisconnects: boolean;
  readonly observers: Set<(online: boolean) => void>;
}

const channelBarriers = new WeakMap<RemoteSandboxChannel, RemoteBarrierState>();
let nextRemoteConnectionSeq = 0;

export function createRemoteConnectionState(channel: RemoteSandboxChannel): RemoteConnectionState {
  let channelBarrier = channelBarriers.get(channel);
  if (channelBarrier === undefined) {
    channelBarrier = { barrier: Promise.resolve(), pending: 0 };
    channelBarriers.set(channel, channelBarrier);
  }
  return {
    connectionId: `admin-rtdb-conn-${++nextRemoteConnectionSeq}`,
    channelBarrier,
    online: true,
    hasPendingDisconnects: false,
    observers: new Set(),
  };
}

export type RemoteDisconnectRelay = (
  op: { method: `rtdb.${string}`; path: string } & Record<string, unknown>,
) => Promise<unknown>;

function isPriorityPatchKey(key: string): boolean {
  const segments = pathSegments(key);
  return segments[segments.length - 1] === '.priority';
}

function validateDisconnectSetValue(
  fnName: 'OnDisconnect.set' | 'OnDisconnect.setWithPriority',
  canonical: string,
  value: unknown,
): JsonValue {
  validateWritablePath(fnName, canonical);
  validateWrite(value, canonical, errorPrefix(fnName, 'value'));
  inlinePriorities(value);
  return normalizeNode(value);
}

function validateDisconnectUpdateValues(
  canonical: string,
  values: unknown,
): Record<string, JsonValue> {
  validateWritablePath('OnDisconnect.update', canonical);
  const entries = Object.entries(validateUpdate(values, canonical, 'OnDisconnect.update'));
  for (const [, value] of entries) {
    inlinePriorities(value);
  }
  const dataEntries = entries.filter(([key]) => !isPriorityPatchKey(key));
  return Object.fromEntries(
    dataEntries.map(([key, value]) => [key, normalizeNode(value)]),
  );
}

function settleDisconnectPromise(
  promise: Promise<void>,
  onComplete: DisconnectCompleteCallback,
): Promise<void> {
  const normalizedCallback = (onComplete ?? undefined) as
    | ((err: Error | null) => void)
    | undefined;
  return withOnComplete(promise, normalizedCallback);
}

export function buildLocalOnDisconnect(
  adminDb: ModularDatabase,
  canonical: string,
): OnDisconnect {
  const handle = modularOnDisconnect(modularRef(adminDb, canonical));
  return {
    cancel(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.cancel', 'onComplete', onComplete, true);
      return settleDisconnectPromise(handle.cancel(), onComplete);
    },
    remove(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.remove', 'onComplete', onComplete, true);
      validateWritablePath('OnDisconnect.remove', canonical);
      return settleDisconnectPromise(handle.remove(), onComplete);
    },
    set(value: unknown, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.set', 'onComplete', onComplete, true);
      const stored = validateDisconnectSetValue('OnDisconnect.set', canonical, value);
      return settleDisconnectPromise(handle.set(stored), onComplete);
    },
    setWithPriority(
      value: unknown,
      priority: number | string | null,
      onComplete?: DisconnectCompleteCallback,
    ): Promise<void> {
      validateCallbackArg('OnDisconnect.setWithPriority', 'onComplete', onComplete, true);
      const stored = validateDisconnectSetValue(
        'OnDisconnect.setWithPriority',
        canonical,
        value,
      );
      validatePriorityArg('OnDisconnect.setWithPriority', priority);
      return settleDisconnectPromise(handle.setWithPriority(stored, priority), onComplete);
    },
    update(values: object, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.update', 'onComplete', onComplete, true);
      const patch = validateDisconnectUpdateValues(canonical, values);
      return settleDisconnectPromise(handle.update(patch), onComplete);
    },
  };
}

export function localDatabaseConnectionControls(
  adminDb: ModularDatabase,
): DatabaseConnectionControls {
  return {
    goOffline(): void {
      modularGoOffline(adminDb);
    },
    goOnline(): void {
      modularGoOnline(adminDb);
    },
  };
}

export function buildRemoteOnDisconnect(
  canonical: string,
  relayOp: RemoteDisconnectRelay,
  connection?: RemoteConnectionState,
): OnDisconnect {
  const markQueued = (): void => {
    if (connection !== undefined) {
      connection.hasPendingDisconnects = true;
    }
  };
  return {
    cancel(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.cancel', 'onComplete', onComplete, true);
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectCancel', path: canonical }).then(() => undefined),
        onComplete,
      );
    },
    remove(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.remove', 'onComplete', onComplete, true);
      validateWritablePath('OnDisconnect.remove', canonical);
      markQueued();
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectRemove', path: canonical }).then(() => undefined),
        onComplete,
      );
    },
    set(value: unknown, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.set', 'onComplete', onComplete, true);
      const stored = validateDisconnectSetValue('OnDisconnect.set', canonical, value);
      markQueued();
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectSet', path: canonical, value: stored }).then(
          () => undefined,
        ),
        onComplete,
      );
    },
    setWithPriority(
      value: unknown,
      priority: number | string | null,
      onComplete?: DisconnectCompleteCallback,
    ): Promise<void> {
      validateCallbackArg('OnDisconnect.setWithPriority', 'onComplete', onComplete, true);
      const stored = validateDisconnectSetValue(
        'OnDisconnect.setWithPriority',
        canonical,
        value,
      );
      validatePriorityArg('OnDisconnect.setWithPriority', priority);
      markQueued();
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectSet', path: canonical, value: stored, priority }).then(
          () => undefined,
        ),
        onComplete,
      );
    },
    update(values: object, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.update', 'onComplete', onComplete, true);
      const patch = validateDisconnectUpdateValues(canonical, values);
      markQueued();
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectUpdate', path: canonical, values: patch }).then(
          () => undefined,
        ),
        onComplete,
      );
    },
  };
}

function enqueueRemoteConnectionOp(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
  connection: RemoteConnectionState,
  method: 'rtdb.goOffline' | 'rtdb.goOnline',
): Promise<void> {
  const shared = connection.channelBarrier;
  shared.pending += 1;
  const run = (): Promise<unknown> =>
    channel.op({
      method,
      instance,
      connectionId: connection.connectionId,
      actAs: REMOTE_ADMIN_LENS,
    });
  let next: Promise<unknown>;
  if (shared.pending === 1) {
    // Dispatch immediately on the current tick while still gating follow-up ops.
    next = run();
  } else {
    next = shared.barrier.then(run);
  }
  const settle = (): void => {
    shared.pending -= 1;
  };
  const settledPromise = next.then(settle, settle);
  shared.barrier = settledPromise;
  return settledPromise;
}

function setRemoteOnlineState(connection: RemoteConnectionState, nextOnline: boolean): boolean {
  if (connection.online === nextOnline) return false;
  connection.online = nextOnline;
  for (const observer of [...connection.observers]) {
    observer(nextOnline);
  }
  return true;
}

export function observeRemoteConnection(
  connection: RemoteConnectionState,
  next: (online: boolean) => void,
): () => void {
  connection.observers.add(next);
  next(connection.online);
  return () => {
    connection.observers.delete(next);
  };
}

export function severRemoteConnection(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
  connection: RemoteConnectionState,
): Promise<void> {
  const hadPendingDisconnects = connection.hasPendingDisconnects;
  connection.hasPendingDisconnects = false;
  setRemoteOnlineState(connection, false);
  if (hadPendingDisconnects) {
    return enqueueRemoteConnectionOp(channel, instance, connection, 'rtdb.goOffline');
  }
  if (connection.channelBarrier.pending > 0) {
    return connection.channelBarrier.barrier;
  }
  return Promise.resolve();
}

export function remoteDatabaseConnectionControls(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
  connection: RemoteConnectionState,
): DatabaseConnectionControls {
  return {
    goOffline(): void {
      if (!setRemoteOnlineState(connection, false)) return;
      connection.hasPendingDisconnects = false;
      void enqueueRemoteConnectionOp(channel, instance, connection, 'rtdb.goOffline');
    },
    goOnline(): void {
      if (!setRemoteOnlineState(connection, true)) return;
      void enqueueRemoteConnectionOp(channel, instance, connection, 'rtdb.goOnline');
    },
  };
}
