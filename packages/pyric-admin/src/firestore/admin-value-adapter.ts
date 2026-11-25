/**
 * Root `pyric-admin/firestore` handle wrapper wiring Admin path, snapshot,
 * write, update, query, batch, and transaction adapters across local and
 * JSON-wire remote sandboxes.
 */

import { defineDeferredMembers } from 'pyric/app/internal';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  OperationOptions,
  Query,
  Transaction,
} from 'pyric/sandbox/admin-compat';
import type { Sandbox } from 'pyric/sandbox';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import { wrapWriteBatch } from './admin-batch-transaction.js';
import { executeAdminRunTransaction } from './admin-transaction.js';
import {
  createAdminBulkWriter,
  type AdminBulkWriter,
  type BulkWriterOptions,
} from './admin-bulk-writer.js';
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
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import {
  adminCollectionRefBrand,
  adminQueryBrand,
  adminRawDbProjectId,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  appBackedFirestoreRoots,
  DEFAULT_ADMIN_DATABASE_ID,
  getAdminHandleDatabaseId,
  isAppBackedRoot,
  wrappedDbCache,
} from './admin-handle-registry.js';
import {
  assertAdminRootDatabaseDeclared,
  declareAdminSandboxDatabase,
  getAdminRootOriginalSandbox,
} from './admin-named-databases.js';
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
import { resolveWrappedQueryProperty } from './admin-query-builder.js';
import {
  adminQueryMetadata,
  initialCollectionGroupQueryMeta,
  initialCollectionQueryMeta,
  type AdminQueryMetadata,
} from './admin-query-validation.js';
import {
  capturePreWriteBaselines,
  recordPostWriteVersions,
  resetAdminHistoryOnSeed,
} from './admin-read-time-history.js';
import { isAdminCollectionRefEqual } from './admin-reference-and-snapshot-equality.js';
import {
  applyAdminFirestoreSettings,
  markAdminFirestoreStarted,
  shouldIgnoreUndefinedProperties,
  stripUndefinedForSettings,
  terminateAdminFirestore,
  type AdminFirestoreSettings,
} from './admin-settings-lifecycle.js';
import { createAdminOnSnapshot } from './admin-snapshot-adapter.js';
import {
  recordSeededAdminDocuments,
  recordSingleAdminWrite,
} from './admin-write-result-preconditions.js';
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

function wrapTempAdminDb(rawTempDb: SandboxFirestore, tempSb: Sandbox): SandboxFirestore {
  adminRawDbSandbox.set(rawTempDb, tempSb);
  return wrapAdminFirestoreHandle(rawTempDb, true);
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
  'onSnapshot',
  'select',
  'startAfter',
  'startAt',
  'stream',
  'withConverter',
]);

const collectionGroupDeferredStubs: Record<string, unknown> = {};
defineDeferredMembers(
  collectionGroupDeferredStubs,
  'pyric-admin/firestore',
  'CollectionGroup',
  { sync: ['getPartitions'] },
);

const SYNTHETIC_COL_EXTRA_PROPS: ReadonlySet<PropertyKey> = new Set([
  'listDocuments',
  'parent',
]);

function wrapQuery(
  rawQuery: Query,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
): Query {
  const proxy: Query = new Proxy(rawQuery, {
    has(t, prop) {
      if (meta.isCollectionGroupRoot === true && prop === 'getPartitions') return true;
      if (SYNTHETIC_QUERY_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    get(t, prop, receiver) {
      if (meta.isCollectionGroupRoot === true && prop === 'getPartitions') {
        return collectionGroupDeferredStubs.getPartitions;
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
      const queryMethod = resolveWrappedQueryProperty(
        t,
        proxy,
        prop,
        rawDb,
        rootDb,
        docRefOnRoot,
        wrapQuery,
        meta,
        converter,
      );
      if (queryMethod !== undefined) return queryMethod;
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') return value.bind(t);
      return value;
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (meta.isCollectionGroupRoot === true && prop === 'getPartitions') {
        return {
          value: collectionGroupDeferredStubs.getPartitions,
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      if (SYNTHETIC_QUERY_PROPS.has(prop)) {
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
  const appBacked = isAppBackedRoot(rootDb);
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
          runWithAdminErrorsAsync(appBacked, () =>
            adminCollectionListDocuments(
              rootDb,
              rawDb,
              adminRawDbSandbox.get(rawDb),
              t.path,
              converter,
            ),
          );
      }
      if (prop === 'withConverter') {
        return (nextConv: unknown) =>
          runWithAdminErrorsSync(appBacked, () =>
            wrapCollectionRef(t, rawDb, rootDb, assertValidConverterOrNull(nextConv)),
          );
      }
      if (prop === 'doc') {
        return (...args: [id?: string]) =>
          runWithAdminErrorsSync(appBacked, () => {
            if (args.length === 0) return wrapDocRef(t.doc(), rawDb, rootDb, converter);
            return wrapDocRef(t.doc(normalizeChildDocumentPath(args[0])), rawDb, rootDb, converter);
          });
      }
      if (prop === 'add') {
        return (data: DocumentData, opts?: OperationOptions) => {
          const normalized = runWithAdminErrorsSync(appBacked, () => {
            markAdminFirestoreStarted(rootDb);
            let payload: unknown = applyConverterToWritePayload(converter, data);
            if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
            return validateAndNormalizeDocumentData('data', payload, 'none', appBacked);
          });
          return runWithAdminErrorsAsync(appBacked, async () => {
            assertAdminRootDatabaseDeclared(rootDb);
            const liveColl = rawDb.collection(t.path);
            const ref = await liveColl.add(normalized, opts);
            await capturePreWriteBaselines(rawDb, rootDb, docRefOnRoot, []);
            const wr = recordSingleAdminWrite(rawDb, ref.path);
            await recordPostWriteVersions(
              rawDb,
              rootDb,
              docRefOnRoot,
              [{ path: ref.path, kind: 'write' }],
              wr.writeTime,
            );
            return wrapDocRef(ref, rawDb, rootDb, converter);
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
      const queryMethod = resolveWrappedQueryProperty(
        t,
        proxy,
        prop,
        rawDb,
        rootDb,
        docRefOnRoot,
        wrapQuery,
        meta,
        converter,
      );
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

const firestoreDeferredStubs: Record<string, unknown> = {};
defineDeferredMembers(
  firestoreDeferredStubs,
  'pyric-admin/firestore',
  'Firestore',
  { sync: ['pipeline'] },
);

const SYNTHETIC_ROOT_FIRESTORE_PROPS = new Set<PropertyKey>([
  'bulkWriter',
  'bundle',
  'getAll',
  'listCollections',
  'pipeline',
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
          return (path: string) =>
            runWithAdminErrorsSync(appBacked, () =>
              wrapDocRef(t.doc(normalizeRootDocumentPath(path)), t, proxy),
            );
        case 'collection':
          return (path: string) =>
            runWithAdminErrorsSync(appBacked, () =>
              wrapCollectionRef(t.collection(normalizeCollectionPath(path)), t, proxy),
            );
        case 'collectionGroup':
          return (collectionId: string) =>
            runWithAdminErrorsSync(appBacked, () => {
              const validatedId = validateCollectionGroupId(collectionId);
              return wrapQuery(t.collectionGroup(validatedId), t, proxy, initialCollectionGroupQueryMeta(validatedId));
            });
        case 'batch':
          return () => {
            markAdminFirestoreStarted(proxy);
            return wrapWriteBatch(t, proxy, docRefOnRoot);
          };
        case 'runTransaction':
          return <R>(
            fn: (tx: Transaction) => Promise<R> | R,
            opts?: OperationOptions,
          ): Promise<R> => {
            markAdminFirestoreStarted(proxy);
            return executeAdminRunTransaction<R>(t, proxy, fn, opts, docRefOnRoot, wrapTempAdminDb);
          };
        case 'settings':
          return (settings: AdminFirestoreSettings) => applyAdminFirestoreSettings(proxy, settings);
        case 'terminate':
          return () => terminateAdminFirestore(proxy);
        case 'getAll':
          return (...args: unknown[]) =>
            runWithAdminErrorsAsync(appBacked, () => adminGetAll(proxy, args));
        case 'listCollections':
          return () =>
            runWithAdminErrorsAsync(appBacked, () =>
              adminListCollections(proxy, t, adminRawDbSandbox.get(t)),
            );
        case 'recursiveDelete':
          return (ref: DocumentReference | CollectionReference, bw?: AdminBulkWriter) =>
            runWithAdminErrorsAsync(appBacked, () =>
              adminRecursiveDelete(proxy, t, adminRawDbSandbox.get(t), ref, bw),
            );
        case 'bulkWriter':
          return (options?: BulkWriterOptions) => createAdminBulkWriter(proxy, options);
        case 'pipeline':
          return firestoreDeferredStubs.pipeline;
        case 'bundle':
          return (bundleId?: string) => {
            let projectId = 'pyric-sandbox';
            const mappedProject = adminRawDbProjectId.get(t);
            if (mappedProject !== undefined) projectId = mappedProject;
            const dbId = getAdminHandleDatabaseId(proxy);
            return createAdminBundleBuilder(proxy, projectId, bundleId, dbId);
          };
        case 'seed':
          return (options?: { documents?: Record<string, DocumentData> }) =>
            runWithAdminErrorsSync(appBacked, () => {
              const dbId = getAdminHandleDatabaseId(proxy);
              const origSb = getAdminRootOriginalSandbox(proxy);
              if (dbId !== DEFAULT_ADMIN_DATABASE_ID && origSb !== undefined) {
                declareAdminSandboxDatabase(origSb, dbId);
              }
              if (options?.documents === undefined) {
                const seedTime = recordSeededAdminDocuments(t, []);
                const lintEmpty = t.seed(options);
                resetAdminHistoryOnSeed(t, seedTime);
                return lintEmpty;
              }
              const normalizedDocs = Object.fromEntries(
                Object.entries(options.documents).map(
                  ([docPath, docData]) =>
                    [docPath, validateAndNormalizeDocumentData('data', docData, 'none', appBacked)] as const,
                ),
              );
              const lint = t.seed({ ...options, documents: normalizedDocs });
              const seedTime = recordSeededAdminDocuments(t, Object.keys(normalizedDocs));
              resetAdminHistoryOnSeed(t, seedTime);
              return lint;
            });
        default: {
          const value = Reflect.get(t, prop, t);
          if ((prop === 'setRules' || prop === 'snapshot') && typeof value === 'function') {
            return (...args: unknown[]) =>
              runWithAdminErrorsSync(appBacked, () => {
                if (prop === 'setRules') {
                  const dbId = getAdminHandleDatabaseId(proxy);
                  const origSb = getAdminRootOriginalSandbox(proxy);
                  if (dbId !== DEFAULT_ADMIN_DATABASE_ID && origSb !== undefined) {
                    declareAdminSandboxDatabase(origSb, dbId);
                  }
                }
                return (value as (...a: unknown[]) => unknown).apply(t, args);
              });
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
