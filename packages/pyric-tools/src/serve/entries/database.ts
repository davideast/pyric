/**
 * The bundle the import map serves for `firebase/database`.
 *
 * The SharedWorker client already carries the RTDB data-plane used by Studio
 * and the Playground. This entry gives served apps the same common modular SDK
 * surface while the in-page fallback delegates to `pyric/database`.
 */
import * as ip from 'pyric/database/modular';
import { getDatabase as pyricGetDatabase } from 'pyric/database/modular';
import {
  rtdbChild,
  rtdbConnectDatabaseEmulator,
  rtdbGet,
  rtdbGetDatabase,
  rtdbOff,
  rtdbOnValue,
  rtdbPush,
  rtdbRef,
  rtdbRemove,
  rtdbServerTimestamp,
  rtdbSet,
  rtdbUpdate,
} from '../worker/client.js';
import { sandbox, workerDb, useWorker } from './runtime.js';

export const getDatabase = (
  useWorker
    ? (_app?: unknown) => rtdbGetDatabase(workerDb!)
    : (target?: Parameters<typeof pyricGetDatabase>[0]) =>
        pyricGetDatabase((target ?? sandbox) as never)
) as typeof pyricGetDatabase;

export const ref = (useWorker ? rtdbRef : ip.ref) as typeof ip.ref;
export const child = (useWorker ? rtdbChild : ip.child) as typeof ip.child;
export const get = (useWorker ? rtdbGet : ip.get) as typeof ip.get;
export const set = (useWorker ? rtdbSet : ip.set) as typeof ip.set;
export const update = (useWorker ? rtdbUpdate : ip.update) as typeof ip.update;
export const remove = (useWorker ? rtdbRemove : ip.remove) as typeof ip.remove;
export const push = (useWorker ? rtdbPush : ip.push) as typeof ip.push;
export const onValue = (useWorker ? rtdbOnValue : ip.onValue) as typeof ip.onValue;
export const off = (useWorker ? rtdbOff : ip.off) as typeof ip.off;
export const serverTimestamp = (
  useWorker ? rtdbServerTimestamp : ip.serverTimestamp
) as typeof ip.serverTimestamp;
export const connectDatabaseEmulator = (
  useWorker ? rtdbConnectDatabaseEmulator : ip.connectDatabaseEmulator
) as typeof ip.connectDatabaseEmulator;

// Connection / transport / logging management has no meaning for a
// served app either way — there is no live socket in worker mode or
// in-page mode. Unconditional no-ops, no worker RPC needed.
export const goOffline = ((_db?: unknown) => {}) as typeof ip.goOffline;
export const goOnline = ((_db?: unknown) => {}) as typeof ip.goOnline;
export const forceLongPolling = (() => {}) as typeof ip.forceLongPolling;
export const forceWebSockets = (() => {}) as typeof ip.forceWebSockets;
export const enableLogging = ((_logger?: unknown, _persistent?: unknown) => {}) as typeof ip.enableLogging;

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
