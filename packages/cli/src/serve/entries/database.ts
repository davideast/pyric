/**
 * The bundle the import map serves for `firebase/database`.
 *
 * The SharedWorker client already carries the RTDB data-plane used by Studio
 * and the Playground. This entry gives served apps the same common modular SDK
 * surface while the in-page fallback delegates to `pyric/database`.
 */
import './init.js';
import * as ip from 'pyric/database';
import { getDatabase as pyricGetDatabase } from 'pyric/database';
import { queryIdentifier } from 'pyric/database/internal';
import { rtdbChild, rtdbGetDatabase, rtdbRef } from '../worker/client/rtdb-references.js';
import { rtdbGet } from '../worker/client/rtdb-reads.js';
import {
  rtdbPush,
  rtdbRemove,
  rtdbSet,
  rtdbSetPriority,
  rtdbSetWithPriority,
  rtdbUpdate,
} from '../worker/client/rtdb-writes.js';
import {
  rtdbOff,
  rtdbOnChildAdded,
  rtdbOnChildChanged,
  rtdbOnChildMoved,
  rtdbOnChildRemoved,
  rtdbOnValue,
} from '../worker/client/rtdb-listeners.js';
import { rtdbRunTransaction } from '../worker/client/rtdb-transactions.js';
import {
  RtdbOnDisconnect,
  rtdbGoOffline,
  rtdbGoOnline,
  rtdbOnDisconnect,
} from '../worker/client/rtdb-connection-lifecycle.js';
import {
  rtdbConnectDatabaseEmulator,
  rtdbServerTimestamp,
} from '../worker/client/rtdb-controls.js';
import { useWorker } from './worker-runtime.js';
import { getApp, type FirebaseApp } from 'pyric/app';
import { workerClientForApp } from './app-client.js';

const workerDatabaseByApp = new WeakMap<FirebaseApp, ReturnType<typeof pyricGetDatabase>>();

type WorkerSnapshot = Awaited<ReturnType<typeof rtdbGet>>;

function wrapWorkerSnapshot(snapshot: WorkerSnapshot): ip.DataSnapshot {
  return new ip.DataSnapshot({
    key: snapshot.key,
    size: snapshot.size,
    priority: snapshot.priority,
    ref: snapshot.ref as unknown as ip.DatabaseReference,
    exists: () => snapshot.exists(),
    val: () => snapshot.val() as ip.JsonValue,
    child: (path) => wrapWorkerSnapshot(snapshot.child(path)),
    hasChild: (path) => snapshot.hasChild(path),
    hasChildren: () => snapshot.hasChildren(),
    exportVal: () => snapshot.exportVal() as ip.JsonValue,
    toJSON: () => snapshot.toJSON() as ip.JsonValue,
    forEach: (callback) => snapshot.forEach((childSnapshot) =>
      callback(wrapWorkerSnapshot(childSnapshot))),
  });
}

export const getDatabase = ((app?: FirebaseApp) => {
  const resolved = app ?? getApp();
  if (!useWorker) return pyricGetDatabase(resolved);
  const existing = workerDatabaseByApp.get(resolved);
  if (existing) return existing;
  const client = workerClientForApp(resolved);
  const handle = Object.assign(
    new ip.Database(undefined, resolved),
    rtdbGetDatabase(client),
    { app: resolved },
  ) as ReturnType<typeof pyricGetDatabase>;
  workerDatabaseByApp.set(resolved, handle);
  return handle;
}) as typeof pyricGetDatabase;

export const ref = (useWorker ? rtdbRef : ip.ref) as typeof ip.ref;
export const child = (useWorker ? rtdbChild : ip.child) as typeof ip.child;
export const get = (
  useWorker
    ? (async (target: Parameters<typeof ip.get>[0]) =>
        wrapWorkerSnapshot(await rtdbGet(target as never)))
    : ip.get
) as typeof ip.get;
export const set = (useWorker ? rtdbSet : ip.set) as typeof ip.set;
export const update = (useWorker ? rtdbUpdate : ip.update) as typeof ip.update;
export const remove = (useWorker ? rtdbRemove : ip.remove) as typeof ip.remove;
export const push = (useWorker ? rtdbPush : ip.push) as typeof ip.push;
export const onValue = (
  useWorker
    ? ((
        target: Parameters<typeof ip.onValue>[0],
        callback: Parameters<typeof ip.onValue>[1],
        cancelOrOptions?: Parameters<typeof ip.onValue>[2],
        options?: Parameters<typeof ip.onValue>[3],
      ) => rtdbOnValue(
        target as never,
        (snapshot) => callback(wrapWorkerSnapshot(snapshot)),
        cancelOrOptions as never,
        options,
        callback,
      ))
    : ip.onValue
) as typeof ip.onValue;
export const onChildAdded = (
  useWorker
    ? ((target: Parameters<typeof ip.onChildAdded>[0], callback: Parameters<typeof ip.onChildAdded>[1], cancelOrOptions?: Parameters<typeof ip.onChildAdded>[2], options?: Parameters<typeof ip.onChildAdded>[3]) =>
        rtdbOnChildAdded(target as never, (snapshot, previous) => callback(wrapWorkerSnapshot(snapshot), previous), cancelOrOptions as never, options, callback))
    : ip.onChildAdded
) as typeof ip.onChildAdded;
export const onChildChanged = (
  useWorker
    ? ((target: Parameters<typeof ip.onChildChanged>[0], callback: Parameters<typeof ip.onChildChanged>[1], cancelOrOptions?: Parameters<typeof ip.onChildChanged>[2], options?: Parameters<typeof ip.onChildChanged>[3]) =>
        rtdbOnChildChanged(target as never, (snapshot, previous) => callback(wrapWorkerSnapshot(snapshot), previous), cancelOrOptions as never, options, callback))
    : ip.onChildChanged
) as typeof ip.onChildChanged;
export const onChildRemoved = (
  useWorker
    ? ((target: Parameters<typeof ip.onChildRemoved>[0], callback: Parameters<typeof ip.onChildRemoved>[1], cancelOrOptions?: Parameters<typeof ip.onChildRemoved>[2], options?: Parameters<typeof ip.onChildRemoved>[3]) =>
        rtdbOnChildRemoved(target as never, (snapshot, previous) => callback(wrapWorkerSnapshot(snapshot), previous), cancelOrOptions as never, options, callback))
    : ip.onChildRemoved
) as typeof ip.onChildRemoved;
export const onChildMoved = (
  useWorker
    ? ((target: Parameters<typeof ip.onChildMoved>[0], callback: Parameters<typeof ip.onChildMoved>[1], cancelOrOptions?: Parameters<typeof ip.onChildMoved>[2], options?: Parameters<typeof ip.onChildMoved>[3]) =>
        rtdbOnChildMoved(target as never, (snapshot, previous) => callback(wrapWorkerSnapshot(snapshot), previous), cancelOrOptions as never, options, callback))
    : ip.onChildMoved
) as typeof ip.onChildMoved;
export const onDisconnect = (
  useWorker ? rtdbOnDisconnect : ip.onDisconnect
) as typeof ip.onDisconnect;
export const OnDisconnect = (
  useWorker ? RtdbOnDisconnect : ip.OnDisconnect
) as typeof ip.OnDisconnect;
export const off = (useWorker ? rtdbOff : ip.off) as typeof ip.off;
export const increment = ip.increment;
export const serverTimestamp = (
  useWorker ? rtdbServerTimestamp : ip.serverTimestamp
) as typeof ip.serverTimestamp;
export const connectDatabaseEmulator = (
  useWorker ? rtdbConnectDatabaseEmulator : ip.connectDatabaseEmulator
) as typeof ip.connectDatabaseEmulator;

// ── Low-hanging-fruit exports (issue #149) ────────────────────────────────
// Served mode is always sandbox-backed (never a prod handle). The connection
// controls still cross the worker boundary because goOffline drains that
// port's one-shot onDisconnect queue; transport-selection controls remain
// honest no-ops in either runtime.
export const goOffline = (useWorker ? rtdbGoOffline : ip.goOffline) as typeof ip.goOffline;
export const goOnline = (useWorker ? rtdbGoOnline : ip.goOnline) as typeof ip.goOnline;
export const forceLongPolling = (() => {}) as typeof ip.forceLongPolling;
export const forceWebSockets = (() => {}) as typeof ip.forceWebSockets;
export const enableLogging = ((_logger?: unknown, _persistent?: unknown) => {}) as typeof ip.enableLogging;

/**
 * `refFromURL(db, url)` — parse the path out of the URL and delegate to the
 * picked `ref` (worker or in-page), so the resolved ref behaves exactly like
 * `ref(db, path)`. The URL host/namespace is not honored (served sandbox is
 * single-database) — matching the in-page `pyric/database` behavior.
 */
export const refFromURL = ((db: unknown, url: string) => {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(
      `firebase/database refFromURL received a value that is not an absolute URL: ${url}`,
    );
  }
  return (ref as (db: unknown, path?: string) => unknown)(db, path);
}) as typeof ip.refFromURL;

export const runTransaction = (
  useWorker
    ? (async (
        target: Parameters<typeof ip.runTransaction>[0],
        update: Parameters<typeof ip.runTransaction>[1],
        options?: Parameters<typeof ip.runTransaction>[2],
      ) => {
        const result = await rtdbRunTransaction(
          target as never,
          update as (current: unknown) => unknown,
          options,
        );
        return new ip.TransactionResult(result.committed, wrapWorkerSnapshot(result.snapshot));
      })
    : ip.runTransaction
) as typeof ip.runTransaction;

export const query = (
  useWorker
    ? ((target: Parameters<typeof ip.query>[0], ...constraints: Parameters<typeof ip.query>[1][]) => {
        const built = ip.query(target, ...constraints);
        return {
          ...built,
          isEqual(other: ip.Query | null) {
            return other !== null
              && 'port' in built.ref
              && 'port' in other.ref
              && built.ref.port === other.ref.port
              && built.ref._path === other.ref._path
              && queryIdentifier(built._spec) === queryIdentifier(other._spec);
          },
        };
      })
    : ip.query
) as typeof ip.query;
export const orderByChild = ip.orderByChild;
export const orderByKey = ip.orderByKey;
export const orderByPriority = ip.orderByPriority;
export const orderByValue = ip.orderByValue;
export const startAt = ip.startAt;
export const startAfter = ip.startAfter;
export const endAt = ip.endAt;
export const endBefore = ip.endBefore;
export const equalTo = ip.equalTo;
export const limitToFirst = ip.limitToFirst;
export const limitToLast = ip.limitToLast;

export const setPriority = (
  useWorker ? rtdbSetPriority : ip.setPriority
) as typeof ip.setPriority;
export const setWithPriority = (
  useWorker ? rtdbSetWithPriority : ip.setWithPriority
) as typeof ip.setWithPriority;

// Runtime constructors and type-only declarations expected by common
// `firebase/database` imports. Served worker results are wrapped above so the
// public handles, snapshots, constraints, and transaction results keep these
// observable constructor identities.
export const Database = ip.Database;
export const DataSnapshot = ip.DataSnapshot;
export const QueryConstraint = ip.QueryConstraint;
export const TransactionResult = ip.TransactionResult;
export type Database = ip.Database;
export type DataSnapshot = ip.DataSnapshot;
export type QueryConstraint = ip.QueryConstraint;
export type TransactionResult = ip.TransactionResult;
export type OnDisconnect = ip.OnDisconnect;
export type DatabaseReference = ip.DatabaseReference;
export type EmulatorMockTokenOptions = ip.EmulatorMockTokenOptions;
export type EventType = ip.EventType;
export type ListenOptions = ip.ListenOptions;
export type Query = ip.Query;
export type QueryConstraintType = ip.QueryConstraintType;
export type ThenableReference = ip.ThenableReference;
export type TransactionOptions = ip.TransactionOptions;
export type Unsubscribe = ip.Unsubscribe;
