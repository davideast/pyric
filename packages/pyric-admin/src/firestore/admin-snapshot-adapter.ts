/**
 * Snapshot read-value finalization and `onSnapshot` listener adaptation for
 * `pyric-admin/firestore`.
 */

import {
  Bytes as InternalBytes,
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
import {
  adminToRootDb,
  adminToUnderlying,
  isPlainMap,
  unwrapAdminObject,
} from './admin-handle-registry.js';

export type DocRefBuilder = (rootDb: SandboxFirestore, path: string) => DocumentReference;

function finalizeReadValue(
  value: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof InternalReference) {
    return buildDocRef(rootDb, value.path);
  }
  if (value instanceof InternalBytes) {
    return Buffer.from(Uint8Array.prototype.slice.call(value.data));
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(Uint8Array.prototype.slice.call(value));
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
): T {
  const proxy = new Proxy(rawSnap, {
    get(t, prop) {
      if (prop === 'exists' && booleanExists) {
        const rawExists = Reflect.get(t, 'exists', t);
        if (typeof rawExists === 'function') {
          return Boolean((rawExists as () => boolean).call(t));
        }
        return Boolean(rawExists);
      }
      if (prop === 'ref' && t.ref && typeof t.ref.path === 'string') {
        return buildDocRef(rootDb, t.ref.path);
      }
      if (prop === 'data') {
        return () => {
          const data = t.data();
          if (data === undefined) {
            return undefined;
          }
          return finalizeReadValue(data, rootDb, buildDocRef) as DocumentData;
        };
      }
      if (prop === 'get') {
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
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapDocSnapshot(
  rawSnap: DocumentSnapshot,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
): DocumentSnapshot {
  return wrapDocSnapshotLike(rawSnap, rootDb, buildDocRef);
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
): TSnap {
  const wrappedByRaw = new Map<TDoc, TDoc>();
  const wrapOne = (doc: TDoc): TDoc => {
    const existing = wrappedByRaw.get(doc);
    if (existing !== undefined) return existing;
    const wrapped = wrapDocSnapshotLike(doc, rootDb, buildDocRef, booleanExists);
    wrappedByRaw.set(doc, wrapped);
    return wrapped;
  };
  const wrappedDocs = rawSnap.docs.map(wrapOne);
  const proxy = new Proxy(rawSnap, {
    get(t, prop) {
      if (prop === 'docs') return wrappedDocs;
      if (prop === 'forEach') {
        return (callback: (snap: TDoc) => void, thisArg?: unknown) => {
          for (const doc of wrappedDocs) {
            callback.call(thisArg, doc);
          }
        };
      }
      if (prop === 'docChanges') {
        return (options?: { includeMetadataChanges?: boolean }) =>
          t.docChanges(options).map((change) => ({
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
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapQuerySnapshot(
  rawSnap: QuerySnapshot,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
): QuerySnapshot {
  return wrapQuerySnapshotLike<QueryDocumentSnapshot, QuerySnapshot>(rawSnap, rootDb, buildDocRef);
}

function wrapLiveSnapshot(
  snapshot: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists: boolean,
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
    );
  }
  if (typeof candidate.data === 'function') {
    return wrapDocSnapshotLike(
      snapshot as LiveDocumentSnapshot,
      rootDb,
      buildDocRef,
      booleanExists,
    );
  }
  return snapshot;
}

function wrapObserverOrCallbackArg(
  arg: unknown,
  rootDb: SandboxFirestore,
  buildDocRef: DocRefBuilder,
  booleanExists: boolean,
): unknown {
  if (typeof arg === 'function') {
    return (snapshot: unknown) => {
      (arg as (s: unknown) => void)(wrapLiveSnapshot(snapshot, rootDb, buildDocRef, booleanExists));
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
        boundNext(wrapLiveSnapshot(snapshot, rootDb, buildDocRef, booleanExists));
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

export function createAdminOnSnapshot(buildDocRef: DocRefBuilder, booleanExists = false) {
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
    if (reference !== null && typeof reference === 'object') {
      rootDb = adminToRootDb.get(reference);
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
        wrapObserverOrCallbackArg(arg3, rootDb, buildDocRef, booleanExists),
        arg4,
        arg5,
      );
    }
    return (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
      rawReference,
      wrapObserverOrCallbackArg(arg2, rootDb, buildDocRef, booleanExists),
      arg3,
      arg4,
      arg5,
    );
  }

  return adminOnSnapshotImpl;
}
