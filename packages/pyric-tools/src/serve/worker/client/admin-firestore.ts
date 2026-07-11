/**
 * Admin-lens Firestore document ops over the worker port (Pyric Studio data
 * browse) — rule-bypassing reads/writes the host resolves under the admin lens.
 */

import { nextId, rpc } from './core.js';
import type { ClientDb } from './handles.js';

export async function adminGetDocument(db: ClientDb, path: string): Promise<Record<string, unknown> | null> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.getDocument', path })) as Record<string, unknown> | null;
}

export async function adminListDocuments(
  db: ClientDb,
  path: string,
): Promise<Array<{ path: string; data: unknown; phantom?: boolean }>> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.listDocuments', path })) as Array<{ path: string; data: unknown; phantom?: boolean }>;
}

export async function adminSetDocument(db: ClientDb, path: string, data: unknown): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.setDocument', path, data });
}

export async function adminDeleteDocument(db: ClientDb, path: string): Promise<boolean> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'admin.deleteDocument', path })) as boolean;
}

export async function adminReadState(
  db: ClientDb,
  opts: { path?: string; maxDepth?: number } = {},
): Promise<Record<string, unknown>> {
  return (await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'admin.readState',
    ...opts,
  })) as Record<string, unknown>;
}
