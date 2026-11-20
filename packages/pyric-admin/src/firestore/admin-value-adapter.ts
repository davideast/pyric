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
  adminRawDbProjectId,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  appBackedFirestoreRoots,
  isAppBackedRoot,
  wrappedDbCache,
} from './admin-handle-registry.js';
import { createAdminBulkWriter, type AdminBulkWriter } from './admin-bulk-writer.js';
import { createAdminBundleBuilder } from './admin-bundle-builder.js';
import {
  adminGetAll,
  adminListCollections,
  adminRecursiveDelete,
} from './admin-maintenance.js';
import {
  applyAdminFirestoreSettings,
  markAdminFirestoreStarted,
  shouldIgnoreUndefinedProperties,
  stripUndefinedForSettings,
  terminateAdminFirestore,
  type AdminFirestoreSettings,
} from './admin-settings-lifecycle.js';
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
        markAdminFirestoreStarted(rootDb);
        assertQueryExecutable(meta);
        const snap = await target.get(opts);
        return wrapQuerySnapshot(snap, rootDb, docRefOnRoot);
      };
    case 'aggregate':
      return (rawSpec: unknown) => {
        markAdminFirestoreStarted(rootDb);
        return buildAdminAggregateQuery(target, receiverQuery, rawDb, rawSpec, meta);
      };
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
        return async (data: DocumentData, opts?: OperationOptions) => {
          markAdminFirestoreStarted(rootDb);
          let payload = data;
          if (shouldIgnoreUndefinedProperties(rootDb)) {
            payload = stripUndefinedForSettings(data);
          }
          const normalized = validateAndNormalizeDocumentData(
            'data',
            payload,
            'none',
            isAppBackedRoot(rootDb),
          );
          const ref = await t.add(normalized, opts);
          recordSingleAdminWrite(rawDb, ref.path);
          return wrapDocRef(ref, rawDb, rootDb);
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
          return async (opts?: OperationOptions) => {
            markAdminFirestoreStarted(rootDb);
            return wrapDocSnapshot(await t.get(opts), rootDb, docRefOnRoot);
          };
        case 'create':
          return async (data: DocumentData, opts?: OperationOptions): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            let payload = data;
            if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(data);
            const normalized = validateAndNormalizeDocumentData('data', payload, 'none', isAppBackedRoot(rootDb));
            await t.create(normalized, opts);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'set':
          return async (data: DocumentData, options?: SetOptions): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            let payload = data;
            if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(data);
            const validated = validateAndNormalizeSetCall(payload, options, true, isAppBackedRoot(rootDb));
            await t.set(validated.data, validated.options);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'update':
          return async (...args: unknown[]): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            const normalized = validateAndNormalizeUpdateArgs(args, isAppBackedRoot(rootDb));
            await assertSingleWritePrecondition(rawDb, t.path, 'update', extractUpdateTrailingPrecondition(args));
            await (t.update as (...a: unknown[]) => Promise<void>)(...normalized);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'delete':
          return async (...args: [opts?: OperationOptions]): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            const validatedOpts = validatePreconditionObject('precondition', args[0]);
            await assertSingleWritePrecondition(rawDb, t.path, 'delete', extractParsedPrecondition(args[0]));
            await t.delete(validatedOpts);
            return recordSingleAdminDelete(rawDb, t.path);
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

const SYNTHETIC_ROOT_FIRESTORE_PROPS = new Set<PropertyKey>([
  'bulkWriter',
  'bundle',
  'getAll',
  'listCollections',
  'recursiveDelete',
  'settings',
  'terminate',
]);

export function wrapAdminFirestoreHandle(
  rawDb: SandboxFirestore,
  appBacked = false,
): SandboxFirestore {
  if (!appBacked) {
    const cached = wrappedDbCache.get(rawDb);
    if (cached !== undefined) return cached;
  }

  const proxy: SandboxFirestore = new Proxy(rawDb, {
    has(t, prop) {
      if (SYNTHETIC_ROOT_FIRESTORE_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_ROOT_FIRESTORE_PROPS.has(prop)) {
        return { value: Reflect.get(proxy, prop, proxy), writable: true, enumerable: false, configurable: true };
      }
      return undefined;
    },
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
          return () => {
            markAdminFirestoreStarted(proxy);
            return wrapWriteBatch(t, proxy);
          };
        case 'runTransaction':
          return <R>(
            fn: (tx: Transaction) => Promise<R> | R,
            opts?: OperationOptions,
          ): Promise<R> => {
            markAdminFirestoreStarted(proxy);
            return executeAdminRunTransaction<R>(t, proxy, fn, opts, docRefOnRoot);
          };
        case 'settings':
          return (settings: AdminFirestoreSettings) =>
            applyAdminFirestoreSettings(proxy, settings);
        case 'terminate':
          return () => terminateAdminFirestore(proxy);
        case 'getAll':
          return (...args: unknown[]) => adminGetAll(proxy, args);
        case 'listCollections':
          return () => adminListCollections(proxy, t, adminRawDbSandbox.get(t));
        case 'recursiveDelete':
          return (ref: DocumentReference | CollectionReference, bw?: AdminBulkWriter) =>
            adminRecursiveDelete(proxy, t, adminRawDbSandbox.get(t), ref, bw);
        case 'bulkWriter':
          return () => createAdminBulkWriter(proxy);
        case 'bundle':
          return (bundleId?: string) => {
            let projectId = 'pyric-sandbox';
            const mappedProject = adminRawDbProjectId.get(t);
            if (mappedProject !== undefined) {
              projectId = mappedProject;
            }
            return createAdminBundleBuilder(proxy, projectId, bundleId);
          };
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
