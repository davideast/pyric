/**
 * Root `pyric-admin/firestore` handle wrapper wiring Admin path, snapshot,
 * write, update, query, batch, and transaction adapters across local and
 * JSON-wire remote sandboxes.
 */

import {
  copyAdminReferenceRegistration,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Filter,
  type OperationOptions,
  type Query,
  type SetOptions,
  type SnapshotFieldPath,
  type Transaction,
  type WhereFilterOp,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import {
  executeAdminRunTransaction,
  wrapWriteBatch,
} from './admin-batch-transaction.js';
import {
  adminDocumentRefBrand,
  adminQueryBrand,
  adminToRootDb,
  adminToUnderlying,
  appBackedFirestoreRoots,
  isAppBackedRoot,
  wrappedDbCache,
} from './admin-handle-registry.js';
import {
  normalizeChildDocumentPath,
  normalizeCollectionPath,
  normalizeRootDocumentPath,
  validateCollectionGroupId,
} from './admin-path-validation.js';
import {
  adminQueryMetadata,
  assertQueryExecutable,
  initialCollectionGroupQueryMeta,
  initialCollectionQueryMeta,
  normalizeCompositeFilter,
  normalizeLegacyQueryOperand,
  unwrapCursorSnapshotForAdmin,
  validateAdminLimitInteger,
  validateAndNormalizeOrderByArgs,
  validateAndNormalizeWhereArgs,
  type AdminQueryMetadata,
} from './admin-query-validation.js';
import {
  createAdminOnSnapshot,
  wrapDocSnapshot,
  wrapQuerySnapshot,
} from './admin-snapshot-adapter.js';
import { validateAndNormalizeUpdateArgs } from './admin-update-validation.js';
import {
  validateAndNormalizeDocumentData,
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-write-validation.js';

function docRefOnRoot(rootDb: SandboxFirestore, path: string): DocumentReference {
  const rawRoot = (adminToUnderlying.get(rootDb) as SandboxFirestore | undefined) ?? rootDb;
  return wrapDocRef(rawRoot.doc(path), rootDb);
}

export const adminOnSnapshot = createAdminOnSnapshot(docRefOnRoot, false);
const adminInstanceOnSnapshot = createAdminOnSnapshot(docRefOnRoot, true);

function wrapQueryMethods(
  target: Query,
  prop: PropertyKey,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
): unknown | undefined {
  switch (prop) {
    case 'where':
      return (field: SnapshotFieldPath, op: WhereFilterOp, value: unknown) => {
        const normalized = validateAndNormalizeWhereArgs(field, op, value, meta, rootDb);
        return wrapQuery(
          target.where(normalized.field, normalized.op, normalized.value),
          rootDb,
          meta,
        );
      };
    case 'applyFilter':
      return (filter: Filter) => {
        return wrapQuery(target.applyFilter(normalizeCompositeFilter(filter, rootDb)), rootDb, meta);
      };
    case 'orderBy':
      return (field: SnapshotFieldPath, direction?: unknown) => {
        const normalized = validateAndNormalizeOrderByArgs(field, direction);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          hasExplicitOrderBy: true,
        };
        return wrapQuery(target.orderBy(normalized.field, normalized.direction), rootDb, nextMeta);
      };
    case 'limit':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limit', n);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          pendingLimitType: 'first',
        };
        return wrapQuery(target.limit(parsed), rootDb, nextMeta);
      };
    case 'limitToLast':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limitToLast', n);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          pendingLimitType: 'last',
        };
        return wrapQuery(target.limitToLast(parsed), rootDb, nextMeta);
      };
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) => {
        return wrapQuery(
          target.startCursor(
            values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rootDb,
          meta,
        );
      };
    case 'endCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) => {
        return wrapQuery(
          target.endCursor(
            values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rootDb,
          meta,
        );
      };
    case 'startCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        return wrapQuery(
          target.startCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rootDb,
          meta,
        );
      };
    case 'endCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        return wrapQuery(
          target.endCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rootDb,
          meta,
        );
      };
    case 'get':
      return async (opts?: OperationOptions) => {
        assertQueryExecutable(meta);
        const snap = await target.get(opts);
        return wrapQuerySnapshot(snap, rootDb, docRefOnRoot);
      };
    case 'aggregate':
      return async (...args: Parameters<Query['aggregate']>) => {
        assertQueryExecutable(meta);
        return target.aggregate(...args);
      };
    default:
      return undefined;
  }
}

function wrapQuery(
  rawQuery: Query,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
): Query {
  const proxy: Query = new Proxy(rawQuery, {
    get(t, prop, receiver) {
      if (prop === 'onSnapshot') {
        const underlying = Reflect.get(t, prop, t);
        if (typeof underlying === 'function') {
          return (...args: unknown[]) =>
            (adminInstanceOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(
              receiver,
              ...args,
            );
        }
      }
      const queryMethod = wrapQueryMethods(t, prop, rootDb, meta);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
  adminQueryBrand.add(proxy);
  adminQueryMetadata.set(proxy, meta);
  adminToUnderlying.set(proxy, rawQuery);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapCollectionRef(
  rawColl: CollectionReference,
  rootDb: SandboxFirestore,
): CollectionReference {
  const meta = initialCollectionQueryMeta(rawColl.path);
  const proxy: CollectionReference = new Proxy(rawColl, {
    get(t, prop, receiver) {
      if (prop === 'doc') {
        return (...args: [id?: string]) => {
          if (args.length === 0) {
            return wrapDocRef(t.doc(), rootDb);
          }
          const normalizedId = normalizeChildDocumentPath(args[0]);
          return wrapDocRef(t.doc(normalizedId), rootDb);
        };
      }
      if (prop === 'add') {
        return (data: DocumentData, opts?: OperationOptions) => {
          const normalized = validateAndNormalizeDocumentData(
            'data',
            data,
            'none',
            isAppBackedRoot(rootDb),
          );
          return t.add(normalized, opts).then((ref) => wrapDocRef(ref, rootDb));
        };
      }
      if (prop === 'onSnapshot') {
        const underlying = Reflect.get(t, prop, t);
        if (typeof underlying === 'function') {
          return (...args: unknown[]) =>
            (adminInstanceOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(
              receiver,
              ...args,
            );
        }
      }
      const queryMethod = wrapQueryMethods(t, prop, rootDb, meta);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
  adminQueryBrand.add(proxy);
  adminQueryMetadata.set(proxy, meta);
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
            const normalizedSub = normalizeCollectionPath(name);
            return wrapCollectionRef(t.collection(normalizedSub), rootDb);
          };
        case 'get':
          return (opts?: OperationOptions) =>
            t.get(opts).then((snap) => wrapDocSnapshot(snap, rootDb, docRefOnRoot));
        case 'create':
          return (data: DocumentData, opts?: OperationOptions) => {
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              isAppBackedRoot(rootDb),
            );
            return t.create(normalized, opts);
          };
        case 'set':
          return (data: DocumentData, options?: SetOptions) => {
            const validated = validateAndNormalizeSetCall(
              data,
              options,
              true,
              isAppBackedRoot(rootDb),
            );
            return t.set(validated.data, validated.options);
          };
        case 'update':
          return (...args: unknown[]) => {
            const normalized = validateAndNormalizeUpdateArgs(
              args,
              isAppBackedRoot(rootDb),
            );
            return (t.update as (...a: unknown[]) => Promise<void>)(...normalized);
          };
        case 'delete':
          return (...args: [opts?: OperationOptions]) => {
            const validatedOpts = validatePreconditionObject('precondition', args[0]);
            return t.delete(validatedOpts);
          };
        case 'onSnapshot': {
          const underlying = Reflect.get(t, prop, t);
          if (typeof underlying === 'function') {
            return (...args: unknown[]) =>
              (adminInstanceOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe)(
                receiver,
                ...args,
              );
          }
          return underlying;
        }
        default: {
          const value = Reflect.get(t, prop, t);
          if (typeof value === 'function') {
            return value.bind(t);
          }
          return value;
        }
      }
    },
  });
  copyAdminReferenceRegistration(rawRef, proxy);
  adminDocumentRefBrand.add(proxy);
  adminToUnderlying.set(proxy, rawRef);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

export function wrapAdminFirestoreHandle(
  rawDb: SandboxFirestore,
  appBacked = false,
): SandboxFirestore {
  if (!appBacked) {
    const cached = wrappedDbCache.get(rawDb);
    if (cached !== undefined) return cached;
  }

  const proxy: SandboxFirestore = new Proxy(rawDb, {
    get(t, prop) {
      switch (prop) {
        case 'doc':
          return (path: string) => wrapDocRef(t.doc(normalizeRootDocumentPath(path)), proxy);
        case 'collection':
          return (path: string) => wrapCollectionRef(t.collection(normalizeCollectionPath(path)), proxy);
        case 'collectionGroup':
          return (collectionId: string) => {
            const validatedId = validateCollectionGroupId(collectionId);
            return wrapQuery(
              t.collectionGroup(validatedId),
              proxy,
              initialCollectionGroupQueryMeta(validatedId),
            );
          };
        case 'batch':
          return () => wrapWriteBatch(t, proxy);
        case 'runTransaction':
          return <R>(
            fn: (tx: Transaction) => Promise<R> | R,
            opts?: OperationOptions,
          ): Promise<R> => executeAdminRunTransaction<R>(t, proxy, fn, opts, docRefOnRoot);
        case 'seed':
          return (options?: { documents?: Record<string, DocumentData> }) => {
            if (options?.documents === undefined) return t.seed(options);
            const normalizedDocs = Object.fromEntries(
              Object.entries(options.documents).map(
                ([docPath, docData]) =>
                  [
                    docPath,
                    validateAndNormalizeDocumentData('data', docData, 'none', appBacked),
                  ] as const,
              ),
            );
            return t.seed({ ...options, documents: normalizedDocs });
          };
        default: {
          // Pass deferred members and sandbox helpers through without rebinding
          // so `isDeferredApi(descriptor.value)` and property identity remain intact.
          const value = Reflect.get(t, prop, t);
          if ((prop === 'setRules' || prop === 'snapshot') && typeof value === 'function') {
            return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(t, args);
          }
          return value;
        }
      }
    },
  });

  if (appBacked) {
    appBackedFirestoreRoots.add(proxy);
  } else {
    wrappedDbCache.set(rawDb, proxy);
  }
  adminToUnderlying.set(proxy, rawDb);
  adminToRootDb.set(proxy, proxy);
  return proxy;
}
