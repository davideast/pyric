/**
 * Remote worker-relay RTDB listener registration (`on`, `off`, `once`), pinned
 * to `actAs: { mode: 'admin' }` and scoped by `(path, queryId, eventType)`.
 */

import type { RemoteSandboxChannel } from 'pyric/sandbox';
import { normalizeNode, type QuerySpec } from 'pyric/database/internal';
import {
  assertValidEventType,
  ChildWindowDiffer,
  isChildEventType,
} from './child-diff.js';
import { buildSandboxSnap } from './data-snapshot.js';
import type { AdminListenerTable } from './listener-table.js';
import { toWireQuerySpec, type WireQuerySpec } from './query.js';
import { joinPath, pathSegments } from './tree-store.js';
import {
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

function subscribeRemoteRtdb(
  target: RemoteListenTarget,
  wireQuery: WireQuerySpec | undefined,
  eventType: EventType,
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
  if (eventType !== 'value') {
    subTarget.event = eventType;
  }
  return target.channel.subscribe(
    { target: subTarget, actAs: REMOTE_ADMIN_LENS },
    onSnap,
    onError,
  );
}

export async function onceRemoteListener(
  target: RemoteListenTarget,
  spec: QuerySpec,
  eventType: EventType,
  successCb?: unknown,
  failureCallbackOrContext?: unknown,
  context?: unknown,
): Promise<DataSnapshot> {
  assertValidEventType('once', eventType);
  const segs = pathSegments(target.canonical);
  const wireQuery = toWireQuerySpec(spec);
  const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
  const differ = isChildEventType(eventType) ? new ChildWindowDiffer(spec, eventType) : null;

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
    const resolveOnce = (snap: DataSnapshot, prevKey: string | null) => {
      isSettled = true;
      if (detach) {
        const fn = detach;
        detach = null;
        fn();
      }
      if (typeof successCb === 'function') {
        try {
          (successCb as SnapshotCallback).call(boundContext, snap, prevKey);
        } catch {
          // Callback error does not reject the once() promise once snapshot arrived.
        }
      }
      resolve(snap);
    };
    try {
      detach = subscribeRemoteRtdb(
        target,
        wireQuery,
        eventType,
        (value) => {
          if (isSettled) return;
          const wire = value as RemoteWireSnapshot;
          if (differ !== null) {
            const deltas = differ.consume(wire);
            if (deltas.length === 0) return;
            const first = deltas[0]!;
            const childPath = joinPath([...segs, first.key]);
            const childSnap = buildSandboxSnap(
              target.refAt,
              childPath,
              first.value,
              first.exportValue,
            );
            resolveOnce(childSnap, first.previousChildName);
            return;
          }
          const snap = hydrateRemoteWireSnapshot(target.refAt, target.canonical, wire);
          resolveOnce(snap, null);
        },
        (err) => {
          failOnce(err);
        },
      );
      if (isSettled && detach) {
        const fn = detach;
        detach = null;
        fn();
      }
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
  assertValidEventType('on', eventType);
  const segs = pathSegments(target.canonical);
  const wireQuery = toWireQuerySpec(spec);
  const { failureCb, boundContext } = resolveOnceCallbacks(cancelCallbackOrContext, context);
  const normalizedContext = boundContext ?? undefined;
  const differ = isChildEventType(eventType) ? new ChildWindowDiffer(spec, eventType) : null;

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
  const attachedUnsub = subscribeRemoteRtdb(
    target,
    wireQuery,
    eventType,
    (value) => {
      if (!entry.active) return;
      const wire = value as RemoteWireSnapshot;
      if (differ !== null) {
        const deltas = differ.consume(wire);
        for (const delta of deltas) {
          if (!entry.active) break;
          const childPath = joinPath([...segs, delta.key]);
          const childSnap = buildSandboxSnap(
            target.refAt,
            childPath,
            delta.value,
            delta.exportValue,
          );
          try {
            callback.call(normalizedContext, childSnap, delta.previousChildName);
          } catch {
            // Isolate listener callback errors across multi-child window batches.
          }
        }
        return;
      }
      const snap = hydrateRemoteWireSnapshot(target.refAt, target.canonical, wire);
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
  const shouldRetainUnsub = entry.active && !erroredSynchronously;
  if (shouldRetainUnsub) {
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
  if (eventType !== undefined) {
    assertValidEventType('off', eventType);
  }
  const normalizedContext = context ?? undefined;
  target.listeners.detachMatching(
    target.canonical,
    spec,
    eventType,
    callback,
    normalizedContext,
  );
}
