/**
 * SharedWorker host — admin-lens Firestore document ops (rules bypass).
 *
 * The `admin.*` surface used by the pyric-admin remote arm + Pyric Studio's
 * "edit anything as admin": direct document get/list/set/delete against the
 * sandbox admin plane, plus `admin.readState` (a prefix/depth-scoped snapshot
 * of the whole store through the cached admin handle).
 *
 * Routed here by the host dispatcher. These ops act on `ctx.sandbox.admin` /
 * the admin handle directly, so they take no resolved `db`. Never imports the
 * dispatcher.
 */

import { sandbox as sandboxOps } from 'pyric/firestore';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { lensDb } from './core.js';

/** The admin-lens op methods routed to {@link handleAdminFirestoreOp}. */
const ADMIN_METHODS = new Set<string>([
  'admin.getDocument',
  'admin.listDocuments',
  'admin.setDocument',
  'admin.deleteDocument',
  'admin.readState',
]);

export function isAdminFirestoreOp(method: OpMessage['method']): boolean {
  return ADMIN_METHODS.has(method);
}

export async function handleAdminFirestoreOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'admin.getDocument': {
      try {
        ok(port, msg.id, ctx.sandbox.admin.getDocument(msg.path));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.listDocuments': {
      try {
        ok(port, msg.id, ctx.sandbox.admin.listDocuments(msg.path));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.setDocument': {
      try {
        ctx.sandbox.admin.setDocument(msg.path, msg.data as Record<string, unknown>);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.deleteDocument': {
      try {
        const deleted = ctx.sandbox.admin.deleteDocument(msg.path);
        await bestEffortFlush(ctx);
        ok(port, msg.id, deleted);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.readState': {
      try {
        const snap = sandboxOps.snapshotState(ctx.adminDb ?? lensDb(ctx, { mode: 'admin' }));
        const out: Record<string, unknown> = {};
        const prefix = msg.path ?? '';
        for (const [path, data] of Object.entries(snap)) {
          if (prefix && !path.startsWith(prefix)) continue;
          if (msg.maxDepth !== undefined && path.split('/').length > msg.maxDepth) continue;
          out[path] = data;
        }
        ok(port, msg.id, out);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
