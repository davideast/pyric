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
  type Filter as CompatFilter,
  type OperationOptions,
  type Query,
  type SetOptions,
  type SnapshotFieldPath,
  type Transaction,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import {
  executeAdminRunTransaction,
  wrapWriteBatch,
} from './admin-batch-transaction.js';
import {
  applyAdminCursorArgs,
  buildAdminAggregateQuery,
  compileAdminFilter,
  isAdminFilterInstance,
} from './admin-filter-aggregate-cursors.js';
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
  assertSingleWritePrecondition,
  extractParsedPrecondition,
  extractUpdateTrailingPrecondition,
  recordSeededAdminDocuments,
  recordSingleAdminDelete,
  recordSingleAdminWrite,
  type WriteResult,
} from './admin-write-result-preconditions.js';
import {
  validateAndNormalizeDocumentData,
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-write-validation.js';

function resolveRawRootDb(rootDb: SandboxFirestore): SandboxFirestore {
  const unwrapped = adminToUnderlying.get(rootDb) as SandboxFirestore | undefined;
  if (unwrapped !== undefined) {
    return unwrapped;
  }
  return rootDb;
}

function docRefOnRoot(rootDb: SandboxFirestore, path: string): DocumentReference {
  const rawRoot = resolveRawRootDb(rootDb);
  return wrapDocRef(rawRoot.doc(path), rawRoot, rootDb);
}

export const adminOnSnapshot = createAdminOnSnapshot(docRefOnRoot, false);
const adminInstanceOnSnapshot = createAdminOnSnapshot(docRefOnRoot, true);

const SYNTHETIC_QUERY_CURSOR_PROPS: ReadonlySet<PropertyKey> = new Set([
  'startAt',
  'startAfter',
  'endAt',
  'endBefore',
]);

function wrapQueryMethods(
  target: Query,
  receiverQuery: Query,
  prop: PropertyKey,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
): unknown | undefined {
  switch (prop) {
    case 'where':
      return (...args: unknown[]) => {
        if (isAdminFilterInstance(args[0])) {
          const compiled = compileAdminFilter(args[0], meta, rootDb);
          if (compiled === null) {
            return wrapQuery(target, rawDb, rootDb, meta);
          }
          return wrapQuery(target.applyFilter(compiled), rawDb, rootDb, meta);
        }
        const normalized = validateAndNormalizeWhereArgs(args[0], args[1], args[2], meta, rootDb);
        return wrapQuery(
          target.where(normalized.field, normalized.op, normalized.value),
          rawDb,
          rootDb,
          meta,
        );
      };
    case 'applyFilter':
      return (filter: CompatFilter) => {
        return wrapQuery(
          target.applyFilter(normalizeCompositeFilter(filter, rootDb)),
          rawDb,
          rootDb,
          meta,
        );
      };
    case 'orderBy':
      return (field: SnapshotFieldPath, direction?: unknown) => {
        const normalized = validateAndNormalizeOrderByArgs(field, direction);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          hasExplicitOrderBy: true,
        };
        return wrapQuery(
          target.orderBy(normalized.field, normalized.direction),
          rawDb,
          rootDb,
          nextMeta,
        );
      };
    case 'limit':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limit', n);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          pendingLimitType: 'first',
        };
        return wrapQuery(target.limit(parsed), rawDb, rootDb, nextMeta);
      };
    case 'limitToLast':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limitToLast', n);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          pendingLimitType: 'last',
        };
        return wrapQuery(target.limitToLast(parsed), rawDb, rootDb, nextMeta);
      };
    case 'startAt':
    case 'startAfter':
    case 'endAt':
    case 'endBefore':
      return (...args: unknown[]) => {
        const nextTarget = applyAdminCursorArgs(target, prop, args, rootDb);
        return wrapQuery(nextTarget, rawDb, rootDb, meta);
      };
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) => {
        return wrapQuery(
          target.startCursor(
            values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rawDb,
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
          rawDb,
          rootDb,
          meta,
        );
      };
    case 'startCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        return wrapQuery(
          target.startCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rawDb,
          rootDb,
          meta,
        );
      };
    case 'endCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) => {
        return wrapQuery(
          target.endCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rawDb,
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
      return (rawSpec: unknown) =>
        buildAdminAggregateQuery(target, receiverQuery, rawDb, rawSpec, meta);
    default:
      return undefined;
  }
}

function wrapQuery(
  rawQuery: Query,
  rawDb: SandboxFirestore,
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
      const queryMethod = wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) {
        return own;
      }
      if (SYNTHETIC_QUERY_CURSOR_PROPS.has(prop)) {
        return {
          value: wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
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
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
): CollectionReference {
  const meta = initialCollectionQueryMeta(rawColl.path);
  const proxy: CollectionReference = new Proxy(rawColl, {
    get(t, prop, receiver) {
      if (prop === 'doc') {
        return (...args: [id?: string]) => {
          if (args.length === 0) {
            return wrapDocRef(t.doc(), rawDb, rootDb);
          }
          const normalizedId = normalizeChildDocumentPath(args[0]);
          return wrapDocRef(t.doc(normalizedId), rawDb, rootDb);
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
          return t.add(normalized, opts).then((ref) => {
            recordSingleAdminWrite(rawDb, ref.path);
            return wrapDocRef(ref, rawDb, rootDb);
          });
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
      const queryMethod = wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) {
        return own;
      }
      if (SYNTHETIC_QUERY_CURSOR_PROPS.has(prop)) {
        return {
          value: wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
  });
  adminQueryBrand.add(proxy);
  adminQueryMetadata.set(proxy, meta);
  adminToUnderlying.set(proxy, rawColl);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
}

function wrapDocRef(
  rawRef: DocumentReference,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
): DocumentReference {
  const proxy: DocumentReference = new Proxy(rawRef, {
    get(t, prop, receiver) {
      switch (prop) {
        case 'parent':
          return wrapCollectionRef(t.parent, rawDb, rootDb);
        case 'collection':
          return (name: string) => {
            const normalizedSub = normalizeCollectionPath(name);
            return wrapCollectionRef(t.collection(normalizedSub), rawDb, rootDb);
          };
        case 'get':
          return (opts?: OperationOptions) =>
            t.get(opts).then((snap) => wrapDocSnapshot(snap, rootDb, docRefOnRoot));
        case 'create':
          return (data: DocumentData, opts?: OperationOptions): Promise<WriteResult> => {
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              isAppBackedRoot(rootDb),
            );
            return t.create(normalized, opts).then(() => recordSingleAdminWrite(rawDb, t.path));
          };
        case 'set':
          return (data: DocumentData, options?: SetOptions): Promise<WriteResult> => {
            const validated = validateAndNormalizeSetCall(
              data,
              options,
              true,
              isAppBackedRoot(rootDb),
            );
            return t
              .set(validated.data, validated.options)
              .then(() => recordSingleAdminWrite(rawDb, t.path));
          };
        case 'update':
          return (...args: unknown[]): Promise<WriteResult> => {
            const normalized = validateAndNormalizeUpdateArgs(
              args,
              isAppBackedRoot(rootDb),
            );
            const precondition = extractUpdateTrailingPrecondition(args);
            return assertSingleWritePrecondition(rawDb, t.path, 'update', precondition)
              .then(() => (t.update as (...a: unknown[]) => Promise<void>)(...normalized))
              .then(() => recordSingleAdminWrite(rawDb, t.path));
          };
        case 'delete':
          return (...args: [opts?: OperationOptions]): Promise<WriteResult> => {
            const validatedOpts = validatePreconditionObject('precondition', args[0]);
            const precondition = extractParsedPrecondition(args[0]);
            return assertSingleWritePrecondition(rawDb, t.path, 'delete', precondition)
              .then(() => t.delete(validatedOpts))
              .then(() => recordSingleAdminDelete(rawDb, t.path));
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
          return (path: string) => wrapDocRef(t.doc(normalizeRootDocumentPath(path)), t, proxy);
        case 'collection':
          return (path: string) =>
            wrapCollectionRef(t.collection(normalizeCollectionPath(path)), t, proxy);
        case 'collectionGroup':
          return (collectionId: string) => {
            const validatedId = validateCollectionGroupId(collectionId);
            return wrapQuery(
              t.collectionGroup(validatedId),
              t,
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
            if (options?.documents === undefined) {
              recordSeededAdminDocuments(t, []);
              return t.seed(options);
            }
            const normalizedDocs = Object.fromEntries(
              Object.entries(options.documents).map(
                ([docPath, docData]) =>
                  [
                    docPath,
                    validateAndNormalizeDocumentData('data', docData, 'none', appBacked),
                  ] as const,
              ),
            );
            const lint = t.seed({ ...options, documents: normalizedDocs });
            recordSeededAdminDocuments(t, Object.keys(normalizedDocs));
            return lint;
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
