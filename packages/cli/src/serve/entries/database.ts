/**
 * The bundle the import map serves for `firebase/database`.
 *
 * The SharedWorker client already carries the RTDB data-plane used by Studio
 * and the Playground. This entry gives served apps the same common modular SDK
 * surface while the in-page fallback delegates to `pyric/database`.
 */
import * as ip from 'pyric/database';
import { getDatabase as pyricGetDatabase } from 'pyric/database';
import {
  rtdbChild,
  rtdbConnectDatabaseEmulator,
  rtdbGet,
  rtdbGetDatabase,
  rtdbOff,
  rtdbOnValue,
  rtdbOnChildAdded,
  rtdbOnChildChanged,
  rtdbOnDisconnect,
  rtdbGoOffline,
  rtdbGoOnline,
  RtdbOnDisconnect,
  rtdbPush,
  rtdbRef,
  rtdbRemove,
  rtdbServerTimestamp,
  rtdbSet,
  rtdbUpdate,
} from '../worker/client.js';
import { useWorker } from './worker-runtime.js';
import { getApp, type FirebaseApp } from 'pyric/app';
import { workerClientForApp } from './app-client.js';

const workerDatabaseByApp = new WeakMap<FirebaseApp, ReturnType<typeof pyricGetDatabase>>();

export const getDatabase = ((app?: FirebaseApp) => {
  const resolved = app ?? getApp();
  if (!useWorker) return pyricGetDatabase(resolved);
  const existing = workerDatabaseByApp.get(resolved);
  if (existing) return existing;
  const client = workerClientForApp(resolved);
  const handle = Object.assign(rtdbGetDatabase(client), { app: resolved }) as unknown as ReturnType<typeof pyricGetDatabase>;
  workerDatabaseByApp.set(resolved, handle);
  return handle;
}) as typeof pyricGetDatabase;

export const ref = (useWorker ? rtdbRef : ip.ref) as typeof ip.ref;
export const child = (useWorker ? rtdbChild : ip.child) as typeof ip.child;
export const get = (useWorker ? rtdbGet : ip.get) as typeof ip.get;
export const set = (useWorker ? rtdbSet : ip.set) as typeof ip.set;
export const update = (useWorker ? rtdbUpdate : ip.update) as typeof ip.update;
export const remove = (useWorker ? rtdbRemove : ip.remove) as typeof ip.remove;
export const push = (useWorker ? rtdbPush : ip.push) as typeof ip.push;
export const onValue = (useWorker ? rtdbOnValue : ip.onValue) as typeof ip.onValue;
export const onChildAdded = (
  useWorker ? rtdbOnChildAdded : ip.onChildAdded
) as typeof ip.onChildAdded;
export const onChildChanged = (
  useWorker ? rtdbOnChildChanged : ip.onChildChanged
) as typeof ip.onChildChanged;
export const onDisconnect = (
  useWorker ? rtdbOnDisconnect : ip.onDisconnect
) as typeof ip.onDisconnect;
export const OnDisconnect = (
  useWorker ? RtdbOnDisconnect : ip.OnDisconnect
) as typeof ip.OnDisconnect;
export const off = (useWorker ? rtdbOff : ip.off) as typeof ip.off;
export const serverTimestamp = (
  useWorker ? rtdbServerTimestamp : ip.serverTimestamp
) as typeof ip.serverTimestamp;
export const connectDatabaseEmulator = (
  useWorker ? rtdbConnectDatabaseEmulator : ip.connectDatabaseEmulator
) as typeof ip.connectDatabaseEmulator;

// ── Low-hanging-fruit exports (issue #149) ────────────────────────────────
// Served mode is always sandbox-backed (never a prod handle), and these are
// honest no-ops in the sandbox model regardless of the worker/in-page split,
// so they are unconditional no-ops here — no worker RPC needed. This also
// gives served apps import-time parity for the `firebase/database` surface.
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

function unsupportedWorkerApi(name: string): never {
  throw new Error(
    `firebase/database ${name}() is not supported over the pyric SharedWorker yet. ` +
      'Use the in-page fallback for this operation.',
  );
}

export const runTransaction = (
  useWorker ? (() => unsupportedWorkerApi('runTransaction')) : ip.runTransaction
) as typeof ip.runTransaction;

export const query = (
  useWorker ? (() => unsupportedWorkerApi('query')) : ip.query
) as typeof ip.query;
export const orderByChild = (
  useWorker ? (() => unsupportedWorkerApi('orderByChild')) : ip.orderByChild
) as typeof ip.orderByChild;
export const orderByKey = (
  useWorker ? (() => unsupportedWorkerApi('orderByKey')) : ip.orderByKey
) as typeof ip.orderByKey;
export const orderByValue = (
  useWorker ? (() => unsupportedWorkerApi('orderByValue')) : ip.orderByValue
) as typeof ip.orderByValue;
export const startAt = (
  useWorker ? (() => unsupportedWorkerApi('startAt')) : ip.startAt
) as typeof ip.startAt;
export const startAfter = (
  useWorker ? (() => unsupportedWorkerApi('startAfter')) : ip.startAfter
) as typeof ip.startAfter;
export const endAt = (
  useWorker ? (() => unsupportedWorkerApi('endAt')) : ip.endAt
) as typeof ip.endAt;
export const endBefore = (
  useWorker ? (() => unsupportedWorkerApi('endBefore')) : ip.endBefore
) as typeof ip.endBefore;
export const equalTo = (
  useWorker ? (() => unsupportedWorkerApi('equalTo')) : ip.equalTo
) as typeof ip.equalTo;
export const limitToFirst = (
  useWorker ? (() => unsupportedWorkerApi('limitToFirst')) : ip.limitToFirst
) as typeof ip.limitToFirst;
export const limitToLast = (
  useWorker ? (() => unsupportedWorkerApi('limitToLast')) : ip.limitToLast
) as typeof ip.limitToLast;
