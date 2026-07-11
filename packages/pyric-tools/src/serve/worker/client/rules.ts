/**
 * Rules deployment + status over the worker port — Firestore and RTDB rulesets.
 */

import { nextId, rpc } from './core.js';
import type { ClientDb, ClientRtdb } from './handles.js';

// ─── setRules ────────────────────────────────────────────────────────────

/**
 * Deploy new rules to the worker's sandbox. Active onSnapshot listeners
 * that were allowed by the old rules may start receiving error callbacks
 * if the new rules deny them.
 */
export async function setRules(db: ClientDb, source: string): Promise<{ warnings: unknown[] }> {
  const result = await rpc(db.port, {
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
): Promise<{ ok: boolean; warnings: unknown[]; messages: unknown[] }> {
  const result = await rpc(db.port, {
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
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getActiveRules', service });
}

export async function getRulesStatus(
  db: ClientDb | ClientRtdb,
  service?: 'firestore' | 'database',
): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'getRulesStatus', service });
}
