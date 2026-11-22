/**
 * Worker client bundle loading (`loadBundle`, `namedQuery`), SSR snapshot
 * hydration (`documentSnapshotFromJSON`, `querySnapshotFromJSON`,
 * `onSnapshotResume`), and `clearIndexedDbPersistence` lifecycle guards.
 */
import { FirebaseError } from 'pyric/app';
import {
  LoadBundleTask,
  assertBundleInputSupported,
  assertBundleMatchesDatabase,
  decodeBundleBytes,
  documentId,
  parseValidatedSnapshotEnvelope,
  readBundleSourceBytes,
  wrapInitialCachedSnapshotArgs,
  type BundledFilterSpec,
  type BundledQuerySourceSpec,
  type LoadBundleTaskProgress,
} from 'pyric/firestore/internal';
import { DOC_VALUE_ENCODING, encodeDocValue } from 'pyric/firestore/internal/value-codec';
import { serializeDocData } from '../protocol.js';
import { nextId } from './core.js';
import { clientDatabaseIdOf, firestoreControlRpc } from './firestore-database.js';
import { recordWorkerOnlineDoc } from './firestore-network.js';
import {
  assertWorkerClientDb,
  assertWorkerFirestoreActive,
  isWorkerDbStartedAndRunning,
  markWorkerHandleStarted,
} from './firestore-lifecycle.js';
import { onSnapshot } from './firestore-reads.js';
import { and, collection, collectionGroup, doc, limit, limitToLast, or, orderBy, query, where, type QueryConstraintHandle } from './firestore-refs.js';
import type { ClientDb, CollRefHandle, QueryHandle, Unsubscribe } from './handles.js';
import { makeDocSnapshot, makeQuerySnapshot, type ClientDocSnapshot, type ClientQuerySnapshot, type RawDocResult } from './snapshots.js';

const workerNamedQueries = new WeakMap<object, Map<string, Map<string, CollRefHandle | QueryHandle>>>();

function namedQueryMapFor(db: ClientDb, create: boolean): Map<string, CollRefHandle | QueryHandle> | undefined {
  const dbKey = clientDatabaseIdOf(db) ?? '(default)';
  let byDb = workerNamedQueries.get(db.port);
  if (byDb === undefined) {
    if (!create) return undefined;
    byDb = new Map();
    workerNamedQueries.set(db.port, byDb);
  }
  let qMap = byDb.get(dbKey);
  if (qMap === undefined && create) {
    qMap = new Map();
    byDb.set(dbKey, qMap);
  }
  return qMap;
}

function buildWorkerFilter(spec: BundledFilterSpec): QueryConstraintHandle {
  if (spec.kind === 'where') {
    if (spec.fieldPath === '__name__') return where(documentId(), spec.op, spec.value);
    return where(spec.fieldPath, spec.op, spec.value);
  }
  const children = spec.filters.map(buildWorkerFilter);
  if (spec.kind === 'or') return or(...children);
  return and(...children);
}

function buildWorkerQuery(db: ClientDb, entry: BundledQuerySourceSpec): CollRefHandle | QueryHandle {
  let base: CollRefHandle | QueryHandle;
  if (entry.isCollectionGroup) base = collectionGroup(db, entry.collectionPath);
  else base = collection(db, entry.collectionPath);
  const constraints: QueryConstraintHandle[] = [];
  for (const f of entry.filters) constraints.push(buildWorkerFilter(f));
  for (const o of entry.orders) {
    if (o.fieldPath === '__name__') constraints.push(orderBy(documentId(), o.direction));
    else constraints.push(orderBy(o.fieldPath, o.direction));
  }
  if (typeof entry.limitCount === 'number') {
    if (entry.limitType === 'LAST') constraints.push(limitToLast(entry.limitCount));
    else constraints.push(limit(entry.limitCount));
  }
  if (constraints.length === 0) return base;
  return query(base, ...constraints);
}

function toRawDocResult(docPath: string, data: Record<string, unknown>): RawDocResult {
  const parts = docPath.split('/');
  const id = parts[parts.length - 1] ?? docPath;
  return { id, path: docPath, exists: true, data: serializeDocData(data) };
}

export function clearIndexedDbPersistence(db: ClientDb): Promise<void> {
  assertWorkerClientDb(db, 'clearIndexedDbPersistence');
  if (isWorkerDbStartedAndRunning(db)) {
    throw new FirebaseError(
      'failed-precondition',
      'Persistence can only be cleared before a Firestore instance is initialized or after it is terminated.',
    );
  }
  return Promise.resolve();
}

export function loadBundle(
  db: ClientDb,
  bundleData: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
): LoadBundleTask {
  assertWorkerClientDb(db, 'loadBundle');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  assertBundleInputSupported(bundleData);
  const validatedData = bundleData;
  const dbId = clientDatabaseIdOf(db);
  const expectedDb = dbId ?? '(default)';
  return new LoadBundleTask(async (emit, complete, notifyError) => {
    await Promise.resolve();
    try {
      const parsed = decodeBundleBytes(await readBundleSourceBytes(validatedData));
      assertBundleMatchesDatabase(parsed, expectedDb);
      emit({ taskState: 'Running', documentsLoaded: 0, totalDocuments: parsed.totalDocuments, bytesLoaded: 0, totalBytes: parsed.totalBytes });
      const qMap = namedQueryMapFor(db, true)!;
      for (const nq of parsed.namedQueries) qMap.set(nq.name, buildWorkerQuery(db, nq));
      for (let i = 0; i < parsed.documents.length; i += 1) {
        const entry = parsed.documents[i];
        if (entry === undefined) continue;
        if (entry.exists && entry.data !== undefined) {
          await firestoreControlRpc(db, { t: 'op', id: nextId(), method: 'setDoc', actAs: { mode: 'admin' }, path: entry.docPath, data: encodeDocValue(entry.data), valueEncoding: DOC_VALUE_ENCODING });
          recordWorkerOnlineDoc(db.port, entry.docPath, true, serializeDocData(entry.data), dbId);
        } else {
          await firestoreControlRpc(db, { t: 'op', id: nextId(), method: 'deleteDoc', actAs: { mode: 'admin' }, path: entry.docPath });
          recordWorkerOnlineDoc(db.port, entry.docPath, false, undefined, dbId);
        }
        emit({ taskState: 'Running', documentsLoaded: i + 1, totalDocuments: parsed.totalDocuments, bytesLoaded: entry.bytesLoadedAfterDoc, totalBytes: parsed.totalBytes });
      }
      const done: LoadBundleTaskProgress = { taskState: 'Success', documentsLoaded: parsed.totalDocuments, totalDocuments: parsed.totalDocuments, bytesLoaded: parsed.totalBytes, totalBytes: parsed.totalBytes };
      emit(done);
      complete();
      return done;
    } catch (rawErr) {
      let errObj: Error = new Error(String(rawErr));
      if (rawErr instanceof Error) errObj = rawErr;
      notifyError(errObj);
      throw errObj;
    }
  });
}

export async function namedQuery(db: ClientDb, name: string): Promise<CollRefHandle | QueryHandle | null> {
  assertWorkerClientDb(db, 'namedQuery');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  return namedQueryMapFor(db, false)?.get(name) ?? null;
}

export function documentSnapshotFromJSON(db: ClientDb, json: object): ClientDocSnapshot {
  assertWorkerClientDb(db, 'documentSnapshotFromJSON');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const env = parseValidatedSnapshotEnvelope(json, 'document');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  const dbId = clientDatabaseIdOf(db);
  assertBundleMatchesDatabase(parsed, dbId ?? '(default)');
  const first = parsed.documents[0];
  if (first === undefined || !first.exists || first.data === undefined) {
    throw new Error('Bundled document snapshot contains no existing document.');
  }
  return makeDocSnapshot(toRawDocResult(first.docPath, first.data), db.port, undefined, undefined, db, dbId);
}

export function querySnapshotFromJSON(db: ClientDb, json: object): ClientQuerySnapshot {
  assertWorkerClientDb(db, 'querySnapshotFromJSON');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const env = parseValidatedSnapshotEnvelope(json, 'query');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  const dbId = clientDatabaseIdOf(db);
  assertBundleMatchesDatabase(parsed, dbId ?? '(default)');
  const rawDocs = parsed.documents.filter((d) => d.exists && d.data !== undefined).map((d) => toRawDocResult(d.docPath, d.data as Record<string, unknown>));
  const qsnap = makeQuerySnapshot({ docs: rawDocs }, db.port, null, undefined, undefined, undefined, db, dbId);
  Object.defineProperty(qsnap, 'toJSON', { value: () => env, configurable: true, writable: true });
  return qsnap;
}

export function onSnapshotResume(db: ClientDb, snapshotJson: object, ...args: unknown[]): Unsubscribe {
  assertWorkerClientDb(db, 'onSnapshotResume');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  const env = parseValidatedSnapshotEnvelope(snapshotJson, 'any');
  const { wrapped, onError } = wrapInitialCachedSnapshotArgs(args);
  let cancelled = false;
  let innerUnsub: Unsubscribe | undefined;
  void (async () => {
    try {
      if (env.bundle.length > 0) await loadBundle(db, env.bundle);
      if (cancelled) return;
      if (env.bundleSource === 'DocumentSnapshot') {
        innerUnsub = (onSnapshot as (...a: unknown[]) => Unsubscribe)(doc(db, env.bundleName), ...wrapped);
        return;
      }
      const hydrated = await namedQuery(db, env.bundleName);
      if (cancelled) return;
      if (hydrated === null) throw new FirebaseError('invalid-argument', `Named query '${env.bundleName}' not found in snapshot bundle.`);
      innerUnsub = (onSnapshot as (...a: unknown[]) => Unsubscribe)(hydrated, ...wrapped);
    } catch (err) {
      if (!cancelled && onError !== undefined) onError(err);
    }
  })();
  return () => { cancelled = true; innerUnsub?.(); };
}
