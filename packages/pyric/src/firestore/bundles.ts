/**
 * `pyric/firestore` -- offline bundle loading (`loadBundle`, `LoadBundleTask`)
 * and `namedQuery` hydration matching `firebase/firestore@12.19.0`.
 */
import { getAdminFirestore as getChainableAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { clientStateFor } from './client-state.js';
import { documentId } from './field-values.js';
import {
  and,
  limit,
  limitToLast,
  or,
  orderBy,
  query,
  where,
  type QueryConstraint,
  type QueryFilterConstraint,
} from './query-constraints.js';
import { collection, collectionGroup } from './refs.js';
import {
  decodeBundleBytes,
  type BundledFilterSpec,
  type BundledQuerySourceSpec,
} from './sandbox/bundle-wire.js';
import { targetOf } from './state.js';
import { Firestore, type Firestore as FirestoreHandle, type Query } from './types.js';

export type TaskState = 'Error' | 'Running' | 'Success';

export interface LoadBundleTaskProgress {
  readonly documentsLoaded: number;
  readonly totalDocuments: number;
  readonly bytesLoaded: number;
  readonly totalBytes: number;
  readonly taskState: TaskState;
}

interface ProgressObserver {
  next?: (progress: LoadBundleTaskProgress) => void;
  error?: (err: Error) => void;
  complete?: () => void;
}

const namedQueryRegistry = new WeakMap<object, Map<string, Query>>();

export class LoadBundleTask implements PromiseLike<LoadBundleTaskProgress> {
  private readonly _promise: Promise<LoadBundleTaskProgress>;
  private readonly _observers: ProgressObserver[] = [];
  private readonly _history: LoadBundleTaskProgress[] = [];
  private _completed = false;
  private _error?: Error;

  constructor(
    executor: (
      emit: (progress: LoadBundleTaskProgress) => void,
      complete: () => void,
      notifyError: (err: Error) => void,
    ) => Promise<LoadBundleTaskProgress>,
  ) {
    this._promise = executor(
      (step) => {
        this._history.push(step);
        for (const obs of this._observers) obs.next?.(step);
      },
      () => {
        this._completed = true;
        for (const obs of this._observers) obs.complete?.();
      },
      (err) => {
        this._error = err;
        for (const obs of this._observers) obs.error?.(err);
      },
    );
    this._promise.catch(() => {});
  }

  onProgress(next?: (progress: LoadBundleTaskProgress) => void, error?: (err: Error) => void, complete?: () => void): void {
    for (const step of this._history) next?.(step);
    if (this._completed) { complete?.(); return; }
    if (this._error !== undefined) { error?.(this._error); return; }
    this._observers.push({ next, error, complete });
  }

  catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<LoadBundleTaskProgress | TResult> {
    return this._promise.catch(onrejected);
  }

  then<TResult1 = LoadBundleTaskProgress, TResult2 = never>(
    onfulfilled?: ((value: LoadBundleTaskProgress) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }
}

function buildFilterConstraint(spec: BundledFilterSpec): QueryFilterConstraint {
  if (spec.kind === 'where') {
    if (spec.fieldPath === '__name__') return where(documentId(), spec.op, spec.value);
    return where(spec.fieldPath, spec.op, spec.value);
  }
  const children = spec.filters.map(buildFilterConstraint);
  if (spec.kind === 'or') return or(...children);
  return and(...children);
}

export function buildModularQuery(db: FirestoreHandle, entry: BundledQuerySourceSpec): Query {
  let base: Query = collection(db, entry.collectionPath);
  if (entry.isCollectionGroup) base = collectionGroup(db, entry.collectionPath);
  const constraints: QueryConstraint[] = [];
  for (const f of entry.filters) constraints.push(buildFilterConstraint(f));
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

export async function readBundleSourceBytes(bundleData: ReadableStream<Uint8Array> | Uint8Array | string): Promise<Uint8Array> {
  if (typeof bundleData === 'string') return new TextEncoder().encode(bundleData);
  if (bundleData instanceof Uint8Array) return bundleData;
  const reader = bundleData.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value !== undefined) { chunks.push(chunk.value); total += chunk.value.byteLength; }
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const part of chunks) { merged.set(part, pos); pos += part.byteLength; }
  return merged;
}

export function assertBundleInputSupported(bundleData: unknown): asserts bundleData is ReadableStream<Uint8Array> | Uint8Array | string {
  if (bundleData instanceof ArrayBuffer) {
    throw new FirebaseError('invalid-argument', 'Bundle data must be a string, Uint8Array, or ReadableStream on this platform.');
  }
  if (typeof bundleData === 'string' || bundleData instanceof Uint8Array) return;
  if (bundleData !== null && typeof bundleData === 'object' && typeof (bundleData as { getReader?: unknown }).getReader === 'function') return;
  throw new FirebaseError('invalid-argument', 'Unsupported bundle data input.');
}

export function loadBundle(db: FirestoreHandle, bundleData: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string): LoadBundleTask {
  if (!(db instanceof Firestore)) throw new FirebaseError('invalid-argument', 'Expected first argument to loadBundle() to be a Firestore instance.');
  const target = targetOf(db);
  const clientState = clientStateFor(target);
  clientState.markStarted();
  assertBundleInputSupported(bundleData);
  const validatedData = bundleData;
  return new LoadBundleTask(async (emit, complete, notifyError) => {
    await Promise.resolve();
    try {
      const parsed = decodeBundleBytes(await readBundleSourceBytes(validatedData));
      emit({ taskState: 'Running', documentsLoaded: 0, totalDocuments: parsed.totalDocuments, bytesLoaded: 0, totalBytes: parsed.totalBytes });
      const adminDb = getChainableAdminFirestore(target.sandbox.withAuth(null));
      let queryMap = namedQueryRegistry.get(target as object);
      if (queryMap === undefined) { queryMap = new Map<string, Query>(); namedQueryRegistry.set(target as object, queryMap); }
      for (const nq of parsed.namedQueries) {
        const built = buildModularQuery(db, nq);
        queryMap.set(nq.name, built);
        clientState.cacheQuery(built as object);
      }
      for (let i = 0; i < parsed.documents.length; i += 1) {
        const entry = parsed.documents[i];
        if (entry === undefined) continue;
        if (entry.exists && entry.data !== undefined) await adminDb.doc(entry.docPath).set(entry.data);
        else await adminDb.doc(entry.docPath).delete();
        clientState.cacheBundledPath(entry.docPath, entry.exists);
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

export async function namedQuery(db: FirestoreHandle, name: string): Promise<Query | null> {
  if (!(db instanceof Firestore)) throw new FirebaseError('invalid-argument', 'Expected first argument to namedQuery() to be a Firestore instance.');
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  return namedQueryRegistry.get(target as object)?.get(name) ?? null;
}
