import {
  Bytes as InternalBytes,
  Reference as InternalReference,
} from 'pyric/rules/internal';
import {
  copyAdminReferenceRegistration,
  FieldPath,
  isValidTimestampComponents,
  registeredAdminReferencePath,
  Timestamp as CompatTimestamp,
  TXN_ATTEMPTS_EXHAUSTED_MARKER,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type FieldValueSentinel,
  type Filter,
  type LiveDocumentSnapshot,
  type LiveQueryDocumentSnapshot,
  type LiveQuerySnapshot,
  type OperationOptions,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type SetOptions,
  type SnapshotFieldPath,
  type Transaction,
  type WhereFilterOp,
  type WriteBatch,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import {
  onSnapshot as baseOnSnapshot,
  type SandboxFirestore,
  type SnapshotListenOptions,
  type SnapshotObserver,
  type Unsubscribe,
} from 'pyric/sandbox/admin-firestore';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';

function translateAdminTransactionError(err: unknown): never {
  if (
    err !== null
    && typeof err === 'object'
    && (err as Record<symbol, unknown>)[TXN_ATTEMPTS_EXHAUSTED_MARKER] === true
  ) {
    let message = 'Transaction failed after maximum attempts due to repeated conflicts.';
    const rawMessage = (err as { message?: unknown }).message;
    if (typeof rawMessage === 'string') {
      message = rawMessage;
    }
    throw new SandboxError('aborted', message);
  }
  throw err;
}

const adminToUnderlying = new WeakMap<object, object>();
const adminToRootDb = new WeakMap<object, SandboxFirestore>();
const adminToLifecycle = new WeakMap<object, AdminServiceLifecycle>();
const wrappedDbCache = new WeakMap<SandboxFirestore, SandboxFirestore>();

function lifecycleOf(target: object): AdminServiceLifecycle | undefined {
  return adminToLifecycle.get(target);
}

function assertRootActive(rootDb: SandboxFirestore): void {
  lifecycleOf(rootDb)?.assertActive();
}

function runAsyncWithLifecycle<R>(rootDb: SandboxFirestore, fn: () => Promise<R>): Promise<R> {
  try {
    assertRootActive(rootDb);
  } catch (err) {
    return Promise.reject(err);
  }
  return fn();
}

const SENTINEL_TYPES: ReadonlySet<string> = new Set([
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
]);

function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFieldValueSentinel(value: unknown): value is FieldValueSentinel {
  return (
    value !== null
    && typeof value === 'object'
    && typeof (value as { __type?: unknown }).__type === 'string'
    && SENTINEL_TYPES.has((value as { __type: string }).__type)
  );
}

function isFieldPathArgument(value: unknown): boolean {
  return (
    typeof value === 'string'
    || value instanceof FieldPath
    || (value !== null && typeof value === 'object' && '_internalPath' in value)
  );
}

function unwrapAdminObject<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const raw = adminToUnderlying.get(value);
    if (raw !== undefined) return raw as T;
  }
  return value;
}

function normalizeWriteValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof CompatTimestamp) {
    if (!isValidTimestampComponents(value.seconds, value.nanoseconds)) {
      throw new SandboxError(
        'invalid-argument',
        `Invalid Timestamp(seconds=${String(value.seconds)}, nanoseconds=${String(value.nanoseconds)})`,
      );
    }
    return value;
  }
  const referencePath = registeredAdminReferencePath(value);
  if (referencePath !== undefined) {
    return new InternalReference(referencePath);
  }
  if (value instanceof Uint8Array) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new InternalBytes(view.slice());
  }
  if (isFieldValueSentinel(value)) {
    if (value.__type === 'arrayUnion' || value.__type === 'arrayRemove') {
      return {
        __type: value.__type,
        values: value.values.map(normalizeWriteValue),
      };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeWriteValue);
  }
  if (isPlainMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeWriteValue(v)] as const),
    );
  }
  return value;
}

function normalizeWriteData(data: DocumentData): DocumentData {
  if (!isPlainMap(data)) return data;
  return normalizeWriteValue(data) as DocumentData;
}

function normalizeUpdateArguments(args: readonly unknown[]): unknown[] {
  if (args.length === 0) return [];
  const first = args[0];
  if (isFieldPathArgument(first)) {
    const next = [...args];
    for (let i = 1; i < next.length; i += 2) {
      next[i] = normalizeWriteValue(next[i]);
    }
    return next;
  }
  if (isPlainMap(first)) {
    return [normalizeWriteData(first), ...args.slice(1)];
  }
  return [...args];
}

function normalizeQueryOperand(value: unknown, rootDb?: SandboxFirestore): unknown {
  if (value === null || typeof value !== 'object') return value;
  const unwrapped = adminToUnderlying.get(value);
  if (unwrapped !== undefined) return unwrapped;
  if (value instanceof InternalReference && rootDb !== undefined) {
    return unwrapAdminObject(rootDb.doc(value.path));
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.prototype.slice.call(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeQueryOperand(item, rootDb));
  }
  if (isPlainMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeQueryOperand(v, rootDb)] as const),
    );
  }
  return value;
}

function normalizeFilter(filter: Filter, rootDb: SandboxFirestore): Filter {
  if (filter.kind === 'where') {
    return {
      kind: 'where',
      field: filter.field,
      op: filter.op,
      value: normalizeQueryOperand(filter.value, rootDb),
    };
  }
  return {
    kind: filter.kind,
    filters: filter.filters.map((child) => normalizeFilter(child, rootDb)),
  };
}

function unwrapCursorSnapshot(
  snapshot: DocumentSnapshot,
  rootDb: SandboxFirestore,
): DocumentSnapshot {
  const unwrapped = adminToUnderlying.get(snapshot);
  if (unwrapped !== undefined) return unwrapped as DocumentSnapshot;
  return new Proxy(snapshot, {
    get(t, prop) {
      if (prop === 'ref') return unwrapAdminObject(t.ref);
      if (prop === 'data') {
        return () => {
          const data = t.data();
          return data === undefined
            ? undefined
            : (normalizeQueryOperand(data, rootDb) as DocumentData);
        };
      }
      if (prop === 'get') {
        return (fieldPath: SnapshotFieldPath) => normalizeQueryOperand(t.get(fieldPath), rootDb);
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

function docRefOnRoot(rootDb: SandboxFirestore, path: string): DocumentReference {
  const rawRoot = (adminToUnderlying.get(rootDb) as SandboxFirestore | undefined) ?? rootDb;
  return wrapDocRef(rawRoot.doc(path), rootDb);
}

function finalizeReadValue(value: unknown, rootDb: SandboxFirestore): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof InternalReference) {
    return docRefOnRoot(rootDb, value.path);
  }
  if (value instanceof InternalBytes) {
    return Buffer.from(Uint8Array.prototype.slice.call(value.data));
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(Uint8Array.prototype.slice.call(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => finalizeReadValue(item, rootDb));
  }
  if (isPlainMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, finalizeReadValue(v, rootDb)] as const),
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
>(rawSnap: T, rootDb: SandboxFirestore): T {
  const proxy = new Proxy(rawSnap, {
    get(t, prop) {
      if (prop === 'ref' && t.ref && typeof t.ref.path === 'string') {
        return docRefOnRoot(rootDb, t.ref.path);
      }
      if (prop === 'data') {
        return () => {
          const data = t.data();
          return data === undefined ? undefined : (finalizeReadValue(data, rootDb) as DocumentData);
        };
      }
      if (prop === 'get') {
        return (fieldPath: SnapshotFieldPath) => finalizeReadValue(t.get(fieldPath), rootDb);
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapDocSnapshot(
  rawSnap: DocumentSnapshot,
  rootDb: SandboxFirestore,
): DocumentSnapshot {
  return wrapDocSnapshotLike(rawSnap, rootDb);
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
>(rawSnap: TSnap, rootDb: SandboxFirestore): TSnap {
  const wrappedByRaw = new Map<TDoc, TDoc>();
  const wrapOne = (doc: TDoc): TDoc => {
    const existing = wrappedByRaw.get(doc);
    if (existing !== undefined) return existing;
    const wrapped = wrapDocSnapshotLike(doc, rootDb);
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
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawSnap);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapQuerySnapshot(
  rawSnap: QuerySnapshot,
  rootDb: SandboxFirestore,
): QuerySnapshot {
  return wrapQuerySnapshotLike<QueryDocumentSnapshot, QuerySnapshot>(rawSnap, rootDb);
}

function wrapLiveSnapshot(snapshot: unknown, rootDb: SandboxFirestore): unknown {
  if (snapshot === null || typeof snapshot !== 'object') return snapshot;
  const candidate = snapshot as {
    docs?: unknown;
    data?: unknown;
  };
  if (Array.isArray(candidate.docs)) {
    return wrapQuerySnapshotLike<LiveQueryDocumentSnapshot, LiveQuerySnapshot>(
      snapshot as LiveQuerySnapshot,
      rootDb,
    );
  }
  if (typeof candidate.data === 'function') {
    return wrapDocSnapshotLike(snapshot as LiveDocumentSnapshot, rootDb);
  }
  return snapshot;
}

function wrapQueryMethods(
  target: Query,
  prop: PropertyKey,
  rootDb: SandboxFirestore,
): unknown | undefined {
  switch (prop) {
    case 'where':
      return (field: SnapshotFieldPath, op: WhereFilterOp, value: unknown) => {
        assertRootActive(rootDb);
        return wrapQuery(target.where(field, op, normalizeQueryOperand(value, rootDb)), rootDb);
      };
    case 'applyFilter':
      return (filter: Filter) => {
        assertRootActive(rootDb);
        return wrapQuery(target.applyFilter(normalizeFilter(filter, rootDb)), rootDb);
      };
    case 'orderBy':
      return (...args: Parameters<Query['orderBy']>) => {
        assertRootActive(rootDb);
        return wrapQuery(target.orderBy(...args), rootDb);
      };
    case 'limit':
      return (n: number) => {
        assertRootActive(rootDb);
        return wrapQuery(target.limit(n), rootDb);
      };
    case 'limitToLast':
      return (n: number) => {
        assertRootActive(rootDb);
        return wrapQuery(target.limitToLast(n), rootDb);
      };
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) => {
        assertRootActive(rootDb);
        return wrapQuery(
          target.startCursor(
            values.map((item) => normalizeQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rootDb,
        );
      };
    case 'endCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) => {
        assertRootActive(rootDb);
        return wrapQuery(
          target.endCursor(
            values.map((item) => normalizeQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rootDb,
        );
      };
    case 'startCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        assertRootActive(rootDb);
        return wrapQuery(
          target.startCursorFromSnapshot(unwrapCursorSnapshot(snapshot, rootDb), inclusive),
          rootDb,
        );
      };
    case 'endCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        assertRootActive(rootDb);
        return wrapQuery(
          target.endCursorFromSnapshot(unwrapCursorSnapshot(snapshot, rootDb), inclusive),
          rootDb,
        );
      };
    case 'get':
      return (opts?: OperationOptions) =>
        runAsyncWithLifecycle(rootDb, () =>
          target.get(opts).then((snap) => wrapQuerySnapshot(snap, rootDb)),
        );
    case 'aggregate':
      return (...args: Parameters<Query['aggregate']>) =>
        runAsyncWithLifecycle(rootDb, () => target.aggregate(...args));
    default:
      return undefined;
  }
}

function wrapQuery(rawQuery: Query, rootDb: SandboxFirestore): Query {
  const proxy: Query = new Proxy(rawQuery, {
    get(t, prop, receiver) {
      if (prop === 'onSnapshot') {
        const underlying = Reflect.get(t, prop, t);
        if (typeof underlying === 'function') {
          return (...args: unknown[]) =>
            (adminOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(receiver, ...args);
        }
      }
      const queryMethod = wrapQueryMethods(t, prop, rootDb);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawQuery);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapCollectionRef(
  rawColl: CollectionReference,
  rootDb: SandboxFirestore,
): CollectionReference {
  const proxy: CollectionReference = new Proxy(rawColl, {
    get(t, prop, receiver) {
      if (prop === 'doc') {
        return (id?: string) => {
          assertRootActive(rootDb);
          return wrapDocRef(t.doc(id), rootDb);
        };
      }
      if (prop === 'add') {
        return (data: DocumentData, opts?: OperationOptions) =>
          runAsyncWithLifecycle(rootDb, () =>
            t.add(normalizeWriteData(data), opts).then((ref) => wrapDocRef(ref, rootDb)),
          );
      }
      if (prop === 'onSnapshot') {
        const underlying = Reflect.get(t, prop, t);
        if (typeof underlying === 'function') {
          return (...args: unknown[]) =>
            (adminOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(receiver, ...args);
        }
      }
      const queryMethod = wrapQueryMethods(t, prop, rootDb);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawColl);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapDocRef(rawRef: DocumentReference, rootDb: SandboxFirestore): DocumentReference {
  const proxy: DocumentReference = new Proxy(rawRef, {
    get(t, prop, receiver) {
      switch (prop) {
        case 'parent':
          return wrapCollectionRef(t.parent, rootDb);
        case 'collection':
          return (name: string) => {
            assertRootActive(rootDb);
            return wrapCollectionRef(t.collection(name), rootDb);
          };
        case 'get':
          return (opts?: OperationOptions) =>
            runAsyncWithLifecycle(rootDb, () =>
              t.get(opts).then((snap) => wrapDocSnapshot(snap, rootDb)),
            );
        case 'create':
          return (data: DocumentData, opts?: OperationOptions) =>
            runAsyncWithLifecycle(rootDb, () => t.create(normalizeWriteData(data), opts));
        case 'set':
          return (data: DocumentData, options?: SetOptions) =>
            runAsyncWithLifecycle(rootDb, () => t.set(normalizeWriteData(data), options));
        case 'update':
          return (...args: unknown[]) =>
            runAsyncWithLifecycle(rootDb, () => {
              const normalized = normalizeUpdateArguments(args);
              return (t.update as (...a: unknown[]) => Promise<void>)(...normalized);
            });
        case 'delete':
          return (opts?: OperationOptions) =>
            runAsyncWithLifecycle(rootDb, () => t.delete(opts));
        case 'onSnapshot': {
          const underlying = Reflect.get(t, prop, t);
          if (typeof underlying === 'function') {
            return (...args: unknown[]) =>
              (adminOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(receiver, ...args);
          }
          return underlying;
        }
        default: {
          const value = Reflect.get(t, prop, t);
          return typeof value === 'function' ? value.bind(t) : value;
        }
      }
    },
  });
  copyAdminReferenceRegistration(rawRef, proxy);
  adminToUnderlying.set(proxy, rawRef);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapWriterMethod<TWriter extends WriteBatch | Transaction>(
  target: TWriter,
  prop: PropertyKey,
  proxy: TWriter,
  rootDb: SandboxFirestore,
): unknown | undefined {
  switch (prop) {
    case 'create':
      return (ref: DocumentReference, data: DocumentData) => {
        assertRootActive(rootDb);
        target.create(unwrapAdminObject(ref), normalizeWriteData(data));
        return proxy;
      };
    case 'set':
      return (ref: DocumentReference, data: DocumentData, options?: SetOptions) => {
        assertRootActive(rootDb);
        target.set(unwrapAdminObject(ref), normalizeWriteData(data), options);
        return proxy;
      };
    case 'update':
      return (ref: DocumentReference, ...args: unknown[]) => {
        assertRootActive(rootDb);
        const normalized = normalizeUpdateArguments(args);
        (target.update as (r: DocumentReference, ...a: unknown[]) => TWriter)(
          unwrapAdminObject(ref),
          ...normalized,
        );
        return proxy;
      };
    case 'delete':
      return (ref: DocumentReference) => {
        assertRootActive(rootDb);
        target.delete(unwrapAdminObject(ref));
        return proxy;
      };
    default:
      return undefined;
  }
}

function wrapWriteBatch(rawBatch: WriteBatch, rootDb: SandboxFirestore): WriteBatch {
  const proxy: WriteBatch = new Proxy(rawBatch, {
    get(t, prop) {
      const writerMethod = wrapWriterMethod(t, prop, proxy, rootDb);
      if (writerMethod !== undefined) return writerMethod;
      if (prop === 'commit') {
        return (opts?: OperationOptions) =>
          runAsyncWithLifecycle(rootDb, () => t.commit(opts));
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawBatch);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function isQueryLike(value: DocumentReference | Query): value is Query {
  return typeof (value as { where?: unknown }).where === 'function';
}

function wrapTransaction(rawTx: Transaction, rootDb: SandboxFirestore): Transaction {
  const proxy: Transaction = new Proxy(rawTx, {
    get(t, prop) {
      if (prop === 'get') {
        return (refOrQuery: DocumentReference | Query) =>
          runAsyncWithLifecycle<QuerySnapshot | DocumentSnapshot>(rootDb, () => {
            const unwrapped = unwrapAdminObject(refOrQuery);
            if (isQueryLike(unwrapped)) {
              return t.get(unwrapped).then((snap) => wrapQuerySnapshot(snap, rootDb));
            }
            return t.get(unwrapped).then((snap) => wrapDocSnapshot(snap, rootDb));
          });
      }
      const writerMethod = wrapWriterMethod(t, prop, proxy, rootDb);
      if (writerMethod !== undefined) return writerMethod;
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  adminToUnderlying.set(proxy, rawTx);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapAdminFirestoreHandle(
  rawDb: SandboxFirestore,
  lifecycle?: AdminServiceLifecycle,
): SandboxFirestore {
  if (lifecycle === undefined) {
    const cached = wrappedDbCache.get(rawDb);
    if (cached !== undefined) return cached;
  }

  const proxy: SandboxFirestore = new Proxy(rawDb, {
    get(t, prop) {
      switch (prop) {
        case 'doc':
          return (path: string) => {
            lifecycle?.assertActive();
            return wrapDocRef(t.doc(path), proxy);
          };
        case 'collection':
          return (path: string) => {
            lifecycle?.assertActive();
            return wrapCollectionRef(t.collection(path), proxy);
          };
        case 'collectionGroup':
          return (collectionId: string) => {
            lifecycle?.assertActive();
            return wrapQuery(t.collectionGroup(collectionId), proxy);
          };
        case 'batch':
          return () => {
            lifecycle?.assertActive();
            return wrapWriteBatch(t.batch(), proxy);
          };
        case 'runTransaction':
          return <R>(
            fn: (tx: Transaction) => Promise<R> | R,
            opts?: OperationOptions,
          ): Promise<R> =>
            runAsyncWithLifecycle(proxy, () =>
              t
                .runTransaction(async (rawTx) => {
                  assertRootActive(proxy);
                  const result = await fn(wrapTransaction(rawTx, proxy));
                  assertRootActive(proxy);
                  return result;
                }, opts)
                .catch(translateAdminTransactionError),
            );
        case 'seed':
          return (options?: { documents?: Record<string, DocumentData> }) => {
            lifecycle?.assertActive();
            if (options?.documents === undefined) return t.seed(options);
            const normalizedDocs = Object.fromEntries(
              Object.entries(options.documents).map(
                ([docPath, docData]) => [docPath, normalizeWriteData(docData)] as const,
              ),
            );
            return t.seed({ ...options, documents: normalizedDocs });
          };
        default: {
          // Pass deferred members and sandbox helpers through without rebinding
          // so `isDeferredApi(descriptor.value)` and property identity remain intact.
          const value = Reflect.get(t, prop, t);
          if ((prop === 'setRules' || prop === 'snapshot') && typeof value === 'function') {
            return (...args: unknown[]) => {
              lifecycle?.assertActive();
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          }
          return value;
        }
      }
    },
  });

  if (lifecycle === undefined) {
    wrappedDbCache.set(rawDb, proxy);
  } else {
    adminToLifecycle.set(proxy, lifecycle);
  }
  adminToUnderlying.set(proxy, rawDb);
  adminToRootDb.set(proxy, proxy);
  return proxy;
}

function wrapObserverOrCallbackArg(
  arg: unknown,
  rootDb: SandboxFirestore,
): unknown {
  const lifecycle = lifecycleOf(rootDb);
  if (typeof arg === 'function') {
    return (snapshot: unknown) => {
      if (lifecycle?.isDeleted) return;
      (arg as (s: unknown) => void)(wrapLiveSnapshot(snapshot, rootDb));
    };
  }
  if (
    arg !== null
    && typeof arg === 'object'
    && (
      typeof (arg as { next?: unknown }).next === 'function'
      || typeof (arg as { error?: unknown }).error === 'function'
      || typeof (arg as { complete?: unknown }).complete === 'function'
    )
  ) {
    const obs = arg as SnapshotObserver<unknown>;
    const wrapped: SnapshotObserver<unknown> = {};
    if (typeof obs.next === 'function') {
      const boundNext = obs.next.bind(obs);
      wrapped.next = (snapshot: unknown) => {
        if (lifecycle?.isDeleted) return;
        boundNext(wrapLiveSnapshot(snapshot, rootDb));
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

export function adminOnSnapshot(
  reference: DocumentReference,
  observer: SnapshotObserver<LiveDocumentSnapshot>,
): Unsubscribe;
export function adminOnSnapshot(
  reference: DocumentReference,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<LiveDocumentSnapshot>,
): Unsubscribe;
export function adminOnSnapshot(
  reference: DocumentReference,
  onNext: (snapshot: LiveDocumentSnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function adminOnSnapshot(
  reference: DocumentReference,
  options: SnapshotListenOptions,
  onNext: (snapshot: LiveDocumentSnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function adminOnSnapshot(
  reference: Query | CollectionReference,
  observer: SnapshotObserver<LiveQuerySnapshot>,
): Unsubscribe;
export function adminOnSnapshot(
  reference: Query | CollectionReference,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<LiveQuerySnapshot>,
): Unsubscribe;
export function adminOnSnapshot(
  reference: Query | CollectionReference,
  onNext: (snapshot: LiveQuerySnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function adminOnSnapshot(
  reference: Query | CollectionReference,
  options: SnapshotListenOptions,
  onNext: (snapshot: LiveQuerySnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function adminOnSnapshot(
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

  assertRootActive(rootDb);
  const lifecycle = lifecycleOf(rootDb);

  const arg2IsOptions =
    typeof arg2 === 'object'
    && arg2 !== null
    && typeof (arg2 as { next?: unknown }).next !== 'function'
    && typeof (arg2 as { error?: unknown }).error !== 'function'
    && typeof (arg2 as { complete?: unknown }).complete !== 'function';

  let unsubscribe: Unsubscribe;
  if (arg2IsOptions) {
    unsubscribe = (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
      rawReference,
      arg2,
      wrapObserverOrCallbackArg(arg3, rootDb),
      arg4,
      arg5,
    );
  } else {
    unsubscribe = (baseOnSnapshot as (...a: unknown[]) => Unsubscribe)(
      rawReference,
      wrapObserverOrCallbackArg(arg2, rootDb),
      arg3,
      arg4,
      arg5,
    );
  }

  if (lifecycle !== undefined) {
    return lifecycle.trackSubscription(unsubscribe);
  }
  return unsubscribe;
}
