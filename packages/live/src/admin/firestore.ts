/**
 * The Admin Firestore row: patches the classes of the real
 * `@google-cloud/firestore` that firebase-admin loads (`patch.ts`), so each
 * Admin call makes a record named `<Class>.<method>` with the document or
 * collection path it touched, the project, and production's code in the
 * client SDK's spelling (gRPC 5 is `not-found`).
 *
 * Observed: `DocumentReference` `get`, `set`, `update`, `delete`, `create`,
 * `listCollections` and `onSnapshot` (one record per delivery, with its
 * billed documents); `CollectionReference` `add` and `listDocuments`;
 * `Query` `get` (billed documents: the result's size, at least 1) and
 * `onSnapshot`; `AggregateQuery.get`; `WriteBatch.commit`; `Firestore`
 * `getAll` and `runTransaction`. A transaction's own reads and writes are
 * part of its `runTransaction` record.
 *
 * A record never carries a document value: no write data, no returned
 * fields, no filter value.
 */
import Module, { createRequire } from 'node:module';
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

/** The module an Admin Firestore record names: the load the row patches. */
export const ADMIN_FIRESTORE_MODULE = '@google-cloud/firestore';

/** gRPC status codes by number, in the client SDK's spelling. */
const GRPC_CODES: readonly string[] = [
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists',
  'permission-denied', 'resource-exhausted', 'failed-precondition', 'aborted', 'out-of-range',
  'unimplemented', 'internal', 'unavailable', 'data-loss', 'unauthenticated',
];

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
 * The Firestore a reference, query, batch, BulkWriter, or the Firestore itself
 * belongs to. An aggregate query holds none of its own: it reaches it through its query.
 */
export function firestoreOf(self: unknown): object | undefined {
  if (!isObject(self)) return undefined;
  const owner: unknown = Reflect.get(self, '_firestore') ?? Reflect.get(self, 'firestore');
  if (isFirestoreClient(owner)) return owner;
  const aggregated: unknown = Reflect.get(self, '_query');
  if (isObject(aggregated)) return firestoreOf(aggregated);
  return isFirestoreClient(self) ? self : undefined;
}

/** The Firestore database id (`'(default)'` when unset or empty). */
export function databaseIdOf(self: unknown): string {
  const firestore = firestoreOf(self);
  const raw =
    stringAt(firestore, '_databaseId') ??
    stringAt(isObject(firestore) ? Reflect.get(firestore, '_settings') : undefined, 'databaseId');
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
  const parent = stringAt(isObject(options) ? Reflect.get(options, 'parentPath') : undefined, 'relativeName');
  return parent === undefined || parent === '' ? collectionId : `${parent}/${collectionId}`;
}

const FIRST_ARG_PATH_CALLS: ReadonlySet<string> = new Set([
  'Firestore.recursiveDelete',
  'BulkWriter.create',
  'BulkWriter.set',
  'BulkWriter.update',
  'BulkWriter.delete',
]);

/** The path a reference, query, aggregate query, BulkWriter op, or recursiveDelete names; none for getAll, a batch, or the Firestore. */
function pathOf(name: string, self: unknown, args: readonly unknown[]): string | undefined {
  const own = stringAt(self, 'path');
  if (own !== undefined) return own;
  const aggregated: unknown = isObject(self) ? Reflect.get(self, '_query') : undefined;
  const fromQuery = queryPath(aggregated ?? self);
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

/** The classes the row patches, the methods of each, and the file that defines it. */
const CLASSES: readonly { readonly className: string; readonly methods: readonly AdminMethod[] }[] = [
  { className: 'DocumentReference', methods: [...calls('get', 'set', 'update', 'delete', 'create', 'listCollections'), LISTENER] },
  { className: 'CollectionReference', methods: calls('add', 'listDocuments') },
  { className: 'Query', methods: [...calls('get'), LISTENER] },
  { className: 'AggregateQuery', methods: calls('get') },
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

/** Each Firestore's stand-in Admin app, as the gate reads it: the project and databaseId firebase-admin gave it. */
const apps = new WeakMap<object, FirestoreAdminApp>();

/** The tag the Firestore's own project lookup logs under. */
const GATE_REQUEST_TAG = 'pyric-admin-gate';

/**
 * A credential whose `getProjectId` runs the Firestore's own project
 * resolution (`initializeIfNeeded`, which no row patches) and returns the
 * project it worked out. It sends no Firestore request: it asks the
 * Firestore's auth client, as the SDK does before its first request.
 */
function resolvingCredential(firestore: object): { getProjectId(): Promise<unknown> } {
  return {
    async getProjectId() {
      const initialize: unknown = Reflect.get(firestore, 'initializeIfNeeded');
      if (typeof initialize === 'function') await Reflect.apply(initialize, firestore, [GATE_REQUEST_TAG]);
      return Reflect.get(firestore, '_projectId');
    },
  };
}

/**
 * The Admin app a call belongs to, for the gate, or `UNREAD_APP` so
 * `failClosedGate` refuses an unreadable receiver.
 */
function appOf(self: unknown): FirestoreAdminApp {
  const firestore = firestoreOf(self);
  if (firestore === undefined) return UNREAD_APP;
  const known = apps.get(firestore);
  if (known !== undefined) return known;
  const projectId = stringAt(Reflect.get(firestore, '_settings'), 'projectId');
  const databaseId = databaseIdOf(firestore);
  const app: FirestoreAdminApp = {
    options: projectId === undefined ? { credential: resolvingCredential(firestore) } : { projectId },
    databaseId,
  };
  apps.set(firestore, app);
  return app;
}

function entryRequire(entryFile: string): (id: string) => unknown {
  const cache = (Module as unknown as { _cache?: Record<string, { require?: (id: string) => unknown }> })._cache;
  const cached = cache?.[entryFile];
  if (typeof cached?.require === 'function') {
    return cached.require.bind(cached);
  }
  return createRequire(entryFile);
}

/** `AggregateQuery`, which the package does not export, from the file beside its entry. */
function aggregateQueryClass(entryFile: string): unknown {
  try {
    const loaded: unknown = entryRequire(entryFile)('./reference/aggregate-query.js');
    return isObject(loaded) ? Reflect.get(loaded, 'AggregateQuery') : undefined;
  } catch {
    return undefined;
  }
}

/** A class the module exports. Its `module.exports` is the `Firestore` class itself, with the others as its properties. */
function exportedClass(sdk: unknown, className: string): unknown {
  const isModule = isObject(sdk) || typeof sdk === 'function';
  return isModule ? Reflect.get(sdk, className) : undefined;
}

function prototypeOf(sdk: unknown, className: string, entryFile: string): object | undefined {
  const defined: unknown = className === 'AggregateQuery' ? aggregateQueryClass(entryFile) : exportedClass(sdk, className);
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
  for (const { className, methods } of CLASSES) patchAdminClass(prototypeOf(sdk, className, entryFile), className, methods, adminRow);
}
