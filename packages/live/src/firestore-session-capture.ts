/**
 * What a Firestore client-SDK call adds to the live host's session data: the
 * bounded copies (`firestore-session-values.ts`) of what a successful call
 * observed, as one `ObservedSessionDelta` per call.
 *
 * - A write (`setDoc`, `updateDoc`, `deleteDoc`) names its op in its
 *   context; an `addDoc` holds its fields until it resolves with the new
 *   document's path.
 * - A document read sets the document, or deletes it when it is missing; a
 *   query read sets each document it returned, at most 250 and 512 KiB
 *   together, counting the rest `truncated`.
 * - A listener delivery does the same from its snapshot, reading a query
 *   snapshot's `docChanges()` so a document leaving the query's results is
 *   never taken for a deletion.
 * - A `writeBatch` commit carries each op its `set`, `update` and `delete`
 *   named, under the same per-delta bounds.
 *
 * A reference, query or snapshot with a converter (`withConverter`) and a
 * `runTransaction` are counted `unsupported`, never read: their data is the
 * app's model, and reading it would run the app's code.
 */
import type { CallContext, ObservedSite, ResultReading } from './observe.js';
import { hasConverter, isObject, pathOf } from './firestore.js';
import { firestoreJsonFields } from './firestore-colliding-maps.js';
import {
  isValidDocPath,
  normalizeDocPath,
  sessionDocFields,
  sessionSetDocOp,
  sessionUpdateDocOp,
  sessionWriteFields,
  type SessionCopyResult,
} from './firestore-session-values.js';
import { MAX_SESSION_DELTA_BYTES, MAX_SESSION_ITEM_BYTES, type SessionBudget } from './session-budget.js';
import {
  sessionDeltaOf,
  skipCountsOf,
  skipDeltaOf,
  type ObservedFirestoreSessionOp,
  type ObservedSessionDelta,
} from './session-data.js';

/** The most documents one delta sets. */
const MAX_SESSION_DOCS = 250;

const DOCUMENT_READS: ReadonlySet<string> = new Set(['getDoc', 'getDocFromServer']);
const SESSION_DOCUMENT_READS: ReadonlySet<string> = new Set(['getDoc', 'getDocFromServer', 'getDocFromCache']);
const SESSION_QUERY_READS: ReadonlySet<string> = new Set(['getDocs', 'getDocsFromServer', 'getDocsFromCache']);
const CONVERTED_WRITES: ReadonlySet<string> = new Set(['deleteDoc', 'setDoc', 'updateDoc', 'addDoc']);

/** A delta of one op. */
export function opDelta(op: ObservedFirestoreSessionOp): ObservedSessionDelta {
  return { firestore: [op] };
}

/** A delta of one copied op, or the skip that left it out. */
export function copiedOpDelta(op: SessionCopyResult<ObservedFirestoreSessionOp>): ObservedSessionDelta {
  if (op.ok) return opDelta(op.value);
  return skipDeltaOf(op.reason);
}

/**
 * The session part of a write's context: its op, the skip that left it out,
 * or, for an `addDoc`, the fields awaiting the new document's path.
 */
export function firestoreWriteSession(
  name: string,
  args: readonly unknown[],
  path: string | undefined,
): Pick<CallContext, 'sessionData' | 'pendingAddDocFields'> {
  if (name === 'runTransaction') return { sessionData: skipDeltaOf('unsupported') };
  if (hasConverter(args[0])) {
    if (CONVERTED_WRITES.has(name)) return { sessionData: skipDeltaOf('unsupported') };
    return {};
  }
  if (name === 'deleteDoc') {
    if (!isValidDocPath(path)) return { sessionData: skipDeltaOf('unsupported') };
    return { sessionData: opDelta({ kind: 'delete', path: normalizeDocPath(path) }) };
  }
  if (name === 'setDoc') {
    if (path === undefined) return { sessionData: skipDeltaOf('unsupported') };
    return { sessionData: copiedOpDelta(sessionSetDocOp(path, args[1], args[2])) };
  }
  if (name === 'updateDoc') {
    if (path === undefined) return { sessionData: skipDeltaOf('unsupported') };
    return { sessionData: copiedOpDelta(sessionUpdateDocOp(path, args.slice(1))) };
  }
  if (name === 'addDoc') {
    const fields = sessionWriteFields(args[1]);
    if (fields.ok) return { pendingAddDocFields: fields.value };
    return { sessionData: skipDeltaOf(fields.reason) };
  }
  return {};
}

function hasSnapshotConverter(snap: object): boolean {
  const conv: unknown = Reflect.get(snap, '_converter');
  return conv !== undefined && conv !== null;
}

/** Whether a snapshot came from local cache or carries unconfirmed local writes. */
function hasUnconfirmedMetadata(snap: object): boolean {
  const meta: unknown = Reflect.get(snap, 'metadata');
  if (!isObject(meta)) return false;
  return Reflect.get(meta, 'fromCache') === true || Reflect.get(meta, 'hasPendingWrites') === true;
}

/** A document snapshot's path, from its `ref`, else the call's own path. */
function docSnapPath(snap: object, fallbackPath?: string): string | undefined {
  const ref: unknown = Reflect.get(snap, 'ref');
  if (isObject(ref)) {
    const fromRef: unknown = Reflect.get(ref, 'path');
    if (typeof fromRef === 'string' && isValidDocPath(fromRef)) return normalizeDocPath(fromRef);
  }
  if (isValidDocPath(fallbackPath)) return normalizeDocPath(fallbackPath);
  return undefined;
}

/**
 * The ops of one delta under its bounds: at most 250 documents and 512 KiB
 * of values together. A document cut off by what the delta has left, and
 * every document after it, counts `truncated`.
 */
export class DeltaOps {
  readonly ops: ObservedFirestoreSessionOp[] = [];
  private readonly budget: SessionBudget = { left: MAX_SESSION_DELTA_BYTES };
  private oversized = 0;
  private unsupported = 0;
  private truncated = 0;
  private isCutOff = false;

  /** Whether the delta takes no more documents; counts the one refused. */
  refusesMore(): boolean {
    const isFull = this.isCutOff || this.ops.length >= MAX_SESSION_DOCS || this.budget.left <= 0;
    if (isFull) {
      this.truncated += 1;
      this.isCutOff = true;
    }
    return isFull;
  }

  /** Copies one op with what the delta has left; false once the delta is cut off. */
  add(copy: (budget: SessionBudget) => SessionCopyResult<ObservedFirestoreSessionOp>): boolean {
    const cap = Math.min(MAX_SESSION_ITEM_BYTES, this.budget.left);
    const itemBudget: SessionBudget = { left: cap };
    const op = copy(itemBudget);
    this.budget.left -= Math.max(0, cap - Math.max(0, itemBudget.left));
    if (op.ok) {
      this.ops.push(op.value);
      return true;
    }
    if (op.reason === 'oversized' && cap < MAX_SESSION_ITEM_BYTES) {
      this.truncated += 1;
      this.isCutOff = true;
      return false;
    }
    this.skip(op.reason);
    return true;
  }

  /** Counts one document left out. */
  skip(reason: 'oversized' | 'unsupported'): void {
    if (reason === 'oversized') this.oversized += 1;
    else this.unsupported += 1;
  }

  delta(): ObservedSessionDelta | undefined {
    return sessionDeltaOf({ firestore: [...this.ops], skipped: skipCountsOf(this.oversized, this.unsupported, this.truncated) });
  }
}

export interface QueryDocumentChange {
  readonly kind: 'upsert' | 'removed';
  readonly doc: unknown;
}

/** Sets one query document into the delta; false once the delta is cut off. */
function addQueryDocument(ops: DeltaOps, docSnap: unknown): boolean {
  if (!isObject(docSnap) || hasSnapshotConverter(docSnap)) {
    ops.skip('unsupported');
    return true;
  }
  const path = docSnapPath(docSnap);
  if (hasUnconfirmedMetadata(docSnap)) {
    if (path !== undefined) {
      return ops.add(() => ({ ok: true, value: { kind: 'invalidate', path } }));
    }
    return true;
  }
  const dataFn: unknown = Reflect.get(docSnap, 'data');
  if (typeof dataFn !== 'function' || path === undefined) {
    ops.skip('unsupported');
    return true;
  }
  return ops.add((budget) => {
    const fields = sessionDocFields(Reflect.apply(dataFn, docSnap, []), budget);
    if (!fields.ok) return fields;
    return { ok: true, value: { kind: 'set', path, data: fields.value } };
  });
}

function addRemovedQueryDocument(ops: DeltaOps, docSnap: unknown): boolean {
  if (!isObject(docSnap)) {
    ops.skip('unsupported');
    return true;
  }
  const path = docSnapPath(docSnap);
  if (path === undefined) {
    ops.skip('unsupported');
    return true;
  }
  return ops.add(() => ({ ok: true, value: { kind: 'invalidate', path } }));
}

/** The document changes of a listener's query snapshot, or undefined when it has no `docChanges()`. */
export function querySnapshotChanges(snap: object): QueryDocumentChange[] | undefined {
  const docChangesFn: unknown = Reflect.get(snap, 'docChanges');
  if (typeof docChangesFn !== 'function') return undefined;
  const changes: unknown = Reflect.apply(docChangesFn, snap, []);
  if (!Array.isArray(changes)) return undefined;
  const items: QueryDocumentChange[] = [];
  for (const change of changes) {
    if (!isObject(change)) continue;
    const changeType: unknown = Reflect.get(change, 'type');
    if (changeType === 'added' || changeType === 'modified') {
      items.push({ kind: 'upsert', doc: Reflect.get(change, 'doc') });
    } else if (changeType === 'removed') {
      items.push({ kind: 'removed', doc: Reflect.get(change, 'doc') });
    }
  }
  return items;
}

/** The delta of a query snapshot: its changes for a listener, else its `docs`. */
function querySnapshotDelta(snap: object, useChanges: boolean): ObservedSessionDelta | undefined {
  if (hasSnapshotConverter(snap)) return skipDeltaOf('unsupported');
  let changes: ReturnType<typeof querySnapshotChanges>;
  if (useChanges) changes = querySnapshotChanges(snap);
  if (changes !== undefined) {
    const ops = new DeltaOps();
    for (const item of changes) {
      if (ops.refusesMore()) break;
      let keepGoing: boolean;
      if (item.kind === 'removed') {
        keepGoing = addRemovedQueryDocument(ops, item.doc);
      } else {
        keepGoing = addQueryDocument(ops, item.doc);
      }
      if (!keepGoing) break;
    }
    return ops.delta();
  }
  const documents: unknown = Reflect.get(snap, 'docs');
  if (!Array.isArray(documents)) return undefined;
  const ops = new DeltaOps();
  for (const docSnap of documents) {
    if (ops.refusesMore()) break;
    if (!addQueryDocument(ops, docSnap)) break;
  }
  return ops.delta();
}

/** The delta of a document snapshot at a known path: `set` of its fields, or `delete` when missing. */
function documentSnapshotDelta(docPath: string, exists: boolean, rawData: () => unknown): ObservedSessionDelta {
  if (!exists) return opDelta({ kind: 'delete', path: docPath });
  const fields = sessionDocFields(rawData());
  if (!fields.ok) return skipDeltaOf(fields.reason);
  return opDelta({ kind: 'set', path: docPath, data: fields.value });
}

/** An `addDoc`'s `set` op, once it resolved with the new document's reference. */
function addedDocumentDelta(site: ObservedSite, value: object): ObservedSessionDelta | undefined {
  const pending = site.pendingAddDocFields;
  if (pending === undefined) return undefined;
  const resolvedPath: unknown = Reflect.get(value, 'path');
  if (typeof resolvedPath !== 'string' || !isValidDocPath(resolvedPath)) return skipDeltaOf('unsupported');
  const op: {
    kind: 'set';
    path: string;
    data: Record<string, unknown>;
    deleteFields?: readonly string[];
    partial?: boolean;
  } = {
    kind: 'set',
    path: normalizeDocPath(resolvedPath),
    data: pending.data,
  };
  if (pending.deleteFields !== undefined) op.deleteFields = pending.deleteFields;
  if (pending.partial === true) op.partial = true;
  return opDelta(op);
}

/** A resolved document read's reading: the rule-evidence document a plain read keeps, and its session delta. */
function documentReadResult(site: ObservedSite, value: object): ResultReading {
  if (hasSnapshotConverter(value)) return { sessionData: skipDeltaOf('unsupported') };
  const isUnconfirmedSessionRead = site.name === 'getDocFromCache' || hasUnconfirmedMetadata(value);
  const existsFn: unknown = Reflect.get(value, 'exists');
  let exists = true;
  if (typeof existsFn === 'function') exists = Reflect.apply(existsFn, value, []) === true;
  const docPath = docSnapPath(value, site.path);
  if (!exists) {
    if (isUnconfirmedSessionRead || docPath === undefined) return {};
    return { sessionData: opDelta({ kind: 'delete', path: docPath }) };
  }
  const dataFn: unknown = Reflect.get(value, 'data');
  if (typeof dataFn !== 'function') {
    if (isUnconfirmedSessionRead) return {};
    return { sessionData: skipDeltaOf('unsupported') };
  }
  const rawData: unknown = Reflect.apply(dataFn, value, []);
  const reading: { document?: Record<string, unknown>; sessionData?: ObservedSessionDelta } = {};
  if (DOCUMENT_READS.has(site.name)) {
    const document = firestoreJsonFields(rawData);
    if (document !== undefined) reading.document = document;
  }
  if (isUnconfirmedSessionRead) return reading;
  if (docPath === undefined) {
    reading.sessionData = skipDeltaOf('unsupported');
    return reading;
  }
  reading.sessionData = documentSnapshotDelta(docPath, true, () => rawData);
  return reading;
}

/**
 * What a resolved call adds to its record: for a plain document read, the
 * fields of the document it returned (`jsonFields`, the 64 KiB a host keeps
 * for its rules), or nothing for a missing document, one that is not plain
 * JSON or too large, or a reference with a converter. Also its bounded
 * `sessionData`: a document or query read's documents, or an `addDoc`'s new
 * document.
 */
export function firestoreResult(site: ObservedSite, value: unknown): ResultReading {
  if (hasConverter(site.subject)) {
    const readsData = site.name === 'addDoc' || SESSION_DOCUMENT_READS.has(site.name) || SESSION_QUERY_READS.has(site.name);
    if (readsData) return { sessionData: skipDeltaOf('unsupported') };
    return {};
  }
  if (!isObject(value)) return {};
  if (site.name === 'addDoc') {
    const sessionData = addedDocumentDelta(site, value);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (SESSION_DOCUMENT_READS.has(site.name)) return documentReadResult(site, value);
  if (SESSION_QUERY_READS.has(site.name)) {
    if (site.name === 'getDocsFromCache') return {};
    const sessionData = querySnapshotDelta(value, false);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  return {};
}

/**
 * Extracts bounded session-observed documents from a Firestore `onSnapshot` /
 * `onSnapshotResume` delivery (`DocumentSnapshot` or `QuerySnapshot`). Never
 * invokes user `withConverter` functions.
 */
export function firestoreDelivery(site: ObservedSite, value: unknown): ObservedSessionDelta | undefined {
  if (hasConverter(site.subject) || !isObject(value) || hasSnapshotConverter(value)) {
    return skipDeltaOf('unsupported');
  }
  const existsFn: unknown = Reflect.get(value, 'exists');
  const dataFn: unknown = Reflect.get(value, 'data');
  if (typeof existsFn === 'function' && typeof dataFn === 'function') {
    if (hasUnconfirmedMetadata(value)) return undefined;
    const docPath = docSnapPath(value, site.path);
    if (docPath === undefined) return skipDeltaOf('unsupported');
    const exists = Reflect.apply(existsFn, value, []) === true;
    return documentSnapshotDelta(docPath, exists, () => Reflect.apply(dataFn, value, []));
  }
  return querySnapshotDelta(value, true);
}

/** The op one batch `set`, `update` or `delete` names, copied with the budget the batch has left. */
function batchOp(
  name: 'set' | 'update' | 'delete',
  args: readonly unknown[],
  budget: SessionBudget,
): SessionCopyResult<ObservedFirestoreSessionOp> {
  try {
    const ref = args[0];
    if (hasConverter(ref)) return { ok: false, reason: 'unsupported' };
    const rawPath = pathOf(ref);
    if (!isValidDocPath(rawPath)) return { ok: false, reason: 'unsupported' };
    const path = normalizeDocPath(rawPath);
    if (name === 'delete') return { ok: true, value: { kind: 'delete', path } };
    if (name === 'set') return sessionSetDocOp(path, args[1], args[2], budget);
    return sessionUpdateDocOp(path, args.slice(1), budget);
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
}

/**
 * The session ops one `writeBatch` names, one per operation the SDK
 * accepted, under one delta's bounds. Its delta is read at each commit.
 */
export class BatchSession {
  private readonly ops = new DeltaOps();

  /** Copies the op one accepted batch operation names. */
  record(name: 'set' | 'update' | 'delete', args: readonly unknown[]): void {
    if (this.ops.refusesMore()) return;
    this.ops.add((budget) => batchOp(name, args, budget));
  }

  /** The delta the batch's commit carries so far, or undefined when it names nothing. */
  delta(): ObservedSessionDelta | undefined {
    return this.ops.delta();
  }
}

