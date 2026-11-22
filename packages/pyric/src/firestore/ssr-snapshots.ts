/**
 * `pyric/firestore` -- SSR snapshot `toJSON()`, `documentSnapshotFromJSON`,
 * `querySnapshotFromJSON`, and `onSnapshotResume` matching `firebase/firestore@12.19.0`.
 */
import type { DocumentData } from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { assertBundleMatchesDatabase, buildModularQuery, loadBundle, namedQuery } from './bundles.js';
import { clientStateFor } from './client-state.js';
import type { ReferenceDecoder } from './internal/value-codec.js';
import { onSnapshot, type SnapshotListenOptions, type SnapshotObserver } from './listeners.js';
import { collection, doc } from './refs.js';
import { getSnapshotField, type SnapshotFieldPath } from './sandbox/admin-compat/field-path.js';
import { decodeBundleBytes, type BundledFilterSpec, type BundledQuerySourceSpec, type BundledWhereOp } from './sandbox/bundle-wire.js';
import { forEachDocument } from './sandbox/for-each-document.js';
import { normalizeFirestoreDatabaseId } from './sandbox/named-databases.js';
import type { QueryFilter, QueryScope } from './sandbox/query-execution.js';
import { computeDocumentChanges, createDocChanges, type QueryConstraintPlan } from './sandbox/snapshot-listeners.js';
import { encodeDocumentSnapshotJson, encodeQuerySnapshotJson, type SerializedSnapshotEnvelope } from './sandbox/ssr-bundle-encoder.js';
import { createSnapshotMetadata, type SnapshotMetadataInstance } from './snapshot-metadata.js';
import { applyConverterToDocSnap, recordQuerySnapshot, tagSnapshotRefs } from './snapshots.js';
import { finalizeSandboxData, finalizeSandboxValue, tag, targetOf, underlyingOf, type Target } from './state.js';
import { Firestore, type DocumentSnapshot, type Firestore as FirestoreHandle, type FirestoreDataConverter, type Query, type QueryDocumentSnapshot, type QuerySnapshot, type Unsubscribe } from './types.js';

export interface SnapshotOptions { readonly serverTimestamps?: 'estimate' | 'previous' | 'none'; }
export type ListenSource = 'default' | 'cache';

const HYDRATED_METADATA: SnapshotMetadataInstance = createSnapshotMetadata(false, false);

function projectIdOfTarget(target: Target): string {
  const appObj = target.app as { options?: { projectId?: unknown } } | undefined;
  const candidate = appObj?.options?.projectId;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return 'pyric';
}

function mapQueryFilter(f: QueryFilter): BundledFilterSpec {
  if (f.kind === 'where') return { kind: 'where', fieldPath: f.field, op: f.op as BundledWhereOp, value: f.value };
  return { kind: f.kind, filters: f.filters.map(mapQueryFilter) };
}

function extractQuerySourceSpec(queryObj: object): BundledQuerySourceSpec {
  const under = underlyingOf(queryObj) as { path?: unknown; snapshotScope?: () => QueryScope; snapshotConstraints?: () => QueryConstraintPlan };
  if (typeof under.snapshotScope === 'function' && typeof under.snapshotConstraints === 'function') {
    const scope = under.snapshotScope();
    const exec = under.snapshotConstraints().execution;
    let collectionPath = '';
    if (scope.kind === 'collection') collectionPath = scope.path;
    else collectionPath = scope.collectionId;
    let limitType: 'FIRST' | 'LAST' = 'FIRST';
    if (exec.limitFromEnd === true) limitType = 'LAST';
    return { collectionPath, isCollectionGroup: scope.kind === 'collection-group', filters: exec.filters.map(mapQueryFilter), orders: exec.orders.map((o) => ({ fieldPath: o.field, direction: o.direction })), limitCount: exec.limitCount, limitType };
  }
  let rawPath = '';
  if (typeof under.path === 'string') rawPath = under.path;
  return { collectionPath: rawPath, isCollectionGroup: false, filters: [], orders: [] };
}

export function buildDocSnapshotToJson(target: Target, path: string, existsFn: () => boolean, readDataFn: () => Record<string, unknown> | undefined): () => SerializedSnapshotEnvelope {
  return () => encodeDocumentSnapshotJson(projectIdOfTarget(target), path, existsFn(), readDataFn(), target.databaseId);
}

export function attachDocSnapshotToJson(snapshot: object, target: Target, path: string, existsFn: () => boolean, readDataFn: () => Record<string, unknown> | undefined): void {
  Object.defineProperty(snapshot, 'toJSON', { value: buildDocSnapshotToJson(target, path, existsFn, readDataFn), configurable: true, writable: true });
}

export function buildQuerySnapshotToJson(snapshot: { docs?: ReadonlyArray<{ ref?: { path?: string }; data?: () => unknown }> }, target: Target, queryObj: object): () => SerializedSnapshotEnvelope {
  return () => {
    const rawDocs = snapshot.docs ?? [];
    const docs = rawDocs.map((d) => ({ path: d.ref?.path ?? '', data: (d.data?.() as Record<string, unknown> | undefined) ?? {} }));
    return encodeQuerySnapshotJson(projectIdOfTarget(target), extractQuerySourceSpec(queryObj), docs, target.databaseId);
  };
}

export function attachQuerySnapshotToJson(snapshot: object, target: Target, queryObj: object): void {
  Object.defineProperty(snapshot, 'toJSON', { value: buildQuerySnapshotToJson(snapshot as { docs?: ReadonlyArray<{ ref?: { path?: string }; data?: () => unknown }> }, target, queryObj), configurable: true, writable: true });
}

export function parseValidatedSnapshotEnvelope(json: unknown, expectedKind: 'document' | 'query' | 'any'): SerializedSnapshotEnvelope {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new FirebaseError('invalid-argument', 'Snapshot JSON must be a serialized snapshot object.');
  const rec = json as Record<string, unknown>;
  const isDoc = rec.type === 'firestore/documentSnapshot/1.0' && rec.bundleSource === 'DocumentSnapshot';
  const isQuery = rec.type === 'firestore/querySnapshot/1.0' && rec.bundleSource === 'QuerySnapshot';
  if (expectedKind === 'document' && !isDoc) throw new FirebaseError('invalid-argument', 'Invalid DocumentSnapshot JSON envelope.');
  if (expectedKind === 'query' && !isQuery) throw new FirebaseError('invalid-argument', 'Invalid QuerySnapshot JSON envelope.');
  if (!isDoc && !isQuery) throw new FirebaseError('invalid-argument', 'Invalid Firestore snapshot JSON envelope.');
  if (typeof rec.bundle !== 'string' || typeof rec.bundleName !== 'string') throw new FirebaseError('invalid-argument', 'Malformed snapshot bundle fields.');
  return rec as unknown as SerializedSnapshotEnvelope;
}

function createHydratedReferenceDecoder(db: FirestoreHandle, target: Target): ReferenceDecoder {
  const projectId = projectIdOfTarget(target);
  const currentDb = normalizeFirestoreDatabaseId(target.databaseId);
  return {
    create(path: string, refDatabaseId?: string) {
      const normalizedRefDb = normalizeFirestoreDatabaseId(refDatabaseId);
      if (refDatabaseId !== undefined && normalizedRefDb !== currentDb) {
        console.warn(
          `@firebase/firestore: Firestore (12.19.0): A document reference to ${path} refers to a different database (${projectId}/${normalizedRefDb}), which is not supported. It will be treated as a reference in the current database (${projectId}/${currentDb}) instead.`,
        );
      }
      return doc(db, path);
    },
  };
}

function cloneHydratedValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(cloneHydratedValue);
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    Object.defineProperty(out, k, {
      value: cloneHydratedValue(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function buildHydratedDocSnapshot(
  db: FirestoreHandle,
  target: Target,
  docPath: string,
  data: Record<string, unknown>,
): QueryDocumentSnapshot & {
  readonly ref: import('./types.js').DocumentReference & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
} {
  const ref = doc(db, docPath);
  const references = createHydratedReferenceDecoder(db, target);
  const readData = (): DocumentData =>
    finalizeSandboxData(cloneHydratedValue(data) as DocumentData, references) as DocumentData;
  const readField = (fieldPath: SnapshotFieldPath): unknown => {
    try { return finalizeSandboxValue(getSnapshotField(readData(), fieldPath), references); } catch (err) {
      let reason = String(err);
      if (err instanceof Error) reason = err.message;
      throw new FirebaseError('invalid-argument', `Function DocumentSnapshot.get() called with invalid data. ${reason}`);
    }
  };
  const snap = { id: ref.id, ref, exists: () => true, metadata: HYDRATED_METADATA, data: readData, get: readField, toJSON: buildDocSnapshotToJson(target, docPath, () => true, readData) };
  tagSnapshotRefs(snap, target);
  return snap;
}

export function documentSnapshotFromJSON(
  db: FirestoreHandle,
  json: object,
): DocumentSnapshot & {
  readonly ref: import('./types.js').DocumentReference & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
};
export function documentSnapshotFromJSON<AppModelType, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter: FirestoreDataConverter<AppModelType, DbModelType>,
): DocumentSnapshot<AppModelType> & {
  readonly ref: import('./types.js').DocumentReference<AppModelType> & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
};
export function documentSnapshotFromJSON<AppModelType = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter?: FirestoreDataConverter<AppModelType, DocumentData>,
): DocumentSnapshot<AppModelType> & {
  readonly ref: import('./types.js').DocumentReference<AppModelType> & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
} {
  if (!(db instanceof Firestore)) throw new FirebaseError('invalid-argument', 'Expected first argument to documentSnapshotFromJSON() to be a Firestore instance.');
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  const env = parseValidatedSnapshotEnvelope(json, 'document');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  assertBundleMatchesDatabase(parsed, normalizeFirestoreDatabaseId(target.databaseId));
  const first = parsed.documents[0];
  if (first === undefined || !first.exists || first.data === undefined) throw new Error('Bundled document snapshot contains no existing document.');
  const untypedSnap = buildHydratedDocSnapshot(db, target, first.docPath, first.data);
  if (converter !== undefined) {
    return applyConverterToDocSnap(untypedSnap as unknown as Parameters<typeof applyConverterToDocSnap>[0], converter, target, 'document') as unknown as DocumentSnapshot<AppModelType> & {
      readonly ref: import('./types.js').DocumentReference<AppModelType> & { toJSON(): object };
      readonly metadata: SnapshotMetadataInstance;
    };
  }
  return untypedSnap as unknown as DocumentSnapshot<AppModelType> & {
    readonly ref: import('./types.js').DocumentReference<AppModelType> & { toJSON(): object };
    readonly metadata: SnapshotMetadataInstance;
  };
}

export function querySnapshotFromJSON(db: FirestoreHandle, json: object): QuerySnapshot;
export function querySnapshotFromJSON<AppModelType, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter: FirestoreDataConverter<AppModelType, DbModelType>,
): QuerySnapshot<AppModelType>;
export function querySnapshotFromJSON<AppModelType = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter?: FirestoreDataConverter<AppModelType, DocumentData>,
): QuerySnapshot<AppModelType> {
  if (!(db instanceof Firestore)) throw new FirebaseError('invalid-argument', 'Expected first argument to querySnapshotFromJSON() to be a Firestore instance.');
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  const env = parseValidatedSnapshotEnvelope(json, 'query');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  assertBundleMatchesDatabase(parsed, normalizeFirestoreDatabaseId(target.databaseId));
  const rawDocs = parsed.documents
    .filter((d) => d.exists && d.data !== undefined)
    .map((d) => buildHydratedDocSnapshot(db, target, d.docPath, d.data as Record<string, unknown>));
  let docs = rawDocs as unknown as Array<
    QueryDocumentSnapshot<AppModelType> & {
      readonly ref: import('./types.js').DocumentReference<AppModelType> & { toJSON(): object };
      readonly metadata: SnapshotMetadataInstance;
    }
  >;
  if (converter !== undefined) {
    docs = rawDocs.map((d) =>
      applyConverterToDocSnap(
        d as unknown as Parameters<typeof applyConverterToDocSnap>[0],
        converter,
        target,
        'query-child',
      ),
    ) as unknown as typeof docs;
  }
  const firstNamedQuery = parsed.namedQueries[0];
  let hydratedQuery: Query<AppModelType>;
  if (firstNamedQuery !== undefined) {
    const baseQuery = buildModularQuery(db, firstNamedQuery);
    if (converter !== undefined) {
      hydratedQuery = baseQuery.withConverter(converter);
    } else {
      hydratedQuery = baseQuery as Query<AppModelType>;
    }
  } else {
    const fallbackColl = collection(db, env.bundleName || '__hydrated__');
    if (converter !== undefined) {
      hydratedQuery = fallbackColl.withConverter(converter);
    } else {
      hydratedQuery = fallbackColl as Query<AppModelType>;
    }
  }
  const changes = computeDocumentChanges(undefined, docs.map((d) => ({ path: d.ref.path })), docs, () => false, () => docs[0] as typeof docs[number]);
  const rawQSnap = { query: hydratedQuery, size: docs.length, empty: docs.length === 0, docs, metadata: HYDRATED_METADATA, forEach: forEachDocument(docs), docChanges: createDocChanges(changes, false), toJSON: () => env };
  const qsnap: QuerySnapshot<AppModelType> = tag(rawQSnap, target);
  const rawRecordView = { docs: rawDocs, metadata: HYDRATED_METADATA, docChanges: () => changes };
  recordQuerySnapshot(qsnap, rawRecordView, target, hydratedQuery as object, 'listener');
  return qsnap;
}

function isPartialObserverArg(val: unknown): val is SnapshotObserver<unknown> {
  if (val === null || typeof val !== 'object') return false;
  const r = val as Record<string, unknown>;
  return typeof r.next === 'function' || typeof r.error === 'function' || typeof r.complete === 'function';
}

export function wrapInitialCachedSnapshotArgs(args: readonly unknown[]): { wrapped: unknown[]; onError?: (err: unknown) => void } {
  let firstDelivery = true;
  const stampInitial = <S>(snap: S): S => {
    if (firstDelivery && snap !== null && typeof snap === 'object') {
      firstDelivery = false;
      const hasPending = Boolean((snap as { metadata?: { hasPendingWrites?: unknown } }).metadata?.hasPendingWrites);
      Object.defineProperty(snap, 'metadata', { value: createSnapshotMetadata(true, hasPending), configurable: true });
    }
    return snap;
  };
  let handlerIdx = 0;
  if (args[0] !== null && typeof args[0] === 'object' && !isPartialObserverArg(args[0])) handlerIdx = 1;
  const out = [...args];
  const handler = out[handlerIdx];
  if (isPartialObserverArg(handler)) {
    const obs = handler;
    let onError: ((err: unknown) => void) | undefined;
    if (typeof obs.error === 'function') onError = obs.error.bind(obs);
    out[handlerIdx] = { ...obs, next: (snap: unknown) => { obs.next?.(stampInitial(snap)); } };
    return { wrapped: out, onError };
  }
  if (typeof handler === 'function') {
    const nextFn = handler as (snap: unknown) => void;
    out[handlerIdx] = (snap: unknown) => { nextFn(stampInitial(snap)); };
  }
  const errSlot = out[handlerIdx + 1];
  let onError: ((err: unknown) => void) | undefined;
  if (typeof errSlot === 'function') onError = errSlot as (err: unknown) => void;
  return { wrapped: out, onError };
}

export function onSnapshotResume(db: FirestoreHandle, snapshotJson: object, observerOrNext: SnapshotObserver<any> | ((snap: any) => void), error?: (err: Error) => void): Unsubscribe;
export function onSnapshotResume(db: FirestoreHandle, snapshotJson: object, options: SnapshotListenOptions, observerOrNext: SnapshotObserver<any> | ((snap: any) => void), error?: (err: Error) => void): Unsubscribe;
export function onSnapshotResume(db: FirestoreHandle, snapshotJson: object, ...args: unknown[]): Unsubscribe {
  if (!(db instanceof Firestore)) throw new FirebaseError('invalid-argument', 'Expected first argument to onSnapshotResume() to be a Firestore instance.');
  const target = targetOf(db);
  clientStateFor(target).markStarted();
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
      const hydratedQuery = await namedQuery(db, env.bundleName);
      if (cancelled) return;
      if (hydratedQuery === null) throw new FirebaseError('invalid-argument', `Named query '${env.bundleName}' not found in snapshot bundle.`);
      innerUnsub = (onSnapshot as (...a: unknown[]) => Unsubscribe)(hydratedQuery, ...wrapped);
    } catch (err) {
      if (!cancelled && onError !== undefined) onError(err);
    }
  })();
  return () => { cancelled = true; innerUnsub?.(); };
}
