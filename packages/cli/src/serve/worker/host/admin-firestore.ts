/**
 * SharedWorker host -- admin-lens Firestore document ops (rules bypass),
 * routed per Firestore database via `requestDatabaseId(msg)` (ADR-0021 Decisions 3 and 4).
 */

import { encodeLegacyDocValue, type OpMessage, type ResponseDocValueEncoding } from '../protocol.js';
import { requestDatabaseId } from '../request-database-id.js';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  getDatabaseAdmin,
  isFirestoreDatabaseDeclared,
  missingFirestoreDatabaseNotFoundMessage,
} from 'pyric/firestore/internal';
import { encodeDocValue, requireDocumentData } from 'pyric/firestore/internal/value-codec';
import { SandboxError } from 'pyric/sandbox';
import { hostProjectId, type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';

function encodeAdminDocument(document: unknown, encoding?: ResponseDocValueEncoding): Record<string, unknown> {
  const encoded = encoding === 'legacy' ? encodeLegacyDocValue(document) : encodeDocValue(document);
  return requireDocumentData(JSON.parse(JSON.stringify(encoded)));
}

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
  const dbId = requestDatabaseId(msg);
  const projectId = hostProjectId(ctx) ?? 'demo-project';
  if (dbId !== undefined && !isFirestoreDatabaseDeclared(ctx.sandbox, dbId)) {
    fail(port, msg.id, new SandboxError('not-found', missingFirestoreDatabaseNotFoundMessage(dbId, projectId)));
    return;
  }

  switch (msg.method) {
    case 'admin.getDocument': {
      try {
        const admin = getDatabaseAdmin(ctx.sandbox, dbId, projectId);
        const doc = admin.getDocument(msg.path);
        ok(port, msg.id, doc == null ? doc : encodeAdminDocument(doc, msg.docValueEncoding));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.listDocuments': {
      try {
        const admin = getDatabaseAdmin(ctx.sandbox, dbId, projectId);
        const rows = admin.listDocuments(msg.path).map((row) => ({
          ...row,
          data: encodeAdminDocument(row.data, msg.docValueEncoding),
        }));
        ok(port, msg.id, rows);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.setDocument': {
      try {
        const admin = getDatabaseAdmin(ctx.sandbox, dbId, projectId);
        admin.setDocument(msg.path, msg.data as Record<string, unknown>);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.deleteDocument': {
      try {
        const admin = getDatabaseAdmin(ctx.sandbox, dbId, projectId);
        const deleted = admin.deleteDocument(msg.path);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, deleted);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'admin.readState': {
      try {
        const snap = snapshotDocuments(ctx.sandbox, dbId);
        const out: Record<string, unknown> = {};
        const prefix = msg.path ?? '';
        for (const [path, data] of Object.entries(snap)) {
          if (prefix && !path.startsWith(prefix)) continue;
          if (msg.maxDepth !== undefined && path.split('/').length > msg.maxDepth) continue;
          out[path] = encodeAdminDocument(data, msg.docValueEncoding);
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
