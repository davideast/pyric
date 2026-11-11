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
import type { JsonValue, OnDisconnect } from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

type DisconnectCompleteCallback = ((a: Error | null) => unknown) | undefined;

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
  return withOnComplete(
    promise,
    onComplete as ((err: Error | null) => void) | undefined,
  );
}

export function buildLocalOnDisconnect(
  adminDb: ModularDatabase,
  canonical: string,
): OnDisconnect {
  const handle = modularOnDisconnect(modularRef(adminDb, canonical));
  return {
    cancel(onComplete?: DisconnectCompleteCallback): Promise<void> {
      return settleDisconnectPromise(handle.cancel(), onComplete);
    },
    remove(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateWritablePath('OnDisconnect.remove', canonical);
      return settleDisconnectPromise(handle.remove(), onComplete);
    },
    set(value: unknown, onComplete?: DisconnectCompleteCallback): Promise<void> {
      const stored = validateDisconnectSetValue('OnDisconnect.set', canonical, value);
      return settleDisconnectPromise(handle.set(stored), onComplete);
    },
    setWithPriority(
      value: unknown,
      priority: number | string | null,
      onComplete?: DisconnectCompleteCallback,
    ): Promise<void> {
      const stored = validateDisconnectSetValue(
        'OnDisconnect.setWithPriority',
        canonical,
        value,
      );
      validatePriorityArg('OnDisconnect.setWithPriority', priority);
      return settleDisconnectPromise(handle.set(stored), onComplete);
    },
    update(values: object, onComplete?: DisconnectCompleteCallback): Promise<void> {
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
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectCancel', path: canonical }).then(() => undefined),
        onComplete,
      );
    },
    remove(onComplete?: DisconnectCompleteCallback): Promise<void> {
      validateWritablePath('OnDisconnect.remove', canonical);
      return settleDisconnectPromise(
        relayOp({ method: 'rtdb.onDisconnectRemove', path: canonical }).then(() => undefined),
        onComplete,
      );
    },
    set(value: unknown, onComplete?: DisconnectCompleteCallback): Promise<void> {
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

export function remoteDatabaseConnectionControls(
  channel: RemoteSandboxChannel,
  instance: string | undefined,
): DatabaseConnectionControls {
  return {
    goOffline(): void {
      void channel
        .op({ method: 'rtdb.goOffline', instance, actAs: REMOTE_ADMIN_LENS })
        .catch(() => undefined);
    },
    goOnline(): void {
      void channel
        .op({ method: 'rtdb.goOnline', instance, actAs: REMOTE_ADMIN_LENS })
        .catch(() => undefined);
    },
  };
}
