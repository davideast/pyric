/**
 * Shared validation, local `pyric/database` delegation, and remote worker-relay
 * wiring for `pyric-admin/database` `Reference#onDisconnect()` and
 * `Database#goOffline()` / `Database#goOnline()`.
 *
 * Priorities in `setWithPriority`, inline `.priority` values, and `.priority`
 * update keys are validated synchronously and dropped consistently with
 * `Reference#set` / `Reference#update` (conformance row `AS1`) until Slice 6.
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

export interface RemoteConnectionState {
  barrier: Promise<void>;
  pending: number;
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
      return settleDisconnectPromise(handle.set(stored), onComplete);
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
): OnDisconnect {
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
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectRemove', path: canonical }).then(() => undefined),
        onComplete,
      );
    },
    set(value: unknown, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.set', 'onComplete', onComplete, true);
      const stored = validateDisconnectSetValue('OnDisconnect.set', canonical, value);
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
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectSet', path: canonical, value: stored }).then(
          () => undefined,
        ),
        onComplete,
      );
    },
    update(values: object, onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateCallbackArg('OnDisconnect.update', 'onComplete', onComplete, true);
      const patch = validateDisconnectUpdateValues(canonical, values);
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
): void {
  connection.pending += 1;
  const run = (): Promise<unknown> =>
    channel.op({ method, instance, actAs: REMOTE_ADMIN_LENS });
  let next: Promise<unknown>;
  if (connection.pending === 1) {
    // Dispatch immediately on the current tick while still gating follow-up ops.
    next = run();
  } else {
    next = connection.barrier.then(run);
  }
  const settle = (): void => {
    connection.pending -= 1;
  };
  connection.barrier = next.then(settle, settle);
}

export function remoteDatabaseConnectionControls(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
  connection: RemoteConnectionState,
): DatabaseConnectionControls {
  return {
    goOffline(): void {
      enqueueRemoteConnectionOp(channel, instance, connection, 'rtdb.goOffline');
    },
    goOnline(): void {
      enqueueRemoteConnectionOp(channel, instance, connection, 'rtdb.goOnline');
    },
  };
}
