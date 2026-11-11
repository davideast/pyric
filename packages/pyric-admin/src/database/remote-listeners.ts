/**
 * Remote worker-relay RTDB listener registration (`on`, `off`, `once`), pinned
 * to `actAs: { mode: 'admin' }` and scoped by `(path, queryId, eventType)`.
 */

import type { RemoteSandboxChannel } from 'pyric/sandbox';
import { normalizeNode, type QuerySpec } from 'pyric/database/internal';
import { buildSandboxSnap } from './data-snapshot.js';
import type { AdminListenerTable } from './listener-table.js';
import { toWireQuerySpec, type WireQuerySpec } from './query.js';
import {
  notImplemented,
  resolveOnceCallbacks,
  type DataSnapshot,
  type EventType,
  type Reference,
  type SnapshotCallback,
} from './types.js';

const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

export interface RemoteWireEntry {
  key: string;
  value: unknown;
  priority?: string | number | null;
  exportValue?: unknown;
}

export interface RemoteWireSnapshot {
  key: string | null;
  exists: boolean;
  value: unknown;
  exportValue?: unknown;
  entries?: RemoteWireEntry[];
  size: number;
}

export interface RemoteListenTarget {
  readonly channel: RemoteSandboxChannel;
  readonly instance: string | undefined;
  readonly listeners: AdminListenerTable;
  readonly canonical: string;
  readonly refAt: (path: string) => Reference;
}

export function hydrateRemoteWireSnapshot(
  refAt: (path: string) => Reference,
  canonical: string,
  wire: RemoteWireSnapshot,
): DataSnapshot {
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
}

function subscribeRemoteRtdbValue(
  target: RemoteListenTarget,
  wireQuery: WireQuerySpec | undefined,
  onSnap: (value: unknown) => void,
  onError: (err: Error & { code: string }) => void,
): () => void {
  const subTarget: Record<string, unknown> = {
    service: 'rtdb',
    instance: target.instance,
    path: target.canonical,
  };
  if (wireQuery !== undefined) {
    subTarget.query = wireQuery;
  }
  return target.channel.subscribe(
    { target: subTarget, actAs: REMOTE_ADMIN_LENS },
    onSnap,
    onError,
  );
}

export function onceRemoteListener(
  target: RemoteListenTarget,
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
      detach = subscribeRemoteRtdbValue(
        target,
        wireQuery,
        (value) => {
          if (isSettled) return;
          isSettled = true;
          const snap = hydrateRemoteWireSnapshot(
            target.refAt,
            target.canonical,
            value as RemoteWireSnapshot,
          );
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
}

export function attachRemoteListener(
  target: RemoteListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  callback: SnapshotCallback,
  cancelCallbackOrContext?: ((error: Error) => unknown) | object | null,
  context?: object | null,
): SnapshotCallback {
  if (eventType !== 'value') {
    throw notImplemented(`on('${eventType}')`);
  }
  const wireQuery = toWireQuerySpec(spec);
  const { failureCb, boundContext } = resolveOnceCallbacks(cancelCallbackOrContext, context);
  const normalizedContext = boundContext ?? undefined;

  const entry = target.listeners.register(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
  let unsub: (() => void) | undefined;
  entry.detach = () => {
    if (unsub !== undefined) {
      const fn = unsub;
      unsub = undefined;
      fn();
    }
  };

  let erroredSynchronously = false;
  const attachedUnsub = subscribeRemoteRtdbValue(
    target,
    wireQuery,
    (value) => {
      if (!entry.active) return;
      const snap = hydrateRemoteWireSnapshot(
        target.refAt,
        target.canonical,
        value as RemoteWireSnapshot,
      );
      callback.call(normalizedContext, snap, null);
    },
    (err) => {
      erroredSynchronously = true;
      target.listeners.detachExact(entry);
      if (failureCb !== undefined) {
        failureCb.call(normalizedContext, err);
      } else {
        console.error(
          `pyric-admin/database: on('${eventType}') subscription failed at ${target.canonical}:`,
          err,
        );
      }
    },
  );
  if (entry.active && !erroredSynchronously) {
    unsub = attachedUnsub;
  } else {
    attachedUnsub();
  }
  return callback;
}

export function detachRemoteListener(
  target: RemoteListenTarget,
  spec: QuerySpec,
  eventType?: EventType,
  callback?: SnapshotCallback,
  context?: object | null,
): void {
  const normalizedContext = context ?? undefined;
  target.listeners.detachMatching(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
}
