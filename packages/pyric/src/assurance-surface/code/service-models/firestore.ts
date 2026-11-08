/**
 * Declarative SDK service model for modular Cloud Firestore
 * (`firebase/firestore`, `firebase/firestore/lite`, and `pyric/firestore`).
 */
import type { OpSpec, SdkServiceModel } from './types.js';

const BATCH_METHODS: Readonly<Record<string, OpSpec>> = {
  set: {
    op: 'setDoc',
    write: true,
    data: 1,
    options: 2,
    via: 'batch',
    expectedRefKind: 'doc',
  },
  update: {
    op: 'updateDoc',
    write: true,
    data: 1,
    via: 'batch',
    expectedRefKind: 'doc',
    variadicFieldPairs: true,
  },
  delete: {
    op: 'deleteDoc',
    write: true,
    via: 'batch',
    expectedRefKind: 'doc',
  },
};

const TRANSACTION_METHODS: Readonly<Record<string, OpSpec>> = {
  set: {
    op: 'setDoc',
    write: true,
    data: 1,
    options: 2,
    via: 'transaction',
    expectedRefKind: 'doc',
  },
  update: {
    op: 'updateDoc',
    write: true,
    data: 1,
    via: 'transaction',
    expectedRefKind: 'doc',
    variadicFieldPairs: true,
  },
  delete: {
    op: 'deleteDoc',
    write: true,
    via: 'transaction',
    expectedRefKind: 'doc',
  },
  get: {
    op: 'get',
    readKind: true,
    via: 'transaction',
  },
};

export const FIRESTORE_SERVICE_MODEL: SdkServiceModel = {
  service: 'firestore',
  modules: [
    'firebase/firestore',
    'firebase/firestore/lite',
    '@firebase/firestore',
    '@firebase/firestore/lite',
    'pyric/firestore',
    'pyric/firestore/lite',
    'firebase-admin/firestore',
    'pyric-admin/firestore',
  ],
  adminModules: ['firebase-admin/firestore', 'pyric-admin/firestore'],
  handleFactories: {
    getFirestore: { resourceArgIndex: 1, singleStringArgIsResource: true },
    getAdminFirestore: { resourceArgIndex: 1, singleStringArgIsResource: true },
    initializeFirestore: { resourceArgIndex: 2 },
  },
  refConstructors: {
    collection: { refKind: 'collection' },
    doc: { refKind: 'doc', singleArgAppendHole: 'autoId' },
    collectionGroup: { refKind: 'collectionGroup', mode: 'collectionGroup' },
    addDoc: { refKind: 'doc', pathArgsEnd: 1, appendHole: 'autoId', reportUnconsumed: false },
  },
  queryBuilder: 'query',
  constraints: {
    where: { kind: 'where', fieldArg: 0, opArg: 1, valueArg: 2 },
    orderBy: { kind: 'orderBy', fieldArg: 0, directionArg: 1, defaultDirection: 'asc' },
    limit: { kind: 'limit', valueArg: 0 },
    limitToLast: { kind: 'limitToLast', valueArg: 0 },
    startAt: { kind: 'startAt', valueArg: 0 },
    startAfter: { kind: 'startAfter', valueArg: 0 },
    endAt: { kind: 'endAt', valueArg: 0 },
    endBefore: { kind: 'endBefore', valueArg: 0 },
    and: { kind: 'and', composite: true },
    or: { kind: 'or', composite: true },
  },
  operations: {
    setDoc: { op: 'setDoc', write: true, data: 1, options: 2, expectedRefKind: 'doc' },
    addDoc: { op: 'addDoc', write: true, data: 1, append: 'autoId' },
    updateDoc: {
      op: 'updateDoc',
      write: true,
      data: 1,
      expectedRefKind: 'doc',
      variadicFieldPairs: true,
    },
    deleteDoc: { op: 'deleteDoc', write: true, expectedRefKind: 'doc' },
    getDoc: { op: 'get', readKind: true },
    getDocFromCache: { op: 'get', readKind: true },
    getDocFromServer: { op: 'get', readKind: true },
    getDocs: { op: 'query', readKind: true },
    getDocsFromCache: { op: 'query', readKind: true },
    getDocsFromServer: { op: 'query', readKind: true },
    getCountFromServer: { op: 'query', readKind: true },
    getAggregateFromServer: { op: 'query', readKind: true },
    getCount: { op: 'query', readKind: true },
    getAggregate: { op: 'query', readKind: true },
    onSnapshot: { op: 'get', readKind: true, listen: true },
  },
  receiverFactories: {
    writeBatch: { receiverKind: 'batch' },
  },
  callbackReceivers: {
    runTransaction: { 0: 'transaction' },
  },
  receiverMethods: {
    batch: BATCH_METHODS,
    transaction: TRANSACTION_METHODS,
  },
  fieldValues: {
    serverTimestamp: 'serverTimestamp',
    increment: 'increment',
    arrayUnion: 'arrayUnion',
    arrayRemove: 'arrayRemove',
    deleteField: 'deleteField',
    'FieldValue.serverTimestamp': 'serverTimestamp',
    'FieldValue.increment': 'increment',
    'FieldValue.arrayUnion': 'arrayUnion',
    'FieldValue.arrayRemove': 'arrayRemove',
    'FieldValue.delete': 'deleteField',
    'FieldValue.deleteField': 'deleteField',
  },
  specialStrings: {
    documentId: '__name__',
    'FieldPath.documentId': '__name__',
  },
  nestedFieldSeparator: '.',
  defaultRefKind: 'doc',
  queryBaseRefKind: 'collection',
};
