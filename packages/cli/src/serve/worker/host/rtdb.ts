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
  update as rtdbUpdate,
  remove as rtdbRemove,
  serverTimestamp as rtdbServerTimestamp,
  sandbox as rtdbSandbox,
  type DataSnapshot,
} from 'pyric/database/modular';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { lensRtdb } from './core.js';

export function rtdbSnapToWire(snap: DataSnapshot): unknown {
  return {
    key: snap.key,
    exists: snap.exists(),
    value: snap.val(),
    size: snap.size,
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
  'rtdb.update',
  'rtdb.remove',
  'rtdb.push',
  'rtdb.adminSnapshot',
]);

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
        ok(port, msg.id, rtdbSnapToWire(await rtdbGet(rtdbRef(db, msg.path))));
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

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
