/**
 * Terminal Admin-SDK `Query` execution methods (`get`, `count`, `stream`,
 * `explain`, `explainStream`, `findNearest`, `aggregate`) across local and
 * JSON-wire remote sandboxes.
 */

import { SandboxError } from 'pyric/sandbox';
import type {
  OperationOptions,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import type { AdminFirestoreDataConverter } from './admin-converter-and-discovery.js';
import {
  AggregateField,
  buildAdminAggregateQuery,
} from './admin-filter-aggregate-cursors.js';
import {
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import { isAppBackedRoot, unwrapAdminObject } from './admin-handle-registry.js';
import {
  assertAdminRootDatabaseDeclared,
  isBoundToUndeclaredPlaceholderEnv,
} from './admin-named-databases.js';
import {
  createQueryExplainStream,
  createQueryStream,
  executeQueryExplain,
} from './admin-query-extensions.js';
import {
  assertQueryExecutable,
  type AdminQueryMetadata,
} from './admin-query-validation.js';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';
import {
  wrapQuerySnapshot,
  type DocRefBuilder,
} from './admin-snapshot-adapter.js';
import { buildAdminVectorQuery } from './admin-vector-query.js';

async function executeWrappedQueryGet(
  target: Query,
  receiverQuery: Query,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: DocRefBuilder,
  meta: AdminQueryMetadata,
  converter: AdminFirestoreDataConverter | undefined,
  opts?: OperationOptions,
): Promise<QuerySnapshot> {
  markAdminFirestoreStarted(rootDb);
  assertAdminRootDatabaseDeclared(rootDb);
  assertQueryExecutable(meta);
  if (meta.offsetCount !== undefined && meta.offsetCount < 0) {
    throw new SandboxError('invalid-argument', 'Value for argument "offset" must be non-negative.');
  }
  let liveTarget = target;
  if (isBoundToUndeclaredPlaceholderEnv(target)) {
    if (meta.replayOnRoot !== undefined) {
      liveTarget = unwrapAdminObject(meta.replayOnRoot(rootDb));
    } else if (meta.source.kind === 'collection') {
      liveTarget = rawDb.collection(meta.source.path);
    } else {
      liveTarget = rawDb.collectionGroup(meta.source.collectionId);
    }
  }
  const snap = await liveTarget.get(opts);
  let docsOverride: readonly QueryDocumentSnapshot[] | undefined;
  if (meta.offsetCount !== undefined && meta.offsetCount > 0) {
    const sliced = snap.docs.slice(meta.offsetCount);
    if (meta.pendingLimitType === 'first' && meta.limitCount !== undefined) {
      docsOverride = sliced.slice(0, meta.limitCount);
    } else {
      docsOverride = sliced;
    }
  }
  return wrapQuerySnapshot(snap, rootDb, docRefOnRoot, {
    queryHandle: receiverQuery,
    docsOverride,
    selectedFields: meta.selectedFields,
    converter,
  });
}

export function resolveTerminalQueryMethod(
  target: Query,
  receiverQuery: Query,
  prop: PropertyKey,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: DocRefBuilder,
  meta: AdminQueryMetadata,
  converter?: AdminFirestoreDataConverter,
): unknown | undefined {
  const appBacked = isAppBackedRoot(rootDb);
  const runGet = (opts?: OperationOptions): Promise<QuerySnapshot> =>
    runWithAdminErrorsAsync(appBacked, () =>
      executeWrappedQueryGet(target, receiverQuery, rawDb, rootDb, docRefOnRoot, meta, converter, opts),
    );

  switch (prop) {
    case 'get':
      return (opts?: OperationOptions) => runGet(opts);
    case 'count':
      return () =>
        runWithAdminErrorsSync(appBacked, () => {
          markAdminFirestoreStarted(rootDb);
          return buildAdminAggregateQuery(
            target,
            receiverQuery,
            rawDb,
            rootDb,
            { count: AggregateField.count() },
            meta,
          );
        });
    case 'stream':
      return () =>
        runWithAdminErrorsSync(appBacked, () => {
          markAdminFirestoreStarted(rootDb);
          return createQueryStream(meta.pendingLimitType, () => runGet());
        });
    case 'explain':
      return (explainOpts?: { readonly analyze?: boolean }) =>
        runWithAdminErrorsAsync(appBacked, () => {
          markAdminFirestoreStarted(rootDb);
          return executeQueryExplain(explainOpts, () => runGet());
        });
    case 'explainStream':
      return (explainOpts?: { readonly analyze?: boolean }) =>
        runWithAdminErrorsSync(appBacked, () => {
          markAdminFirestoreStarted(rootDb);
          return createQueryExplainStream(meta.pendingLimitType, explainOpts, () => runGet());
        });
    case 'findNearest':
      return (arg0: unknown, arg1?: unknown, arg2?: unknown) =>
        runWithAdminErrorsSync(appBacked, () =>
          buildAdminVectorQuery(
            receiverQuery as unknown as { isEqual(o: unknown): boolean },
            () =>
              runWithAdminErrorsAsync(appBacked, () =>
                executeWrappedQueryGet(target, receiverQuery, rawDb, rootDb, docRefOnRoot, meta, undefined),
              ),
            (filteredDocs) => {
              const fakeRawSnap = {
                docs: filteredDocs,
                size: filteredDocs.length,
                empty: filteredDocs.length === 0,
                forEach: () => undefined,
                docChanges: () => [],
              } as unknown as QuerySnapshot;
              return wrapQuerySnapshot(fakeRawSnap, rootDb, docRefOnRoot, {
                queryHandle: receiverQuery,
                docsOverride: filteredDocs,
                selectedFields: meta.selectedFields,
                converter,
              });
            },
            arg0,
            arg1,
            arg2,
          ),
        );
    case 'aggregate':
      return (rawSpec: unknown) =>
        runWithAdminErrorsSync(appBacked, () => {
          markAdminFirestoreStarted(rootDb);
          return buildAdminAggregateQuery(target, receiverQuery, rawDb, rootDb, rawSpec, meta);
        });
    default:
      return undefined;
  }
}
