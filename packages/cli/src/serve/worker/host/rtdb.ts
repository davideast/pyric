/**
 * SharedWorker host — RTDB modular ops (playground shared-runtime bridge).
 *
 * `rtdb.get/set/update/remove/push` run against the op's lens-resolved Database
 * handle (impersonation / admin / anon / port-session, via `lensRtdb`);
 * `rtdb.adminSnapshot` reads the whole tree through the rules-bypass admin
 * handle. Owns the RTDB server-sentinel reconstruction and the snapshot→wire
 * shaping (`rtdbSnapToWire`, also used by the value-subscription handler).
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import {
  ref as rtdbRef,
  get as rtdbGet,
  set as rtdbSet,
  setPriority as rtdbSetPriority,
  setWithPriority as rtdbSetWithPriority,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onDisconnect as rtdbOnDisconnect,
  serverTimestamp as rtdbServerTimestamp,
  runTransaction as rtdbRunTransaction,
  QUERY_SYMBOL,
  sandbox as rtdbSandbox,
  type DataSnapshot,
  type DatabaseReference,
  type Query,
} from 'pyric/database';
import {
  DisconnectOperationQueue,
  type DisconnectOperation,
} from 'pyric/database/internal';

import type { OpMessage, RtdbQuerySpec } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { lensRtdb } from './core.js';
import { sameRtdbValue } from '../rtdb-value-equality.js';

export function rtdbSnapToWire(snap: DataSnapshot): unknown {
  const entries: Array<{
    key: string;
    value: unknown;
    priority: string | number | null;
    exportValue: unknown;
  }> = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      entries.push({
        key: child.key,
        value: child.val(),
        priority: child.priority,
        exportValue: child.exportVal(),
      });
    }
  });
  return {
    key: snap.key,
    exists: snap.exists(),
    value: snap.val(),
    size: snap.size,
    priority: snap.priority,
    exportValue: snap.exportVal(),
    entries,
  };
}

export function rtdbTarget(
  db: Parameters<typeof rtdbRef>[0],
  path: string,
  spec?: RtdbQuerySpec,
): DatabaseReference | Query {
  const targetRef = rtdbRef(db, path);
  if (!spec) return targetRef;
  return {
    ref: targetRef,
    _spec: spec,
    [QUERY_SYMBOL]: true,
    isEqual: (other) => other === null ? false : other.ref === targetRef && other._spec === spec,
    toJSON: () => targetRef.toString(),
    toString: () => targetRef.toString(),
  };
}

function resolveRtdbSentinels(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const marker = value as { __rtdbSentinel?: unknown };
    if (marker.__rtdbSentinel === 'serverTimestamp') return rtdbServerTimestamp();
    if (Array.isArray(value)) return value.map(resolveRtdbSentinels);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRtdbSentinels(v);
    return out;
  }
  return value;
}

/** The RTDB op methods routed to {@link handleRtdbOp}. */
const RTDB_METHODS = new Set<string>([
  'rtdb.get',
  'rtdb.set',
  'rtdb.setPriority',
  'rtdb.setWithPriority',
  'rtdb.update',
  'rtdb.remove',
  'rtdb.push',
  'rtdb.adminSnapshot',
  'rtdb.onDisconnectSet',
  'rtdb.onDisconnectUpdate',
  'rtdb.onDisconnectRemove',
  'rtdb.onDisconnectCancel',
  'rtdb.goOffline',
  'rtdb.goOnline',
  'rtdb.transactionCommit',
]);

interface PortDisconnectMetadata {
  actAs?: OpMessage['actAs'];
}

type PortDisconnectOperation = DisconnectOperation<PortDisconnectMetadata>;

const disconnectQueues = new WeakMap<HostCtx, Map<PortLike, DisconnectOperationQueue<PortDisconnectMetadata>>>();
const offlinePorts = new WeakMap<HostCtx, Set<PortLike>>();

function offlinePortSet(ctx: HostCtx): Set<PortLike> {
  let ports = offlinePorts.get(ctx);
  if (!ports) offlinePorts.set(ctx, ports = new Set());
  return ports;
}

function portQueue(ctx: HostCtx, port: PortLike): DisconnectOperationQueue<PortDisconnectMetadata> {
  let ports = disconnectQueues.get(ctx);
  if (!ports) disconnectQueues.set(ctx, ports = new Map());
  let queue = ports.get(port);
  if (!queue) ports.set(port, queue = new DisconnectOperationQueue());
  return queue;
}

async function validateDisconnectOperation(ctx: HostCtx, port: PortLike, operation: PortDisconnectOperation): Promise<void> {
  const db = lensRtdb(ctx, operation.actAs, port);
  const handle = rtdbOnDisconnect(rtdbRef(db, operation.path));
  if (operation.kind === 'update') await handle.update(operation.values);
  else if (operation.kind === 'remove') await handle.remove();
  else if (operation.priority !== undefined) await handle.setWithPriority(operation.value, operation.priority);
  else await handle.set(operation.value as never);
  await handle.cancel();
}

async function queueDisconnectOperation(ctx: HostCtx, port: PortLike, operation: PortDisconnectOperation): Promise<void> {
  await validateDisconnectOperation(ctx, port, operation);
  const queue = portQueue(ctx, port);
  queue.set(operation);
}

export async function drainPortRtdbDisconnects(ctx: HostCtx, port: PortLike): Promise<void> {
  const ports = disconnectQueues.get(ctx);
  const queue = ports?.get(port);
  if (!queue) return;
  ports!.delete(port);
  const failures: unknown[] = [];
  for (const operation of queue.takeAll()) {
    try {
      const db = lensRtdb(ctx, operation.actAs, port);
      const target = rtdbRef(db, operation.path);
      if (operation.kind === 'update') await rtdbUpdate(target, resolveRtdbSentinels(operation.values) as Record<string, unknown>);
      else if (operation.kind === 'remove') await rtdbRemove(target);
      else if (
        operation.mergeAfterChildRegistration && operation.value !== null &&
        typeof operation.value === 'object' && !Array.isArray(operation.value)
      ) await rtdbUpdate(target, resolveRtdbSentinels(operation.value) as Record<string, unknown>);
      else if (operation.priority !== undefined) {
        await rtdbSetWithPriority(
          target,
          resolveRtdbSentinels(operation.value) as never,
          operation.priority,
        );
      } else await rtdbSet(target, resolveRtdbSentinels(operation.value) as never);
    } catch (error) {
      failures.push(error);
    }
  }
  await bestEffortFlush(ctx);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Multiple SharedWorker onDisconnect operations failed');
}

export function clearAllRtdbDisconnects(ctx: HostCtx): void {
  disconnectQueues.get(ctx)?.clear();
  offlinePorts.get(ctx)?.clear();
}

export function forgetPortRtdbConnection(ctx: HostCtx, port: PortLike): void {
  disconnectQueues.get(ctx)?.delete(port);
  offlinePorts.get(ctx)?.delete(port);
}

export function isRtdbOp(method: OpMessage['method']): boolean {
  return RTDB_METHODS.has(method);
}

export async function handleRtdbOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'rtdb.get': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        ok(port, msg.id, rtdbSnapToWire(await rtdbGet(rtdbTarget(db, msg.path, msg.query))));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.set': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        const value = resolveRtdbSentinels(msg.value);
        await rtdbSet(rtdbRef(db, msg.path), value as never);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.setPriority': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        await rtdbSetPriority(rtdbRef(db, msg.path), msg.priority);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.setWithPriority': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        await rtdbSetWithPriority(
          rtdbRef(db, msg.path),
          resolveRtdbSentinels(msg.value) as never,
          msg.priority,
        );
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.update': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        await rtdbUpdate(rtdbRef(db, msg.path), resolveRtdbSentinels(msg.values) as Record<string, unknown>);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.remove': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        await rtdbRemove(rtdbRef(db, msg.path));
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.push': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        const childPath = `${msg.path}/${msg.key}`;
        if (msg.value !== undefined) {
          await rtdbSet(
            rtdbRef(db, childPath),
            resolveRtdbSentinels(msg.value) as never,
          );
          await bestEffortFlush(ctx);
        }
        const normalizedPath = `/${childPath.split('/').filter(Boolean).join('/')}`;
        ok(port, msg.id, { key: msg.key, path: normalizedPath });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.adminSnapshot': {
      try {
        ok(port, msg.id, rtdbSandbox.snapshotState(lensRtdb(ctx, { mode: 'admin' }, port)));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectSet': {
      try {
        await queueDisconnectOperation(ctx, port, {
          kind: 'set', path: msg.path, value: resolveRtdbSentinels(msg.value), priority: msg.priority, actAs: msg.actAs,
        });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectUpdate': {
      try {
        await queueDisconnectOperation(ctx, port, {
          kind: 'update', path: msg.path, values: resolveRtdbSentinels(msg.values) as Record<string, unknown>, actAs: msg.actAs,
        });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectRemove': {
      try {
        await queueDisconnectOperation(ctx, port, { kind: 'remove', path: msg.path, actAs: msg.actAs });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectCancel': {
      const queue = portQueue(ctx, port);
      queue.cancel(msg.path);
      ok(port, msg.id, null);
      break;
    }

    case 'rtdb.goOffline': {
      try {
        const offline = offlinePortSet(ctx);
        if (!offline.has(port)) {
          offline.add(port);
          await drainPortRtdbDisconnects(ctx, port);
        }
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.goOnline': {
      offlinePortSet(ctx).delete(port);
      ok(port, msg.id, null);
      break;
    }

    case 'rtdb.transactionCommit': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port);
        const target = rtdbRef(db, msg.path);
        let retry = false;
        const result = await rtdbRunTransaction(
          target,
          (current) => {
            if (!sameRtdbValue(current, msg.expected)) {
              retry = true;
              return undefined;
            }
            return resolveRtdbSentinels(msg.value) as never;
          },
          { applyLocally: msg.applyLocally },
        );
        await bestEffortFlush(ctx);
        ok(port, msg.id, {
          retry,
          committed: result.committed,
          snapshot: rtdbSnapToWire(result.snapshot),
        });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
