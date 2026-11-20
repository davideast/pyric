/**
 * Root `pyric-admin/firestore` handle wrapper wiring Admin path, snapshot,
 * write, update, query, batch, and transaction adapters across local and
 * JSON-wire remote sandboxes.
 */

import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Filter as CompatFilter,
  OperationOptions,
  Query,
  SnapshotFieldPath,
  Transaction,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import { executeAdminRunTransaction, wrapWriteBatch } from './admin-batch-transaction.js';
import { createAdminBulkWriter, type AdminBulkWriter } from './admin-bulk-writer.js';
import { createAdminBundleBuilder } from './admin-bundle-builder.js';
import {
  adminCollectionListDocuments,
  adminHandleConverter,
  applyConverterToWritePayload,
  assertValidConverterOrNull,
  type AdminFirestoreDataConverter,
} from './admin-converter-and-discovery.js';
import { createWrappedDocRef } from './admin-doc-ref-wrapper.js';
import {
  applyAdminCursorArgs,
  compileAdminFilter,
  isAdminFilterInstance,
} from './admin-filter-aggregate-cursors.js';
import {
  adminCollectionRefBrand,
  adminQueryBrand,
  adminRawDbProjectId,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  appBackedFirestoreRoots,
  isAppBackedRoot,
  wrappedDbCache,
} from './admin-handle-registry.js';
import {
  adminGetAll,
  adminListCollections,
  adminRecursiveDelete,
} from './admin-maintenance.js';
import {
  normalizeChildDocumentPath,
  normalizeCollectionPath,
  normalizeRootDocumentPath,
  validateCollectionGroupId,
} from './admin-path-validation.js';
import { resolveTerminalQueryMethod } from './admin-query-execution.js';
import { parseSelectFieldPaths, validateAdminOffsetInteger } from './admin-query-extensions.js';
import {
  adminQueryMetadata,
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
import { isAdminCollectionRefEqual, isAdminQueryEqual } from './admin-reference-and-snapshot-equality.js';
import {
  applyAdminFirestoreSettings,
  markAdminFirestoreStarted,
  shouldIgnoreUndefinedProperties,
  stripUndefinedForSettings,
  terminateAdminFirestore,
  type AdminFirestoreSettings,
} from './admin-settings-lifecycle.js';
import { createAdminOnSnapshot } from './admin-snapshot-adapter.js';
import { recordSeededAdminDocuments, recordSingleAdminWrite } from './admin-write-result-preconditions.js';
import { validateAndNormalizeDocumentData } from './admin-write-validation.js';

function resolveRawRootDb(rootDb: SandboxFirestore): SandboxFirestore {
  const unwrapped = adminToUnderlying.get(rootDb) as SandboxFirestore | undefined;
  if (unwrapped !== undefined) return unwrapped;
  return rootDb;
}

function docRefOnRoot(rootDb: SandboxFirestore, path: string): DocumentReference {
  const rawRoot = resolveRawRootDb(rootDb);
  return wrapDocRef(rawRoot.doc(path), rawRoot, rootDb);
}

const lookupConverter = (ref: object): AdminFirestoreDataConverter | undefined =>
  adminHandleConverter.get(ref);

export const adminOnSnapshot = createAdminOnSnapshot(docRefOnRoot, false, lookupConverter);
const adminInstanceOnSnapshot = createAdminOnSnapshot(docRefOnRoot, true, lookupConverter);

function wrapDocRef(
  rawRef: DocumentReference,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  converter?: AdminFirestoreDataConverter,
): DocumentReference {
  return createWrappedDocRef(
    rawRef,
    rawDb,
    rootDb,
    {
      wrapCollectionRef,
      docRefOnRoot,
      instanceOnSnapshot: adminInstanceOnSnapshot as (ref: unknown, ...rest: unknown[]) => Unsubscribe,
    },
    converter,
  );
}

const SYNTHETIC_QUERY_PROPS: ReadonlySet<PropertyKey> = new Set([
  'count',
  'endAt',
  'endBefore',
  'explain',
  'explainStream',
  'findNearest',
  'firestore',
  'isEqual',
  'offset',
  'select',
  'startAfter',
  'startAt',
  'stream',
  'withConverter',
]);

const SYNTHETIC_COL_EXTRA_PROPS: ReadonlySet<PropertyKey> = new Set([
  'listDocuments',
  'parent',
]);

function wrapQueryMethods(
  target: Query,
  receiverQuery: Query,
  prop: PropertyKey,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
): unknown | undefined {
  const terminal = resolveTerminalQueryMethod(
    target,
    receiverQuery,
    prop,
    rawDb,
    rootDb,
    docRefOnRoot,
    meta,
    converter,
  );
  if (terminal !== undefined) return terminal;
  switch (prop) {
    case 'firestore':
      return rootDb;
    case 'isEqual':
      return (other: unknown) => isAdminQueryEqual(receiverQuery, other);
    case 'where':
      return (...args: unknown[]) => {
        if (isAdminFilterInstance(args[0])) {
          const compiled = compileAdminFilter(args[0], meta, rootDb);
          const nextMeta: AdminQueryMetadata = {
            ...meta,
            signature: [...meta.signature, `filter:${JSON.stringify(compiled)}`],
          };
          if (compiled === null) return wrapQuery(target, rawDb, rootDb, nextMeta, converter);
          return wrapQuery(target.applyFilter(compiled), rawDb, rootDb, nextMeta, converter);
        }
        const normalized = validateAndNormalizeWhereArgs(args[0], args[1], args[2], meta, rootDb);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [
            ...meta.signature,
            `where:${String(normalized.field)}:${normalized.op}:${JSON.stringify(normalized.value)}`,
          ],
        };
        return wrapQuery(
          target.where(normalized.field, normalized.op, normalized.value),
          rawDb,
          rootDb,
          nextMeta,
          converter,
        );
      };
    case 'applyFilter':
      return (filter: CompatFilter) => {
        const norm = normalizeCompositeFilter(filter, rootDb);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `apply:${JSON.stringify(norm)}`],
        };
        return wrapQuery(target.applyFilter(norm), rawDb, rootDb, nextMeta, converter);
      };
    case 'orderBy':
      return (field: SnapshotFieldPath, direction?: unknown) => {
        const normalized = validateAndNormalizeOrderByArgs(field, direction);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `order:${String(normalized.field)}:${normalized.direction}`],
          hasExplicitOrderBy: true,
        };
        return wrapQuery(
          target.orderBy(normalized.field, normalized.direction),
          rawDb,
          rootDb,
          nextMeta,
          converter,
        );
      };
    case 'limit':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limit', n);
        let targetLimit = parsed;
        if (meta.offsetCount !== undefined && meta.offsetCount > 0) {
          targetLimit = meta.offsetCount + parsed;
        }
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `limit:${String(parsed)}`],
          pendingLimitType: 'first',
          limitCount: parsed,
        };
        return wrapQuery(target.limit(targetLimit), rawDb, rootDb, nextMeta, converter);
      };
    case 'limitToLast':
      return (n: number) => {
        const parsed = validateAdminLimitInteger('limitToLast', n);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `limitToLast:${String(parsed)}`],
          pendingLimitType: 'last',
          limitCount: parsed,
        };
        return wrapQuery(target.limitToLast(parsed), rawDb, rootDb, nextMeta, converter);
      };
    case 'offset':
      return (n: number) => {
        const parsed = validateAdminOffsetInteger(n);
        let nextTarget = target;
        if (parsed > 0 && meta.pendingLimitType === 'first' && meta.limitCount !== undefined) {
          nextTarget = target.limit(parsed + meta.limitCount);
        }
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `offset:${String(parsed)}`],
          offsetCount: parsed,
        };
        return wrapQuery(nextTarget, rawDb, rootDb, nextMeta, converter);
      };
    case 'select':
      return (...fields: unknown[]) => {
        const selectedFields = parseSelectFieldPaths(fields);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `select:${JSON.stringify(selectedFields)}`],
          selectedFields,
        };
        return wrapQuery(target, rawDb, rootDb, nextMeta, undefined);
      };
    case 'withConverter':
      return (nextConv: unknown) =>
        wrapQuery(target, rawDb, rootDb, meta, assertValidConverterOrNull(nextConv));
    case 'startAt':
    case 'startAfter':
    case 'endAt':
    case 'endBefore':
      return (...args: unknown[]) => {
        const nextTarget = applyAdminCursorArgs(target, prop, args, rootDb);
        const nextMeta: AdminQueryMetadata = {
          ...meta,
          signature: [...meta.signature, `${prop}:${String(args.length)}`],
        };
        return wrapQuery(nextTarget, rawDb, rootDb, nextMeta, converter);
      };
    case 'startCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) =>
        wrapQuery(
          target.startCursor(
            values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rawDb,
          rootDb,
          meta,
          converter,
        );
    case 'endCursor':
      return (values: unknown[], inclusive: boolean, fromSnapshot?: boolean) =>
        wrapQuery(
          target.endCursor(
            values.map((item) => normalizeLegacyQueryOperand(item, rootDb)),
            inclusive,
            fromSnapshot,
          ),
          rawDb,
          rootDb,
          meta,
          converter,
        );
    case 'startCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) =>
        wrapQuery(
          target.startCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rawDb,
          rootDb,
          meta,
          converter,
        );
    case 'endCursorFromSnapshot':
      return (snapshot: DocumentSnapshot, inclusive: boolean) =>
        wrapQuery(
          target.endCursorFromSnapshot(unwrapCursorSnapshotForAdmin(snapshot, rootDb), inclusive),
          rawDb,
          rootDb,
          meta,
          converter,
        );
    default:
      return undefined;
  }
}

function wrapQuery(
  rawQuery: Query,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
): Query {
  const proxy: Query = new Proxy(rawQuery, {
    has(t, prop) {
      if (SYNTHETIC_QUERY_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
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
      const queryMethod = wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta, converter);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') return value.bind(t);
      return value;
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_QUERY_PROPS.has(prop)) {
        return {
          value: wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta, converter),
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
  if (converter !== undefined) {
    adminHandleConverter.set(proxy, converter);
  }
  return proxy;
}

function wrapCollectionRef(
  rawColl: CollectionReference,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  converter?: AdminFirestoreDataConverter,
): CollectionReference {
  const meta = initialCollectionQueryMeta(rawColl.path);
  const segments = rawColl.path.split('/').filter((s) => s.length > 0);
  const proxy: CollectionReference = new Proxy(rawColl, {
    has(t, prop) {
      if (SYNTHETIC_QUERY_PROPS.has(prop) || SYNTHETIC_COL_EXTRA_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    get(t, prop, receiver) {
      if (prop === 'parent') {
        if (segments.length <= 1) return null;
        return docRefOnRoot(rootDb, segments.slice(0, -1).join('/'));
      }
      if (prop === 'isEqual') {
        return (other: unknown) => isAdminCollectionRefEqual(proxy, other);
      }
      if (prop === 'listDocuments') {
        return () =>
          adminCollectionListDocuments(
            rootDb,
            rawDb,
            adminRawDbSandbox.get(rawDb),
            t.path,
            converter,
          );
      }
      if (prop === 'withConverter') {
        return (nextConv: unknown) =>
          wrapCollectionRef(t, rawDb, rootDb, assertValidConverterOrNull(nextConv));
      }
      if (prop === 'doc') {
        return (...args: [id?: string]) => {
          if (args.length === 0) return wrapDocRef(t.doc(), rawDb, rootDb, converter);
          return wrapDocRef(t.doc(normalizeChildDocumentPath(args[0])), rawDb, rootDb, converter);
        };
      }
      if (prop === 'add') {
        return async (data: DocumentData, opts?: OperationOptions) => {
          markAdminFirestoreStarted(rootDb);
          let payload: unknown = applyConverterToWritePayload(converter, data);
          if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
          const normalized = validateAndNormalizeDocumentData('data', payload, 'none', isAppBackedRoot(rootDb));
          const ref = await t.add(normalized, opts);
          recordSingleAdminWrite(rawDb, ref.path);
          return wrapDocRef(ref, rawDb, rootDb, converter);
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
      const queryMethod = wrapQueryMethods(t, proxy, prop, rawDb, rootDb, meta, converter);
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') return value.bind(t);
      return value;
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_QUERY_PROPS.has(prop) || SYNTHETIC_COL_EXTRA_PROPS.has(prop)) {
        return {
          value: Reflect.get(proxy, prop, proxy),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
  });
  adminCollectionRefBrand.add(proxy);
  adminQueryBrand.add(proxy);
  adminQueryMetadata.set(proxy, meta);
  adminToUnderlying.set(proxy, rawColl);
  adminToRootDb.set(proxy, rootDb);
  if (converter !== undefined) {
    adminHandleConverter.set(proxy, converter);
  }
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
            return wrapQuery(t.collectionGroup(validatedId), t, proxy, initialCollectionGroupQueryMeta(validatedId));
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
          return (settings: AdminFirestoreSettings) => applyAdminFirestoreSettings(proxy, settings);
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
            if (mappedProject !== undefined) projectId = mappedProject;
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
                  [docPath, validateAndNormalizeDocumentData('data', docData, 'none', appBacked)] as const,
              ),
            );
            const lint = t.seed({ ...options, documents: normalizedDocs });
            recordSeededAdminDocuments(t, Object.keys(normalizedDocs));
            return lint;
          };
        default: {
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
