/**
 * Snapshot read-value finalization, metadata timestamps/equality, projection,
 * converter transformation, and `onSnapshot` listener adaptation for
 * `pyric-admin/firestore`.
 */

import {
  Bytes as InternalBytes,
  LatLng as InternalLatLng,
  Reference as InternalReference,
} from 'pyric/rules/internal';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  LiveDocumentSnapshot,
  LiveQueryDocumentSnapshot,
  LiveQuerySnapshot,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  SnapshotFieldPath,
} from 'pyric/sandbox/admin-compat';
import {
  onSnapshot as baseOnSnapshot,
  type SandboxFirestore,
  type SnapshotListenOptions,
  type SnapshotObserver,
  type Unsubscribe,
} from 'pyric/sandbox/admin-firestore';
import type { AdminFirestoreDataConverter } from './admin-converter-and-discovery.js';
import { GeoPoint } from './admin-geopoint.js';
import {
  adminDocSnapshotBrand,
  adminToRootDb,
  adminToUnderlying,
  isPlainMap,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import { projectDataByFieldPaths, readProjectedNested } from './admin-query-extensions.js';
import { isAdminDocSnapshotEqual } from './admin-reference-and-snapshot-equality.js';
import { tryDecodeAdminVectorFromWire } from './admin-vector-and-errors.js';
import {
  nextAdminTimestamp,
  resolveExistingDocTimestamps,
} from './admin-write-result-preconditions.js';
import { validateStringOrFieldPath } from './admin-write-validation.js';

export type DocRefBuilder = (rootDb: SandboxFirestore, path: string) => DocumentReference;

export interface DocSnapWrapOptions {
  readonly selectedFields?: ReadonlyArray<readonly string[]>;
  readonly converter?: AdminFirestoreDataConverter;
}

export interface QuerySnapWrapOptions<TDoc> {
  readonly queryHandle?: Query;
  readonly docsOverride?: readonly TDoc[];
  readonly selectedFields?: ReadonlyArray<readonly string[]>;
  readonly converter?: AdminFirestoreDataConverter;
}

const SYNTHETIC_DOC_SNAP_PROPS = new Set<PropertyKey>([
  'createTime',
  'updateTime',
  'readTime',
  'isEqual',
]);

const SYNTHETIC_QUERY_SNAP_PROPS = new Set<PropertyKey>([
  'readTime',
  'query',
  'isEqual',
]);

function resolveRawDbFromRoot(rootDb: SandboxFirestore): SandboxFirestore {
  const raw = adminToUnderlying.get(rootDb) as SandboxFirestore | undefined;
  if (raw !== undefined) {
    return raw;
  }
  return rootDb;
}

function finalizeReadValue(
  value: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof InternalReference) {
    return buildDocRef(rootDb, value.path);
  }
  if (value instanceof InternalLatLng) {
    return new GeoPoint(value.lat, value.lng);
  }
  if (value instanceof InternalBytes) {
    return Buffer.from(Uint8Array.prototype.slice.call(value.data));
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(Uint8Array.prototype.slice.call(value));
  }
  const decodedVector = tryDecodeAdminVectorFromWire(value);
  if (decodedVector !== undefined) {
    return decodedVector;
  }
  if (Array.isArray(value)) {
    return value.map((item) => finalizeReadValue(item, rootDb, buildDocRef));
  }
  if (isPlainMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([k, v]) => [k, finalizeReadValue(v, rootDb, buildDocRef)] as const,
      ),
    );
  }
  return value;
}

function resolveSnapshotExists(rawSnap: object): boolean {
  const rawExists = Reflect.get(rawSnap, 'exists', rawSnap);
  if (typeof rawExists === 'function') {
    return Boolean((rawExists as () => boolean).call(rawSnap));
  }
  if (typeof rawExists === 'boolean') {
    return rawExists;
  }
  return true;
}

function wrapDocSnapshotLike<
  T extends {
    ref?: { path: string };
    data: () => DocumentData | undefined;
    get: (fieldPath: SnapshotFieldPath) => unknown;
  },
>(
  rawSnap: T,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists = false,
  options?: DocSnapWrapOptions,
): T {
  const rawDb = resolveRawDbFromRoot(rootDb);
  const readTime = nextAdminTimestamp(rawDb);
  const existsFlag = resolveSnapshotExists(rawSnap);
  let docPath = '';
  if (rawSnap.ref !== undefined && typeof rawSnap.ref.path === 'string') {
    docPath = rawSnap.ref.path;
  }
  let createTime: ReturnType<typeof nextAdminTimestamp> | undefined;
  let updateTime: ReturnType<typeof nextAdminTimestamp> | undefined;
  if (existsFlag && docPath.length > 0) {
    const resolved = resolveExistingDocTimestamps(rawDb, docPath);
    createTime = resolved.createTime;
    updateTime = resolved.updateTime;
  }

  const computeUntypedData = (): DocumentData | undefined => {
    const data = rawSnap.data();
    if (data === undefined) {
      return undefined;
    }
    const finalized = finalizeReadValue(data, rootDb, buildDocRef) as DocumentData;
    if (options?.selectedFields !== undefined) {
      return projectDataByFieldPaths(finalized, options.selectedFields);
    }
    return finalized;
  };

  const proxy: T = new Proxy(rawSnap, {
    has(t, prop) {
      if (SYNTHETIC_DOC_SNAP_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_DOC_SNAP_PROPS.has(prop)) {
        return {
          value: Reflect.get(proxy, prop, proxy),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
    get(t, prop) {
      if (prop === 'exists' && booleanExists) {
        return existsFlag;
      }
      if (prop === 'createTime') return createTime;
      if (prop === 'updateTime') return updateTime;
      if (prop === 'readTime') return readTime;
      if (prop === 'ref' && docPath.length > 0) {
        return buildDocRef(rootDb, docPath);
      }
      if (prop === 'isEqual') {
        return (other: unknown) =>
          isAdminDocSnapshotEqual(proxy, docPath, existsFlag, computeUntypedData(), other);
      }
      if (prop === 'data') {
        if (options?.converter !== undefined) {
          const conv = options.converter;
          return () => {
            if (!existsFlag) return undefined;
            const untyped = computeUntypedData();
            if (untyped === undefined) return undefined;
            const qdsView = {
              id: Reflect.get(t, 'id', t),
              ref: buildDocRef(rootDb, docPath),
              exists: true,
              createTime,
              updateTime,
              readTime,
              data: () => untyped,
              get: (fp: SnapshotFieldPath) =>
                readProjectedNested(untyped, validateStringOrFieldPath('fieldPath', fp)).value,
            } as unknown as QueryDocumentSnapshot;
            return conv.fromFirestore(qdsView);
          };
        }
        return computeUntypedData;
      }
      if (prop === 'get') {
        if (options?.selectedFields !== undefined) {
          return (fieldPath: SnapshotFieldPath) => {
            const projected = computeUntypedData();
            if (projected === undefined) return undefined;
            return readProjectedNested(
              projected,
              validateStringOrFieldPath('fieldPath', fieldPath),
            ).value;
          };
        }
        return (fieldPath: SnapshotFieldPath) =>
          finalizeReadValue(t.get(fieldPath), rootDb, buildDocRef);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
  adminDocSnapshotBrand.add(proxy);
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapDocSnapshot(
  rawSnap: DocumentSnapshot,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  options?: DocSnapWrapOptions,
): DocumentSnapshot {
  return wrapDocSnapshotLike(rawSnap, rootDb, buildDocRef, false, options);
}

function wrapQuerySnapshotLike<
  TDoc extends {
    ref?: { path: string };
    data: () => DocumentData;
    get: (fieldPath: SnapshotFieldPath) => unknown;
  },
  TSnap extends {
    docs: readonly TDoc[];
    docChanges: (options?: { includeMetadataChanges?: boolean }) => Array<{ doc: TDoc }>;
  },
>(
  rawSnap: TSnap,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists = false,
  options?: QuerySnapWrapOptions<TDoc>,
): TSnap {
  const rawDb = resolveRawDbFromRoot(rootDb);
  const readTime = nextAdminTimestamp(rawDb);
  const wrappedByRaw = new Map<TDoc, TDoc>();
  const wrapOne = (doc: TDoc): TDoc => {
    const existing = wrappedByRaw.get(doc);
    if (existing !== undefined) return existing;
    const wrapped = wrapDocSnapshotLike(doc, rootDb, buildDocRef, booleanExists, {
      selectedFields: options?.selectedFields,
      converter: options?.converter,
    });
    wrappedByRaw.set(doc, wrapped);
    return wrapped;
  };
  let sourceDocs = rawSnap.docs;
  if (options?.docsOverride !== undefined) {
    sourceDocs = options.docsOverride;
  }
  const wrappedDocs = sourceDocs.map(wrapOne);

  const proxy: TSnap = new Proxy(rawSnap, {
    has(t, prop) {
      if (SYNTHETIC_QUERY_SNAP_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_QUERY_SNAP_PROPS.has(prop)) {
        return {
          value: Reflect.get(proxy, prop, proxy),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
    get(t, prop) {
      if (prop === 'docs') return wrappedDocs;
      if (prop === 'size') return wrappedDocs.length;
      if (prop === 'empty') return wrappedDocs.length === 0;
      if (prop === 'readTime') return readTime;
      if (prop === 'query') return options?.queryHandle;
      if (prop === 'isEqual') {
        return (other: unknown): boolean => {
          if (proxy === other) return true;
          if (typeof other !== 'object' || other === null || !adminDocSnapshotBrand.has(other)) {
            return false;
          }
          const cand = other as {
            size?: unknown;
            docs?: readonly unknown[];
            query?: unknown;
          };
          if (!Array.isArray(cand.docs) || cand.size !== wrappedDocs.length) {
            return false;
          }
          if (options?.queryHandle !== undefined) {
            const qEq = (options.queryHandle as unknown as { isEqual?: (o: unknown) => boolean })
              .isEqual;
            if (typeof qEq === 'function' && !qEq.call(options.queryHandle, cand.query)) {
              return false;
            }
          }
          for (let i = 0; i < wrappedDocs.length; i += 1) {
            const dEq = (wrappedDocs[i] as unknown as { isEqual: (o: unknown) => boolean }).isEqual;
            if (!dEq.call(wrappedDocs[i], cand.docs[i])) {
              return false;
            }
          }
          return true;
        };
      }
      if (prop === 'forEach') {
        return (callback: (snap: TDoc) => void, thisArg?: unknown) => {
          for (const doc of wrappedDocs) {
            callback.call(thisArg, doc);
          }
        };
      }
      if (prop === 'docChanges') {
        if (options?.docsOverride !== undefined) {
          return () =>
            wrappedDocs.map((doc, idx) => ({
              type: 'added' as const,
              doc,
              oldIndex: -1,
              newIndex: idx,
            }));
        }
        return (changeOpts?: { includeMetadataChanges?: boolean }) =>
          t.docChanges(changeOpts).map((change) => ({
            ...change,
            doc: wrapOne(change.doc),
          }));
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
  adminDocSnapshotBrand.add(proxy);
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapQuerySnapshot(
  rawSnap: QuerySnapshot,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  options?: QuerySnapWrapOptions<QueryDocumentSnapshot>,
): QuerySnapshot {
  return wrapQuerySnapshotLike<QueryDocumentSnapshot, QuerySnapshot>(
    rawSnap,
    rootDb,
    buildDocRef,
    false,
    options,
  );
}

function wrapLiveSnapshot(
  snapshot: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists: boolean,
  queryHandle?: Query,
  converter?: AdminFirestoreDataConverter,
): unknown {
  if (snapshot === null || typeof snapshot !== 'object') return snapshot;
  const candidate = snapshot as {
    docs?: unknown;
    data?: unknown;
  };
  if (Array.isArray(candidate.docs)) {
    return wrapQuerySnapshotLike<LiveQueryDocumentSnapshot, LiveQuerySnapshot>(
      snapshot as LiveQuerySnapshot,
      rootDb,
      buildDocRef,
      booleanExists,
      { queryHandle, converter },
    );
  }
  if (typeof candidate.data === 'function') {
    return wrapDocSnapshotLike(snapshot as LiveDocumentSnapshot, rootDb, buildDocRef, booleanExists, {
      converter,
    });
  }
  return snapshot;
}

function wrapObserverOrCallbackArg(
  arg: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists: boolean,
  queryHandle?: Query,
  converter?: AdminFirestoreDataConverter,
): unknown {
  if (typeof arg === 'function') {
    return (snapshot: unknown) => {
      (arg as (s: unknown) => void)(
        wrapLiveSnapshot(snapshot, rootDb, buildDocRef, booleanExists, queryHandle, converter),
      );
    };
  }
  if (
    arg !== null &&
    typeof arg === 'object' &&
    (typeof (arg as { next?: unknown }).next === 'function' ||
      typeof (arg as { error?: unknown }).error === 'function' ||
      typeof (arg as { complete?: unknown }).complete === 'function')
  ) {
    const obs = arg as SnapshotObserver<unknown>;
    const wrapped: SnapshotObserver<unknown> = {};
    if (typeof obs.next === 'function') {
      const boundNext = obs.next.bind(obs);
      wrapped.next = (snapshot: unknown) => {
        boundNext(
          wrapLiveSnapshot(snapshot, rootDb, buildDocRef, booleanExists, queryHandle, converter),
        );
      };
    }
    if (typeof obs.error === 'function') {
      wrapped.error = obs.error.bind(obs);
    }
    if (typeof obs.complete === 'function') {
      wrapped.complete = obs.complete.bind(obs);
    }
    return wrapped;
  }
  return arg;
}

export function createAdminOnSnapshot(
  buildDocRef: DocRefBuilder,
  booleanExists = false,
  lookupConverter?: (ref: object) => AdminFirestoreDataConverter | undefined,
) {
  function adminOnSnapshotImpl(
    reference: DocumentReference,
    observer: SnapshotObserver<LiveDocumentSnapshot>,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: DocumentReference,
    options: SnapshotListenOptions,
    observer: SnapshotObserver<LiveDocumentSnapshot>,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: DocumentReference,
    onNext: (snapshot: LiveDocumentSnapshot) => void,
    onError?: (error: unknown) => void,
    onCompletion?: () => void,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: DocumentReference,
    options: SnapshotListenOptions,
    onNext: (snapshot: LiveDocumentSnapshot) => void,
    onError?: (error: unknown) => void,
    onCompletion?: () => void,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: Query | CollectionReference,
    observer: SnapshotObserver<LiveQuerySnapshot>,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: Query | CollectionReference,
    options: SnapshotListenOptions,
    observer: SnapshotObserver<LiveQuerySnapshot>,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: Query | CollectionReference,
    onNext: (snapshot: LiveQuerySnapshot) => void,
    onError?: (error: unknown) => void,
    onCompletion?: () => void,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: Query | CollectionReference,
    options: SnapshotListenOptions,
    onNext: (snapshot: LiveQuerySnapshot) => void,
    onError?: (error: unknown) => void,
    onCompletion?: () => void,
  ): Unsubscribe;
  function adminOnSnapshotImpl(
    reference: DocumentReference | Query | CollectionReference,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg2: SnapshotListenOptions | SnapshotObserver<any> | ((snapshot: any) => void),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg3?: SnapshotObserver<any> | ((snapshot: any) => void) | ((error: unknown) => void),
    arg4?: ((error: unknown) => void) | (() => void),
    arg5?: () => void,
  ): Unsubscribe {
    let rootDb: SandboxFirestore | undefined;
    let converter: AdminFirestoreDataConverter | undefined;
    if (reference !== null && typeof reference === 'object') {
      rootDb = adminToRootDb.get(reference);
      if (lookupConverter !== undefined) {
        converter = lookupConverter(reference);
      }
    }
    const rawReference = unwrapAdminObject(reference);
    if (rootDb === undefined) {
      return (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
        rawReference,
        arg2,
        arg3,
        arg4,
        arg5,
      );
    }

    const qHandle = reference as Query;
    const arg2IsOptions =
      typeof arg2 === 'object' &&
      arg2 !== null &&
      typeof (arg2 as { next?: unknown }).next !== 'function' &&
      typeof (arg2 as { error?: unknown }).error !== 'function' &&
      typeof (arg2 as { complete?: unknown }).complete !== 'function';

    if (arg2IsOptions) {
      return (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
        rawReference,
        arg2,
        wrapObserverOrCallbackArg(arg3, rootDb, buildDocRef, booleanExists, qHandle, converter),
        arg4,
        arg5,
      );
    }
    return (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
      rawReference,
      wrapObserverOrCallbackArg(arg2, rootDb, buildDocRef, booleanExists, qHandle, converter),
      arg3,
      arg4,
      arg5,
    );
  }

  return adminOnSnapshotImpl;
}
