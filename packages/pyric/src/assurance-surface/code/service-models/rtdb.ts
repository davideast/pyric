/**
 * Declarative SDK service model for modular Firebase Realtime Database
 * (`firebase/database` and `pyric/database`).
 */
import type { OpSpec, SdkServiceModel } from './types.js';

const DISCONNECT_METHODS: Readonly<Record<string, OpSpec>> = {
  set: { op: 'onDisconnect.set', write: true, data: 0, usesReceiverRef: true },
  setWithPriority: { op: 'onDisconnect.set', write: true, data: 0, usesReceiverRef: true },
  update: { op: 'onDisconnect.update', write: true, data: 0, usesReceiverRef: true },
  remove: { op: 'onDisconnect.remove', write: true, usesReceiverRef: true },
};

const TRANSACTION_METHODS: Readonly<Record<string, OpSpec>> = {
  set: { op: 'set', write: true, data: 1, via: 'transaction' },
  update: { op: 'update', write: true, data: 1, multiPathUpdate: true, via: 'transaction' },
  delete: { op: 'remove', write: true, via: 'transaction' },
  get: { op: 'get', readKind: true, via: 'transaction' },
};

export const RTDB_SERVICE_MODEL: SdkServiceModel = {
  service: 'rtdb',
  modules: [
    'firebase/database',
    '@firebase/database',
    'pyric/database',
    'firebase-admin/database',
    'pyric-admin/database',
  ],
  handleFactories: {
    getDatabase: { resourceArgIndex: 1, singleStringArgIsResource: true },
    getDatabaseWithUrl: { resourceArgIndex: 0 },
    getAdminDatabase: { resourceArgIndex: 1, singleStringArgIsResource: true },
  },
  refConstructors: {
    ref: { refKind: 'node' },
    child: { refKind: 'node' },
    refFromURL: { refKind: 'node', mode: 'url' },
    push: { refKind: 'node', pathArgsEnd: 1, appendHole: 'pushId', reportUnconsumed: false },
  },
  queryBuilder: 'query',
  constraints: {
    orderByChild: { kind: 'orderByChild', fieldArg: 0 },
    orderByKey: { kind: 'orderByKey' },
    orderByValue: { kind: 'orderByValue' },
    orderByPriority: { kind: 'orderByPriority' },
    equalTo: { kind: 'equalTo', valueArg: 0, fieldArg: 1 },
    startAt: { kind: 'startAt', valueArg: 0, fieldArg: 1 },
    startAfter: { kind: 'startAfter', valueArg: 0, fieldArg: 1 },
    endAt: { kind: 'endAt', valueArg: 0, fieldArg: 1 },
    endBefore: { kind: 'endBefore', valueArg: 0, fieldArg: 1 },
    limitToFirst: { kind: 'limitToFirst', valueArg: 0 },
    limitToLast: { kind: 'limitToLast', valueArg: 0 },
  },
  operations: {
    set: { op: 'set', write: true, data: 1 },
    setWithPriority: { op: 'set', write: true, data: 1 },
    update: { op: 'update', write: true, data: 1, multiPathUpdate: true },
    remove: { op: 'remove', write: true },
    push: { op: 'push', write: true, data: 1, append: 'pushId', minArgs: 2 },
    setPriority: { op: 'setPriority', write: true },
    runTransaction: { op: 'transaction', write: true },
    get: { op: 'get', readKind: true },
    onValue: { op: 'get', readKind: true, listen: true },
    onChildAdded: { op: 'get', readKind: true, listen: true },
    onChildChanged: { op: 'get', readKind: true, listen: true },
    onChildRemoved: { op: 'get', readKind: true, listen: true },
    onChildMoved: { op: 'get', readKind: true, listen: true },
  },
  receiverFactories: {
    onDisconnect: { receiverKind: 'onDisconnect', refArgIndex: 0 },
  },
  receiverMethods: {
    onDisconnect: DISCONNECT_METHODS,
    transaction: TRANSACTION_METHODS,
  },
  fieldValues: {
    serverTimestamp: 'serverTimestamp',
    increment: 'increment',
    'ServerValue.increment': 'increment',
  },
  nestedFieldSeparator: '/',
  defaultRefKind: 'node',
  queryBaseRefKind: 'node',
};
