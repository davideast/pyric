/**
 * Recognised Firestore and Realtime Database SDK operations, batch/transaction
 * methods, and `onDisconnect` methods, plus call-name helpers.
 */
import ts from 'typescript';

export interface OpSpec {
  op: string;
  /** Index of the written value, if any. */
  data?: number;
  /** Index of an options argument (`setDoc(ref, data, { merge })`). */
  options?: number;
  /** `get` that becomes `query` for collection refs and queries. */
  readKind?: boolean;
  listen?: boolean;
  /** Segment appended to the ref (`addDoc`, `push`). */
  append?: string;
  /** Minimum argument count for the call to be a write (`push(ref)` alone only makes a key). */
  minArgs?: number;
}

/** One recognised SDK operation call and how to re-evaluate it. */
export interface OpCall {
  call: ts.CallExpression;
  service: import('./types.js').AccessService;
  spec: OpSpec;
  via?: 'batch' | 'transaction';
  /** For `onDisconnect(ref).set(...)`: the receiver whose value carries the ref. */
  disconnectReceiver?: ts.Expression;
}

export const FIRESTORE_OPS: Record<string, OpSpec> = {
  setDoc: { op: 'setDoc', data: 1, options: 2 },
  addDoc: { op: 'addDoc', data: 1, append: 'autoId' },
  updateDoc: { op: 'updateDoc', data: 1 },
  deleteDoc: { op: 'deleteDoc' },
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
};

export const RTDB_OPS: Record<string, OpSpec> = {
  set: { op: 'set', data: 1 },
  setWithPriority: { op: 'set', data: 1 },
  update: { op: 'update', data: 1 },
  remove: { op: 'remove' },
  push: { op: 'push', data: 1, append: 'pushId', minArgs: 2 },
  setPriority: { op: 'setPriority' },
  runTransaction: { op: 'transaction' },
  get: { op: 'get', readKind: true },
  onValue: { op: 'get', readKind: true, listen: true },
  onChildAdded: { op: 'get', readKind: true, listen: true },
  onChildChanged: { op: 'get', readKind: true, listen: true },
  onChildRemoved: { op: 'get', readKind: true, listen: true },
  onChildMoved: { op: 'get', readKind: true, listen: true },
};

export const BATCH_METHODS: Record<string, OpSpec> = {
  set: { op: 'setDoc', data: 1, options: 2 },
  update: { op: 'updateDoc', data: 1 },
  delete: { op: 'deleteDoc' },
};

export const TX_METHODS: Record<string, OpSpec> = {
  ...BATCH_METHODS,
  get: { op: 'get', readKind: true },
};

export const DISCONNECT_METHODS: Record<string, OpSpec> = {
  set: { op: 'onDisconnect.set', data: 0 },
  setWithPriority: { op: 'onDisconnect.set', data: 0 },
  update: { op: 'onDisconnect.update', data: 0 },
  remove: { op: 'onDisconnect.remove' },
};

export const CONSTRUCTIONS: Record<string, Set<string>> = {
  firestore: new Set(['doc', 'collection', 'collectionGroup', 'query']),
  rtdb: new Set(['ref', 'child', 'query', 'push']),
};

export const API_NAMES = new Set([
  ...Object.keys(FIRESTORE_OPS),
  ...Object.keys(RTDB_OPS),
  ...CONSTRUCTIONS.firestore,
  ...CONSTRUCTIONS.rtdb,
]);

export const METHOD_NAMES = new Set([
  ...Object.keys(TX_METHODS),
  ...Object.keys(DISCONNECT_METHODS),
]);

/** Evaluation steps allowed per call site before its trace stops as `unknown`. */
export const STEP_BUDGET = 100_000;

const WRITE_OPS = new Set([
  'set',
  'update',
  'remove',
  'push',
  'transaction',
  'setPriority',
  'onDisconnect.set',
  'onDisconnect.update',
  'onDisconnect.remove',
  'setDoc',
  'addDoc',
  'updateDoc',
  'deleteDoc',
]);

export function isWriteOp(op: string): boolean {
  return WRITE_OPS.has(op);
}

export function isDocWrite(op: string): boolean {
  return op === 'setDoc' || op === 'updateDoc' || op === 'deleteDoc';
}

export function txMethodSpecs(name: 'set' | 'update' | 'delete' | 'get'): { firestore: OpSpec; rtdb: OpSpec } {
  if (name === 'set') return { firestore: FIRESTORE_OPS.setDoc, rtdb: RTDB_OPS.set };
  if (name === 'update') return { firestore: FIRESTORE_OPS.updateDoc, rtdb: RTDB_OPS.update };
  if (name === 'delete') return { firestore: FIRESTORE_OPS.deleteDoc, rtdb: RTDB_OPS.remove };
  return { firestore: FIRESTORE_OPS.getDoc, rtdb: RTDB_OPS.get };
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}
