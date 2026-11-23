/**
 * Client-side Firestore `databaseId` handle binding, RPC stamping, and
 * subscription gating over SharedWorker and Node-hosted ports.
 */
import { WORKER_PROTOCOL_VERSION, type InboundMessage } from '../protocol.js';
import {
  _snapSubs,
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
import {
  ensurePeerSupportsDatabaseId,
  getKnownPeerWorkerProtocol,
  protocolOneDatabaseIdErrorForPort,
} from './protocol-version.js';
import { reserveSend } from './send-order.js';

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
  const known = getKnownPeerWorkerProtocol(target.port);
  if (known !== undefined) {
    if (known < WORKER_PROTOCOL_VERSION) {
      throw protocolOneDatabaseIdErrorForPort(target.port, databaseId);
    }
    return dataRpc(target.port, { ...msg, databaseId } as InboundMessage & { t: 'op' });
  }
  const handshake = ensurePeerSupportsDatabaseId(target.port, databaseId);
  const reservation = reserveSend(target.port);
  try {
    await handshake;
    return dataRpc(target.port, { ...msg, databaseId } as InboundMessage & { t: 'op' }, reservation);
  } finally {
    reservation.release();
  }
}

export async function firestoreControlRpc(
  db: ClientDb,
  msg: InboundMessage & { t: 'op' },
): Promise<unknown> {
  const databaseId = clientDatabaseIdOf(db);
  if (databaseId === undefined) {
    return rpc(db.port, msg);
  }
  const known = getKnownPeerWorkerProtocol(db.port);
  if (known !== undefined) {
    if (known < WORKER_PROTOCOL_VERSION) {
      throw protocolOneDatabaseIdErrorForPort(db.port, databaseId);
    }
    return rpc(db.port, { ...msg, databaseId } as InboundMessage & { t: 'op' });
  }
  const handshake = ensurePeerSupportsDatabaseId(db.port, databaseId);
  const reservation = reserveSend(db.port);
  try {
    await handshake;
    return rpc(db.port, { ...msg, databaseId } as InboundMessage & { t: 'op' }, reservation);
  } finally {
    reservation.release();
  }
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
  const known = getKnownPeerWorkerProtocol(port);
  if (known !== undefined) {
    if (known >= WORKER_PROTOCOL_VERSION) {
      return openSnapshotSubscription(port, subId, subscription, {
        ...message,
        databaseId,
      } as InboundMessage);
    }
    const registered = registerSnapshotSubscription(port, subId, subscription);
    if (registered === undefined) return false;
    const err = protocolOneDatabaseIdErrorForPort(port, databaseId);
    queueMicrotask(() => {
      if (!_snapSubs.has(subId)) return;
      closeSubscription(port, subId);
      subscription.error?.(err);
    });
    return true;
  }
  const registered = registerSnapshotSubscription(port, subId, subscription);
  if (registered === undefined) return false;
  const handshake = ensurePeerSupportsDatabaseId(port, databaseId);
  const reservation = reserveSend(port);
  void handshake
    .then(
      () => {
        registered.send({ ...message, databaseId } as InboundMessage, reservation);
      },
      (err) => {
        if (!_snapSubs.has(subId)) return;
        closeSubscription(port, subId);
        subscription.error?.(err);
      },
    )
    .finally(() => {
      reservation.release();
    });
  return true;
}
