/**
 * Rules deployment + status over the worker port — Firestore and RTDB rulesets.
 */

import { nextId, rpc } from './core.js';
import { firestoreControlRpc, normalizeClientDatabaseId } from './firestore-database.js';
import type { ClientDb, ClientRtdb } from './handles.js';

// ─── setRules ────────────────────────────────────────────────────────────

/**
 * Deploy new rules to the worker's sandbox. Active onSnapshot listeners
 * that were allowed by the old rules may start receiving error callbacks
 * if the new rules deny them.
 */
export async function setRules(
  db: ClientDb,
  source: string,
  databaseId?: string,
): Promise<{ warnings: unknown[] }> {
  const effectiveDbId = normalizeClientDatabaseId(databaseId) ?? normalizeClientDatabaseId(db.databaseId);
  let targetDb: ClientDb;
  if (effectiveDbId === undefined) {
    targetDb = { __kind: 'client-db', type: 'firestore', port: db.port };
  } else {
    targetDb = { __kind: 'client-db', type: 'firestore', port: db.port, databaseId: effectiveDbId };
  }
  const result = await firestoreControlRpc(targetDb, {
    t: 'op',
    id: nextId(),
    method: 'setRules',
    source,
  });
  return result as { warnings: unknown[] };
}

export async function setFirestoreRules(
  db: ClientDb,
  source: string,
  databaseId?: string,
): Promise<{ ok: boolean; warnings: unknown[]; messages: unknown[] }> {
  const effectiveDbId = normalizeClientDatabaseId(databaseId) ?? normalizeClientDatabaseId(db.databaseId);
  let targetDb: ClientDb;
  if (effectiveDbId === undefined) {
    targetDb = { __kind: 'client-db', type: 'firestore', port: db.port };
  } else {
    targetDb = { __kind: 'client-db', type: 'firestore', port: db.port, databaseId: effectiveDbId };
  }
  const result = await firestoreControlRpc(targetDb, {
    t: 'op',
    id: nextId(),
    method: 'setFirestoreRules',
    source,
  });
  return result as { ok: boolean; warnings: unknown[]; messages: unknown[] };
}

export async function setDatabaseRules(
  db: ClientDb | ClientRtdb,
  source: unknown,
): Promise<{ ok: boolean; messages: unknown[] }> {
  const result = await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'setDatabaseRules',
    source,
  });
  return result as { ok: boolean; messages: unknown[] };
}

export async function getActiveRules(
  db: ClientDb | ClientRtdb,
  service?: 'firestore' | 'database',
): Promise<unknown> {
  if (service !== 'database' && db.__kind === 'client-db' && db.databaseId !== undefined) {
    return firestoreControlRpc(db, { t: 'op', id: nextId(), method: 'getActiveRules', service });
  }
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getActiveRules', service });
}

export async function getRulesStatus(
  db: ClientDb | ClientRtdb,
  service?: 'firestore' | 'database',
): Promise<unknown> {
  if (service !== 'database' && db.__kind === 'client-db' && db.databaseId !== undefined) {
    return firestoreControlRpc(db, { t: 'op', id: nextId(), method: 'getRulesStatus', service });
  }
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getRulesStatus', service });
}
