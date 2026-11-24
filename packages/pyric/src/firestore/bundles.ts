/**
 * `pyric/firestore` -- offline bundle loading (`loadBundle`, `LoadBundleTask`)
 * and `namedQuery` hydration matching `firebase/firestore@12.19.0`.
 */
import { Reference as RulesReference } from 'pyric/rules/internal';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { clientStateFor } from './client-state.js';
import { FieldPath, documentId } from './field-values.js';
import {
  and,
  endAt,
  endBefore,
  limit,
  limitToLast,
  or,
  orderBy,
  query,
  startAfter,
  startAt,
  where,
  type QueryConstraint,
  type QueryFilterConstraint,
} from './query-constraints.js';
import { collection, collectionGroup, doc } from './refs.js';
import {
  decodeBundleBytes,
  type BundledCursorSpec,
  type BundledFilterSpec,
  type BundledQueryOrderSpec,
  type BundledQuerySourceSpec,
  type ParsedBundle,
} from './sandbox/bundle-wire.js';
import { getDatabaseChainableAdminFirestore } from './sandbox/named-compat-handle.js';
import { normalizeFirestoreDatabaseId } from './sandbox/named-databases.js';
import { targetOf, type Target } from './state.js';
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

const SIMPLE_FIELD_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
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

  onProgress(
    next?: (progress: LoadBundleTaskProgress) => void,
    error?: (err: Error) => void,
    complete?: () => void,
  ): void {
    for (const step of this._history) next?.(step);
    if (this._completed) {
      complete?.();
      return;
    }
    if (this._error !== undefined) {
      error?.(this._error);
      return;
    }
    this._observers.push({ next, error, complete });
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<LoadBundleTaskProgress | TResult> {
    return this._promise.catch(onrejected);
  }

  then<TResult1 = LoadBundleTaskProgress, TResult2 = never>(
    onfulfilled?: ((value: LoadBundleTaskProgress) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }
}

function resolveModularFieldArg(
  fieldPath: string,
  fieldSegments?: readonly string[],
): string | FieldPath {
  if (fieldPath === '__name__') return documentId();
  if (fieldSegments !== undefined && fieldSegments.length === 1 && fieldSegments[0] === '__name__') {
    return documentId();
  }
  if (fieldSegments !== undefined && fieldSegments.length > 0) {
    const requiresExplicitFieldPath = fieldSegments.some(
      (segment) => !SIMPLE_FIELD_SEGMENT_PATTERN.test(segment),
    );
    if (requiresExplicitFieldPath) {
      return new FieldPath(...fieldSegments);
    }
    return fieldSegments.join('.');
  }
  return fieldPath;
}

function hydrateFilterValue(db: FirestoreHandle, value: unknown): unknown {
  if (value instanceof RulesReference) {
    return doc(db, value.path);
  }
  if (Array.isArray(value)) {
    return value.map((item) => hydrateFilterValue(db, item));
  }
  return value;
}

function buildFilterConstraint(db: FirestoreHandle, spec: BundledFilterSpec): QueryFilterConstraint {
  if (spec.kind === 'where') {
    const fieldArg = resolveModularFieldArg(spec.fieldPath, spec.fieldSegments);
    const hydratedVal = hydrateFilterValue(db, spec.value);
    return where(fieldArg, spec.op, hydratedVal);
  }
  const children = spec.filters.map((child) => buildFilterConstraint(db, child));
  if (spec.kind === 'or') return or(...children);
  return and(...children);
}

function isKeyOrderField(order: BundledQueryOrderSpec | undefined): boolean {
  if (order === undefined) return false;
  if (order.fieldPath === '__name__') return true;
  return order.fieldSegments !== undefined
    && order.fieldSegments.length === 1
    && order.fieldSegments[0] === '__name__';
}

function hydrateCursorValues(
  db: FirestoreHandle,
  entry: BundledQuerySourceSpec,
  cursor: BundledCursorSpec,
): unknown[] {
  return cursor.values.map((val, idx) => {
    if (isKeyOrderField(entry.orders[idx])) {
      if (val instanceof RulesReference) {
        const prefix = `${entry.collectionPath}/`;
        if (!entry.isCollectionGroup && val.path.startsWith(prefix)) {
          const remainder = val.path.slice(prefix.length);
          if (!remainder.includes('/')) return remainder;
        }
        return val.path;
      }
      return val;
    }
    return hydrateFilterValue(db, val);
  });
}

export function buildModularQuery(db: FirestoreHandle, entry: BundledQuerySourceSpec): Query {
  let base: Query = collection(db, entry.collectionPath);
  if (entry.isCollectionGroup) base = collectionGroup(db, entry.collectionPath);
  const constraints: QueryConstraint[] = [];
  for (const f of entry.filters) constraints.push(buildFilterConstraint(db, f));
  for (const o of entry.orders) {
    constraints.push(orderBy(resolveModularFieldArg(o.fieldPath, o.fieldSegments), o.direction));
  }
  if (entry.startAt !== undefined) {
    const startValues = hydrateCursorValues(db, entry, entry.startAt);
    if (entry.startAt.inclusive) constraints.push(startAt(...startValues));
    else constraints.push(startAfter(...startValues));
  }
  if (entry.endAt !== undefined) {
    const endValues = hydrateCursorValues(db, entry, entry.endAt);
    if (entry.endAt.inclusive) constraints.push(endAt(...endValues));
    else constraints.push(endBefore(...endValues));
  }
  if (typeof entry.limitCount === 'number') {
    if (entry.limitType === 'LAST') constraints.push(limitToLast(entry.limitCount));
    else constraints.push(limit(entry.limitCount));
  }
  if (constraints.length === 0) return base;
  return query(base, ...constraints);
}

export async function readBundleSourceBytes(
  bundleData: ReadableStream<Uint8Array> | Uint8Array | string,
): Promise<Uint8Array> {
  if (typeof bundleData === 'string') return new TextEncoder().encode(bundleData);
  if (bundleData instanceof Uint8Array) return bundleData;
  const reader = bundleData.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value !== undefined) {
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const part of chunks) {
    merged.set(part, pos);
    pos += part.byteLength;
  }
  return merged;
}

export function assertBundleInputSupported(
  bundleData: unknown,
): asserts bundleData is ReadableStream<Uint8Array> | Uint8Array | string {
  if (bundleData instanceof ArrayBuffer) {
    throw new FirebaseError(
      'invalid-argument',
      'Bundle data must be a string, Uint8Array, or ReadableStream on this platform.',
    );
  }
  if (typeof bundleData === 'string' || bundleData instanceof Uint8Array) return;
  if (
    bundleData !== null &&
    typeof bundleData === 'object' &&
    typeof (bundleData as { getReader?: unknown }).getReader === 'function'
  ) {
    return;
  }
  throw new FirebaseError('invalid-argument', 'Unsupported bundle data input.');
}

export function expectedProjectIdOfTarget(target: Target): string | undefined {
  const appObj = target.app as { options?: { projectId?: unknown } } | undefined;
  const candidate = appObj?.options?.projectId;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return undefined;
}

export function assertBundleMatchesDatabase(
  parsed: ParsedBundle,
  expectedDatabaseId: string,
  expectedProjectId?: string,
): void {
  for (const nq of parsed.namedQueries) {
    if (nq.databaseId !== undefined && nq.databaseId !== expectedDatabaseId) {
      throw new FirebaseError(
        'invalid-argument',
        `Tried to deserialize key from different database: ${nq.databaseId} vs ${expectedDatabaseId}`,
      );
    }
  }
  for (const docEntry of parsed.documents) {
    if (
      expectedProjectId !== undefined &&
      docEntry.projectId !== undefined &&
      docEntry.projectId !== expectedProjectId
    ) {
      throw new FirebaseError(
        'invalid-argument',
        `Tried to deserialize key from different project: ${docEntry.projectId} vs ${expectedProjectId}`,
      );
    }
    if (docEntry.databaseId !== undefined && docEntry.databaseId !== expectedDatabaseId) {
      throw new FirebaseError(
        'invalid-argument',
        `Tried to deserialize key from different database: ${docEntry.databaseId} vs ${expectedDatabaseId}`,
      );
    }
  }
}

export function loadBundle(
  db: FirestoreHandle,
  bundleData: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
): LoadBundleTask {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to loadBundle() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  const clientState = clientStateFor(target);
  clientState.markStarted();
  assertBundleInputSupported(bundleData);
  const validatedData = bundleData;
  const expectedDb = normalizeFirestoreDatabaseId(target.databaseId);
  const expectedProject = expectedProjectIdOfTarget(target);
  return new LoadBundleTask(async (emit, complete, notifyError) => {
    await Promise.resolve();
    try {
      const parsed = decodeBundleBytes(await readBundleSourceBytes(validatedData));
      assertBundleMatchesDatabase(parsed, expectedDb, expectedProject);
      const done: LoadBundleTaskProgress = {
        taskState: 'Success',
        documentsLoaded: parsed.totalDocuments,
        totalDocuments: parsed.totalDocuments,
        bytesLoaded: parsed.totalBytes,
        totalBytes: parsed.totalBytes,
      };
      if (clientState.hasNewerOrEqualBundle(parsed.id, parsed.createTime)) {
        emit(done);
        complete();
        return done;
      }
      emit({
        taskState: 'Running',
        documentsLoaded: 0,
        totalDocuments: parsed.totalDocuments,
        bytesLoaded: 0,
        totalBytes: parsed.totalBytes,
      });
      const adminDb = getDatabaseChainableAdminFirestore(target.sandbox.withAuth(null), target.databaseId);
      let queryMap = namedQueryRegistry.get(target as object);
      if (queryMap === undefined) {
        queryMap = new Map<string, Query>();
        namedQueryRegistry.set(target as object, queryMap);
      }
      for (const nq of parsed.namedQueries) {
        const built = buildModularQuery(db, nq);
        queryMap.set(nq.name, built);
        clientState.cacheQuery(built as object);
      }
      for (let i = 0; i < parsed.documents.length; i += 1) {
        const entry = parsed.documents[i];
        if (entry === undefined) continue;
        let entryVersion = entry.readTime;
        if (entry.exists) entryVersion = entry.updateTime;
        if (clientState.shouldApplyBundledDocument(entry.docPath, entryVersion)) {
          if (entry.exists && entry.data !== undefined) {
            await adminDb.doc(entry.docPath).set(entry.data);
          } else {
            await adminDb.doc(entry.docPath).delete();
          }
          clientState.cacheBundledPath(entry.docPath, entry.exists, entryVersion);
        }
        emit({
          taskState: 'Running',
          documentsLoaded: i + 1,
          totalDocuments: parsed.totalDocuments,
          bytesLoaded: entry.bytesLoadedAfterDoc,
          totalBytes: parsed.totalBytes,
        });
      }
      clientState.recordLoadedBundle(parsed.id, parsed.createTime);
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
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to namedQuery() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  return namedQueryRegistry.get(target as object)?.get(name) ?? null;
}
