import { sdkActivity } from 'pyric/sandbox/internal';
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
  set as rawRtdbSet,
  setPriority as rawRtdbSetPriority,
  setWithPriority as rawRtdbSetWithPriority,
  update as rawRtdbUpdate,
  remove as rawRtdbRemove,
  onDisconnect as rtdbOnDisconnect,
  serverTimestamp as rtdbServerTimestamp,
  runTransaction as rawRtdbRunTransaction,
  push as rawRtdbPush,
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
import { lensRtdb, rtdbInstanceKey } from './rtdb-instances.js';
import { sameRtdbValue } from '../rtdb-value-equality.js';

/** Host execution is transport work, not another public SDK call. */
const rtdbSet = (...args: Parameters<typeof rawRtdbSet>) => sdkActivity.silence(() => rawRtdbSet(...args));
const rtdbUpdate = (...args: Parameters<typeof rawRtdbUpdate>) => sdkActivity.silence(() => rawRtdbUpdate(...args));
const rtdbRemove = (...args: Parameters<typeof rawRtdbRemove>) => sdkActivity.silence(() => rawRtdbRemove(...args));
const rtdbPush = (...args: Parameters<typeof rawRtdbPush>) => sdkActivity.silence(() => rawRtdbPush(...args));
const rtdbSetPriority = (...args: Parameters<typeof rawRtdbSetPriority>) => sdkActivity.silence(() => rawRtdbSetPriority(...args));
const rtdbSetWithPriority = (...args: Parameters<typeof rawRtdbSetWithPriority>) => sdkActivity.silence(() => rawRtdbSetWithPriority(...args));
const rtdbRunTransaction = (...args: Parameters<typeof rawRtdbRunTransaction>) => sdkActivity.silence(() => rawRtdbRunTransaction(...args));

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
  /** The instance name the operation was registered on; absent is the default instance. */
  instance?: string;
}

type PortDisconnectOperation = DisconnectOperation<PortDisconnectMetadata>;

/** Each port's onDisconnect queue per instance, keyed by instance key. As in
 *  production, every database instance is its own connection. */
type PortQueues = Map<string, DisconnectOperationQueue<PortDisconnectMetadata>>;

const disconnectQueues = new WeakMap<HostCtx, Map<PortLike, PortQueues>>();
/** The instance keys each port has taken offline with `goOffline`. */
const offlineInstances = new WeakMap<HostCtx, Map<PortLike, Set<string>>>();

function portOfflineInstances(ctx: HostCtx, port: PortLike): Set<string> {
  hostDisconnectQueues(ctx);
  let ports = offlineInstances.get(ctx);
  if (ports === undefined) {
    ports = new Map();
    offlineInstances.set(ctx, ports);
  }
  let instances = ports.get(port);
  if (instances === undefined) {
    instances = new Set();
    ports.set(port, instances);
  }
  return instances;
}

function hostDisconnectQueues(ctx: HostCtx): Map<PortLike, PortQueues> {
  const existing = disconnectQueues.get(ctx);
  const hasQueues = existing !== undefined;
  if (hasQueues) return existing;
  const ports = new Map<PortLike, PortQueues>();
  disconnectQueues.set(ctx, ports);
  // The sandbox owns this subscription and releases it on disposal.
  ctx.sandbox.onEvent((event) => {
    const startsReset = event.kind === 'session_boundary' && event.phase === 'reset';
    if (startsReset) clearAllRtdbDisconnects(ctx);
  });
  return ports;
}

function portQueue(ctx: HostCtx, port: PortLike, instanceKey: string): DisconnectOperationQueue<PortDisconnectMetadata> {
  const ports = hostDisconnectQueues(ctx);
  let queues = ports.get(port);
  if (queues === undefined) {
    queues = new Map();
    ports.set(port, queues);
  }
  const existing = queues.get(instanceKey);
  const hasQueue = existing !== undefined;
  if (hasQueue) return existing;
  const queue = new DisconnectOperationQueue<PortDisconnectMetadata>();
  queues.set(instanceKey, queue);
  return queue;
}

async function validateDisconnectOperation(ctx: HostCtx, port: PortLike, operation: PortDisconnectOperation): Promise<void> {
  const db = lensRtdb(ctx, operation.actAs, port, operation.instance);
  const handle = rtdbOnDisconnect(rtdbRef(db, operation.path));
  if (operation.kind === 'update') await handle.update(operation.values);
  else if (operation.kind === 'remove') await handle.remove();
  else if (operation.priority !== undefined) await handle.setWithPriority(operation.value, operation.priority);
  else await handle.set(operation.value as never);
  await handle.cancel();
}

async function queueDisconnectOperation(ctx: HostCtx, port: PortLike, operation: PortDisconnectOperation): Promise<void> {
  const instanceKey = rtdbInstanceKey(ctx, operation.instance);
  await validateDisconnectOperation(ctx, port, operation);
  portQueue(ctx, port, instanceKey).set(operation);
}

/**
 * Run a port's queued onDisconnect operations: those of one instance when
 * `instanceKey` is given (that instance went offline), else every instance's
 * (the port closed).
 */
export async function drainPortRtdbDisconnects(ctx: HostCtx, port: PortLike, instanceKey?: string): Promise<void> {
  const queues = disconnectQueues.get(ctx)?.get(port);
  if (!queues) return;
  const drained = instanceKey === undefined ? [...queues.keys()] : [instanceKey];
  const operations: PortDisconnectOperation[] = [];
  for (const key of drained) {
    const queue = queues.get(key);
    if (!queue) continue;
    queues.delete(key);
    operations.push(...queue.takeAll());
  }
  if (queues.size === 0) disconnectQueues.get(ctx)?.delete(port);
  if (operations.length === 0) return;
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      const db = lensRtdb(ctx, operation.actAs, port, operation.instance);
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
  await bestEffortFlush(ctx, 'disconnect');
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Multiple SharedWorker onDisconnect operations failed');
}

function clearAllRtdbDisconnects(ctx: HostCtx): void {
  disconnectQueues.get(ctx)?.clear();
  offlineInstances.get(ctx)?.clear();
}

export function forgetPortRtdbConnection(ctx: HostCtx, port: PortLike): void {
  disconnectQueues.get(ctx)?.delete(port);
  offlineInstances.get(ctx)?.delete(port);
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
        // A transaction reads its input as the sandbox's transaction engine
        // does, without the read rules; its commit evaluates the write rules.
        const lens = msg.transaction === true ? { mode: 'admin' as const } : msg.actAs;
        const db = lensRtdb(ctx, lens, port, msg.instance);
        ok(port, msg.id, rtdbSnapToWire(await sdkActivity.silence(() => rtdbGet(rtdbTarget(db, msg.path, msg.query)))));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.set': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        const value = resolveRtdbSentinels(msg.value);
        await rtdbSet(rtdbRef(db, msg.path), value as never);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.setPriority': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        await rtdbSetPriority(rtdbRef(db, msg.path), msg.priority);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.setWithPriority': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        await rtdbSetWithPriority(
          rtdbRef(db, msg.path),
          resolveRtdbSentinels(msg.value) as never,
          msg.priority,
        );
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.update': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        await rtdbUpdate(rtdbRef(db, msg.path), resolveRtdbSentinels(msg.values) as Record<string, unknown>);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.remove': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        await rtdbRemove(rtdbRef(db, msg.path));
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.push': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
        // A caller that can wait for the reply omits `key`, and the key is
        // minted here from the sandbox clock. A page cannot wait: its `push()`
        // returns a reference synchronously, so it mints its own from the clock
        // mirror and sends it.
        let key = msg.key;
        if (key === undefined) {
          key = rtdbPush(rtdbRef(db, msg.path)).key ?? '';
        }
        const childPath = `${msg.path}/${key}`;
        if (msg.value !== undefined) {
          await rtdbSet(
            rtdbRef(db, childPath),
            resolveRtdbSentinels(msg.value) as never,
          );
          await bestEffortFlush(ctx, msg.method);
        }
        const normalizedPath = `/${childPath.split('/').filter(Boolean).join('/')}`;
        ok(port, msg.id, { key, path: normalizedPath });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.adminSnapshot': {
      try {
        ok(port, msg.id, rtdbSandbox.snapshotState(lensRtdb(ctx, { mode: 'admin' }, port, msg.instance)));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectSet': {
      try {
        await queueDisconnectOperation(ctx, port, {
          kind: 'set', path: msg.path, value: resolveRtdbSentinels(msg.value), priority: msg.priority, actAs: msg.actAs, instance: msg.instance,
        });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectUpdate': {
      try {
        await queueDisconnectOperation(ctx, port, {
          kind: 'update', path: msg.path, values: resolveRtdbSentinels(msg.values) as Record<string, unknown>, actAs: msg.actAs, instance: msg.instance,
        });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectRemove': {
      try {
        await queueDisconnectOperation(ctx, port, { kind: 'remove', path: msg.path, actAs: msg.actAs, instance: msg.instance });
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.onDisconnectCancel': {
      try {
        portQueue(ctx, port, rtdbInstanceKey(ctx, msg.instance)).cancel(msg.path);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.goOffline': {
      try {
        const instanceKey = rtdbInstanceKey(ctx, msg.instance);
        const offline = portOfflineInstances(ctx, port);
        if (!offline.has(instanceKey)) {
          offline.add(instanceKey);
          await drainPortRtdbDisconnects(ctx, port, instanceKey);
        }
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.goOnline': {
      try {
        portOfflineInstances(ctx, port).delete(rtdbInstanceKey(ctx, msg.instance));
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'rtdb.transactionCommit': {
      try {
        const db = lensRtdb(ctx, msg.actAs, port, msg.instance);
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
        await bestEffortFlush(ctx, msg.method);
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
