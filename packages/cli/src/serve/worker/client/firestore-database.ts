/**
 * Client-side Firestore `databaseId` handle binding, RPC stamping, and
 * subscription gating over SharedWorker and Node-hosted ports.
 */
import type { InboundMessage } from '../protocol.js';
import {
  closeSubscription,
  dataRpc,
  openSnapshotSubscription,
  registerSnapshotSubscription,
  rpc,
} from './core.js';
import { ownerOfWorkerHandle } from './firestore-lifecycle.js';
import type {
  ClientDb,
  ClientPort,
  CollRefHandle,
  DocRefHandle,
  QueryHandle,
} from './handles.js';
import { ensurePeerSupportsDatabaseId } from './protocol-version.js';

type FirestoreWorkerTarget = ClientDb | DocRefHandle<unknown> | CollRefHandle<unknown> | QueryHandle<unknown>;

export function normalizeClientDatabaseId(databaseId?: string): string | undefined {
  if (typeof databaseId !== 'string' || databaseId.length === 0 || databaseId === '(default)') {
    return undefined;
  }
  return databaseId;
}

export function clientDatabaseIdOf(target: FirestoreWorkerTarget): string | undefined {
  const direct = normalizeClientDatabaseId(target.databaseId);
  if (direct !== undefined) return direct;
  const owner = ownerOfWorkerHandle(target) as { databaseId?: string };
  return normalizeClientDatabaseId(owner?.databaseId);
}

/** Return a `ClientDb` sharing `db.port` bound to `databaseId` (`(default)` omits `databaseId`). */
export function withDatabaseId(db: ClientDb, databaseId?: string): ClientDb {
  const normalized = normalizeClientDatabaseId(databaseId);
  const current = normalizeClientDatabaseId(db.databaseId);
  if (normalized === current) return db;
  if (normalized === undefined) {
    return { __kind: 'client-db', type: 'firestore', port: db.port };
  }
  return { __kind: 'client-db', type: 'firestore', port: db.port, databaseId: normalized };
}

export async function firestoreDataRpc(
  target: FirestoreWorkerTarget,
  msg: InboundMessage & { t: 'op' },
): Promise<unknown> {
  const databaseId = clientDatabaseIdOf(target);
  if (databaseId === undefined) {
    return dataRpc(target.port, msg);
  }
  await ensurePeerSupportsDatabaseId(target.port, databaseId);
  return dataRpc(target.port, { ...msg, databaseId } as InboundMessage & { t: 'op' });
}

export async function firestoreControlRpc(
  db: ClientDb,
  msg: InboundMessage & { t: 'op' },
): Promise<unknown> {
  const databaseId = clientDatabaseIdOf(db);
  if (databaseId === undefined) {
    return rpc(db.port, msg);
  }
  await ensurePeerSupportsDatabaseId(db.port, databaseId);
  return rpc(db.port, { ...msg, databaseId } as InboundMessage & { t: 'op' });
}

export function openFirestoreSnapshotSubscription(
  target: FirestoreWorkerTarget,
  port: ClientPort,
  subId: string,
  subscription: Parameters<typeof openSnapshotSubscription>[2],
  message: InboundMessage,
): boolean {
  const databaseId = clientDatabaseIdOf(target);
  if (databaseId === undefined) {
    return openSnapshotSubscription(port, subId, subscription, message);
  }
  const registered = registerSnapshotSubscription(port, subId, subscription);
  if (registered === undefined) return false;
  void ensurePeerSupportsDatabaseId(port, databaseId).then(
    () => {
      registered.send({ ...message, databaseId } as InboundMessage);
    },
    (err) => {
      closeSubscription(port, subId);
      subscription.error?.(err);
    },
  );
  return true;
}
