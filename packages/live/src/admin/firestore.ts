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
import { createRequire } from 'node:module';
import type { CallContext, LiveObserver, ResultReading } from '../observe.js';
import { patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

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

/** The Firestore a reference, query, batch or the Firestore itself belongs to. */
function firestoreOf(self: unknown): unknown {
  if (!isObject(self)) return undefined;
  const owner: unknown = Reflect.get(self, '_firestore');
  return owner ?? self;
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

/** The path a reference, query or aggregate query names; none for a batch or the Firestore. */
function pathOf(self: unknown): string | undefined {
  const own = stringAt(self, 'path');
  if (own !== undefined) return own;
  const aggregated: unknown = isObject(self) ? Reflect.get(self, '_query') : undefined;
  return queryPath(aggregated ?? self);
}

/** One call's context, read off the SDK's own objects: its project and path. */
function contextOf(_name: string, _args: readonly unknown[], self: unknown): CallContext {
  const projectId = projectIdOf(self);
  const path = pathOf(self);
  const project = projectId === undefined ? {} : { projectId };
  return path === undefined ? project : { ...project, path };
}

/** A resolved `Query.get`'s billed documents: its size, at least 1. */
function queryBilled(_site: unknown, value: unknown): ResultReading {
  const size: unknown = isObject(value) ? Reflect.get(value, 'size') : undefined;
  return typeof size === 'number' ? { billedDocuments: Math.max(size, 1) } : {};
}

const HOOKS = { context: contextOf, codeOf: adminCodeOf, throwsLocally: true } as const;

function calls(...names: string[]): AdminMethod[] {
  return names.map((name) => ({ name, ...HOOKS }));
}

const LISTENER: AdminMethod = { name: 'onSnapshot', listener: true, ...HOOKS };

/** The classes the row patches, the methods of each, and the file that defines it. */
const CLASSES: readonly { readonly className: string; readonly methods: readonly AdminMethod[] }[] = [
  { className: 'DocumentReference', methods: [...calls('get', 'set', 'update', 'delete', 'create', 'listCollections'), LISTENER] },
  { className: 'CollectionReference', methods: calls('add', 'listDocuments') },
  { className: 'Query', methods: [{ name: 'get', ...HOOKS, resultOf: queryBilled }, LISTENER] },
  { className: 'AggregateQuery', methods: calls('get') },
  { className: 'WriteBatch', methods: calls('commit') },
  { className: 'Firestore', methods: calls('getAll', 'runTransaction') },
];

/** Where the records go and which gate the calls pass. */
export interface AdminFirestoreRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

/** Each Firestore's stand-in Admin app, as the gate reads it: the project firebase-admin gave it. */
const apps = new WeakMap<object, AdminApp>();

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
 * The Admin app a call belongs to, for the gate. firebase-admin hands
 * `@google-cloud/firestore` its app's explicit project (`options.projectId`,
 * a `cert()` credential's, or the project variables), so the Firestore's
 * settings carry the project the gate checks. An app with none, such as one
 * on application default credentials with no project set, gets a credential
 * that resolves the project the Firestore would use, before any request.
 */
function appOf(self: unknown): AdminApp {
  const firestore = firestoreOf(self);
  if (!isObject(firestore)) return { options: {} };
  const known = apps.get(firestore);
  if (known !== undefined) return known;
  const projectId = stringAt(Reflect.get(firestore, '_settings'), 'projectId');
  const app: AdminApp = { options: projectId === undefined ? { credential: resolvingCredential(firestore) } : { projectId } };
  apps.set(firestore, app);
  return app;
}

/** `AggregateQuery`, which the package does not export, from the file beside its entry. */
function aggregateQueryClass(entryFile: string): unknown {
  try {
    const loaded: unknown = createRequire(entryFile)('./reference/aggregate-query.js');
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
  const adminRow: AdminRow = { module: ADMIN_FIRESTORE_MODULE, observer: row.observer, gate: row.gate, appOf };
  for (const { className, methods } of CLASSES) patchAdminClass(prototypeOf(sdk, className, entryFile), className, methods, adminRow);
}
