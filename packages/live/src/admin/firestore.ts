/**
 * The Admin Firestore row: patches the classes of the real
 * `@google-cloud/firestore` that firebase-admin loads (`patch.ts`), so each
 * Admin call passes `AdminProjectGate` (and `(default)` database check) before
 * any request and makes a record named `<Class>.<method>` with the document or
 * collection path it touched, the project, and production's code in the client
 * SDK's spelling (gRPC 5 is `not-found`).
 *
 * A record never carries a document value: no write data, no returned
 * fields, no filter value.
 */
import type { CallContext, LiveObserver } from '../observe.js';
import { liveCallRefusal } from '../refusal.js';
import {
  adminFirestoreDelivery,
  adminFirestoreResult,
  adminFirestoreSessionContext,
} from './firestore-session-capture.js';
import {
  patchAdminFirestoreTransaction,
  patchAdminFirestoreWriteBatch,
} from './firestore-session-staging.js';
import { patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import { failClosedGate, UNREAD_APP, type AdminApp, type AdminProjectGate } from './project-gate.js';
import {
  entryRequire,
  gatePrototypeMethods,
  patchAsyncGeneratorMethod,
  patchObjectStreamMethod,
} from './prototype-gate.js';

/** The module an Admin Firestore record names: the load the row patches. */
export const ADMIN_FIRESTORE_MODULE = '@google-cloud/firestore';

/** gRPC status codes by number, in the client SDK's spelling. */
const GRPC_CODES: readonly string[] = [
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists',
  'permission-denied', 'resource-exhausted', 'failed-precondition', 'aborted', 'out-of-range',
  'unimplemented', 'internal', 'unavailable', 'data-loss', 'unauthenticated',
];

const LOCAL_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  Firestore: new Set([
    'getBulkWriter', 'settings', 'validateAndApplySettings', 'newTraceUtilInstance',
    'doc', 'collection', 'collectionGroup', 'batch', 'bulkWriter', 'snapshot_',
    'bundle', 'registerListener', 'unregisterListener', '_incrementBulkWritersCount',
    '_decrementBulkWritersCount', 'terminate', 'toJSON', 'initializeIfNeeded', 'createCallOptions',
  ]),
  DocumentReference: new Set(['collection', 'isEqual', 'toProto', 'withConverter']),
  CollectionReference: new Set(['doc', 'isEqual', 'withConverter']),
  Query: new Set([
    'where', '_parseFilter', '_parseFieldFilter', '_parseCompositeFilter',
    'select', 'orderBy', 'limit', 'limitToLast', 'offset', 'count', 'aggregate',
    'findNearest', '_findNearest', 'isEqual', 'getInequalityFilterFields',
    'createImplicitOrderBy', 'createCursor', 'validateReference', 'startAt',
    'startAfter', 'endBefore', 'endAt', 'toCursor', 'toProto', '_toBundledQuery',
    'toStructuredQuery', '_isPermanentRpcError', '_hasRetryTimedOut', 'comparator',
    'withConverter', '_createSnapshot',
  ]),
  CollectionGroup: new Set(['withConverter']),
  AggregateQuery: new Set(['decodeResult', 'toProto', 'isEqual']),
  VectorQuery: new Set(['toProto', '_createSnapshot', 'startAfter', 'isEqual']),
  WriteBatch: new Set(['verifyNotCommitted', 'create', 'delete', 'set', 'update', '_reset']),
  Transaction: new Set([
    'create', 'set', 'update', 'delete', 'withLazyStartedTransaction',
    'getSingleFn', 'getBatchFn', 'getQueryFn',
  ]),
  BulkWriter: new Set([
    '_getBufferedOperationsCount', '_setMaxBatchSize', '_setMaxPendingOpCount',
    'onWriteResult', 'onWriteError', '_verifyNotClosed', '_scheduleCurrentBatch',
    '_enqueue', '_processBufferedOps',
  ]),
};

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringAt(subject: unknown, field: string): string | undefined {
  const value: unknown = isObject(subject) ? Reflect.get(subject, field) : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** A failure's code: a gRPC status in the client SDK's spelling, else its string `code`, else its name. */
function adminCodeOf(error: unknown): string {
  const code: unknown = isObject(error) ? Reflect.get(error, 'code') : undefined;
  const isGrpcCode = typeof code === 'number' && GRPC_CODES[code] !== undefined;
  if (isGrpcCode) return GRPC_CODES[code]!;
  if (typeof code === 'string') return code;
  return stringAt(error, 'name') ?? 'unknown';
}

function isFirestoreClient(value: unknown): value is object {
  if (!isObject(value)) return false;
  return (
    '_settings' in value ||
    '_databaseId' in value ||
    typeof Reflect.get(value, 'initializeIfNeeded') === 'function'
  );
}

/**
 * The Firestore a reference, query, vector/aggregate query, batch, transaction,
 * BulkWriter, or the Firestore itself belongs to.
 */
export function firestoreOf(self: unknown): object | undefined {
  if (!isObject(self)) return undefined;
  const owner: unknown = Reflect.get(self, '_firestore') ?? Reflect.get(self, 'firestore');
  if (isFirestoreClient(owner)) return owner;
  const wrappedQuery: unknown = Reflect.get(self, '_query');
  if (isObject(wrappedQuery)) return firestoreOf(wrappedQuery);
  return isFirestoreClient(self) ? self : undefined;
}

/** The Firestore database id (`'(default)'` when unset or empty). */
export function databaseIdOf(self: unknown): string {
  const firestore = firestoreOf(self);
  const settings: unknown = isObject(firestore) ? Reflect.get(firestore, '_settings') : undefined;
  const raw = stringAt(firestore, '_databaseId') ?? stringAt(settings, 'databaseId');
  return raw === undefined || raw === '' ? '(default)' : raw;
}

/** The project the Firestore was given, or resolved, without asking it to resolve one. */
function projectIdOf(self: unknown): string | undefined {
  return stringAt(firestoreOf(self), '_projectId');
}

/** A query's collection path, or its collection id for a collection-group query. */
function queryPath(query: unknown): string | undefined {
  const options: unknown = isObject(query) ? Reflect.get(query, '_queryOptions') : undefined;
  const collectionId = stringAt(options, 'collectionId');
  if (collectionId === undefined) return undefined;
  if (isObject(options) && Reflect.get(options, 'allDescendants') === true) return collectionId;
  const parentObj: unknown = isObject(options) ? Reflect.get(options, 'parentPath') : undefined;
  const parent = stringAt(parentObj, 'relativeName');
  return parent === undefined || parent === '' ? collectionId : `${parent}/${collectionId}`;
}

const FIRST_ARG_PATH_CALLS: ReadonlySet<string> = new Set([
  'Firestore.recursiveDelete',
  'BulkWriter.create',
  'BulkWriter.set',
  'BulkWriter.update',
  'BulkWriter.delete',
]);

/** The path a reference, query, aggregate/vector query, BulkWriter op, or recursiveDelete names. */
function pathOf(name: string, self: unknown, args: readonly unknown[]): string | undefined {
  const own = stringAt(self, 'path');
  if (own !== undefined) return own;
  const wrappedQuery: unknown = isObject(self) ? Reflect.get(self, '_query') : undefined;
  const fromQuery = queryPath(wrappedQuery ?? self);
  if (fromQuery !== undefined) return fromQuery;
  if (FIRST_ARG_PATH_CALLS.has(name)) {
    const firstArg = args[0];
    if (isObject(firstArg)) {
      const argPath = stringAt(firstArg, 'path');
      if (argPath !== undefined) return argPath;
      return queryPath(firstArg);
    }
  }
  return undefined;
}

/** One call's context, read off the SDK's own objects: its project, path, and session delta. */
function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const projectId = projectIdOf(self);
  const path = pathOf(name, self, args);
  const isDefaultDb = databaseIdOf(self) === '(default)';
  const session = isDefaultDb ? adminFirestoreSessionContext(name, args, self, path) : {};
  const context: { -readonly [K in keyof CallContext]: CallContext[K] } = {};
  if (projectId !== undefined) context.projectId = projectId;
  if (path !== undefined) context.path = path;
  if (session.subject !== undefined) context.subject = session.subject;
  if (session.sessionData !== undefined) context.sessionData = session.sessionData;
  if (session.pendingAddDocFields !== undefined) context.pendingAddDocFields = session.pendingAddDocFields;
  return context;
}

const HOOKS = {
  context: contextOf,
  codeOf: adminCodeOf,
  resultOf: adminFirestoreResult,
  throwsLocally: true,
} as const;

function calls(...names: string[]): AdminMethod[] {
  return names.map((name) => ({ name, ...HOOKS }));
}

const LISTENER: AdminMethod = {
  name: 'onSnapshot',
  listener: true,
  deliveryOf: adminFirestoreDelivery,
  ...HOOKS,
};

const CLASSES: readonly { readonly className: string; readonly methods: readonly AdminMethod[] }[] = [
  { className: 'DocumentReference', methods: [...calls('get', 'set', 'update', 'delete', 'create', 'listCollections'), LISTENER] },
  { className: 'CollectionReference', methods: calls('add', 'listDocuments') },
  { className: 'Query', methods: [...calls('get', 'explain'), LISTENER] },
  { className: 'AggregateQuery', methods: calls('get', 'explain') },
  { className: 'VectorQuery', methods: calls('get', 'explain') },
  { className: 'WriteBatch', methods: calls('commit') },
  { className: 'BulkWriter', methods: calls('create', 'set', 'update', 'delete', 'flush', 'close') },
  { className: 'Firestore', methods: calls('getAll', 'runTransaction', 'listCollections', 'recursiveDelete') },
];

/** Where the records go and which gate the calls pass. */
export interface AdminFirestoreRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

type FirestoreAdminApp = AdminApp & { readonly databaseId?: string };

const apps = new WeakMap<object, FirestoreAdminApp>();
const GATE_REQUEST_TAG = 'pyric-admin-gate';

function resolvingCredential(firestore: object): { getProjectId(): Promise<unknown> } {
  return {
    async getProjectId() {
      const initialize: unknown = Reflect.get(firestore, 'initializeIfNeeded');
      if (typeof initialize === 'function') await Reflect.apply(initialize, firestore, [GATE_REQUEST_TAG]);
      return Reflect.get(firestore, '_projectId');
    },
  };
}

function appOf(self: unknown): FirestoreAdminApp {
  const firestore = firestoreOf(self);
  if (firestore === undefined) return UNREAD_APP;
  const known = apps.get(firestore);
  if (known !== undefined) return known;
  const projectId = stringAt(Reflect.get(firestore, '_settings'), 'projectId');
  const databaseId = databaseIdOf(firestore);
  const options = projectId === undefined ? { credential: resolvingCredential(firestore) } : { projectId };
  const app: FirestoreAdminApp = { options, databaseId };
  apps.set(firestore, app);
  return app;
}

function internalClass(entryFile: string, relativePath: string, exportName: string): unknown {
  try {
    const loaded: unknown = entryRequire(entryFile)(relativePath);
    return isObject(loaded) ? Reflect.get(loaded, exportName) : undefined;
  } catch {
    return undefined;
  }
}

function exportedClass(sdk: unknown, className: string): unknown {
  const isModule = isObject(sdk) || typeof sdk === 'function';
  return isModule ? Reflect.get(sdk, className) : undefined;
}

function prototypeOf(sdk: unknown, className: string, entryFile: string): object | undefined {
  let defined: unknown = exportedClass(sdk, className);
  if (defined === undefined && className === 'AggregateQuery') {
    defined = internalClass(entryFile, './reference/aggregate-query.js', 'AggregateQuery');
  } else if (defined === undefined && className === 'VectorQuery') {
    defined = internalClass(entryFile, './reference/vector-query.js', 'VectorQuery');
  }
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  return isObject(prototype) ? prototype : undefined;
}

/**
 * Patches the real `@google-cloud/firestore` module `sdk`, loaded from
 * `entryFile`, once. Later calls change nothing.
 */
export function observeAdminFirestore(sdk: unknown, entryFile: string, row: AdminFirestoreRow): void {
  patchAdminFirestoreWriteBatch(prototypeOf(sdk, 'WriteBatch', entryFile));
  patchAdminFirestoreTransaction(prototypeOf(sdk, 'Transaction', entryFile));
  const baseGate = failClosedGate(row.gate, 'Firestore');
  const gate: AdminProjectGate = (app, call) =>
    baseGate(app, () => {
      const databaseId = (app as FirestoreAdminApp).databaseId;
      if (databaseId !== undefined && databaseId !== '(default)') {
        throw liveCallRefusal(
          {
            call: 'firebase-admin/firestore',
            reaches: `the Firestore database ${JSON.stringify(databaseId)}`,
            serves: 'only the (default) database',
          },
          row.observer.client ?? 'node',
        );
      }
      return call();
    });
  const adminRow: AdminRow = { module: ADMIN_FIRESTORE_MODULE, observer: row.observer, gate, appOf };
  for (const { className, methods } of CLASSES) {
    patchAdminClass(prototypeOf(sdk, className, entryFile), className, methods, adminRow);
  }

  const streamOpts = { observe: true, context: contextOf, codeOf: adminCodeOf };
  const queryProto = prototypeOf(sdk, 'Query', entryFile);
  patchObjectStreamMethod(queryProto, 'stream', adminRow, 'Query', streamOpts);
  patchObjectStreamMethod(queryProto, 'explainStream', adminRow, 'Query', streamOpts);
  patchObjectStreamMethod(queryProto, '_stream', adminRow, 'Query');
  patchObjectStreamMethod(prototypeOf(sdk, 'AggregateQuery', entryFile), '_stream', adminRow, 'AggregateQuery');
  patchObjectStreamMethod(prototypeOf(sdk, 'VectorQuery', entryFile), '_stream', adminRow, 'VectorQuery');
  patchAsyncGeneratorMethod(
    prototypeOf(sdk, 'CollectionGroup', entryFile),
    'getPartitions',
    adminRow,
    'CollectionGroup',
    streamOpts,
  );

  for (const [className, allowlist] of Object.entries(LOCAL_METHODS)) {
    gatePrototypeMethods(prototypeOf(sdk, className, entryFile), {
      gate,
      appOf,
      allowlist,
      skipWhenObserving: true,
    });
  }
}
