/**
 * The Admin Storage row: patches the classes of the real
 * `@google-cloud/storage` that firebase-admin loads (`patch.ts`), so each
 * Admin call makes a record named `<Class>.<method>` with the bucket and
 * object name it touched, and production's code in the client SDK's spelling
 * (HTTP 404 is `storage/object-not-found`).
 *
 * Observed: `File` `save`, `download`, `delete`, `exists`, `getMetadata`,
 * `setMetadata`, `copy` and `move`; `Bucket` `getFiles`, `upload` and
 * `deleteFiles`. A call the SDK makes inside another, as `exists` reads the
 * metadata and `move` copies then deletes, is part of the outer record.
 *
 * A record never carries an object's bytes or a metadata value.
 */
import { basename } from 'node:path';
import type { CallContext, LiveObserver } from '../observe.js';
import { patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

/** The module an Admin Storage record names: the load the row patches. */
export const ADMIN_STORAGE_MODULE = '@google-cloud/storage';

/** The project a client holds until one is given or resolved (`nodejs-common/service.js`). */
const UNRESOLVED_PROJECT = '{{projectId}}';

/** HTTP statuses in the client SDK's spelling. */
const HTTP_CODES: ReadonlyMap<number, string> = new Map([
  [401, 'storage/unauthenticated'],
  [403, 'storage/unauthorized'],
  [404, 'storage/object-not-found'],
  [412, 'storage/precondition-failed'],
  [429, 'storage/quota-exceeded'],
]);

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringAt(subject: unknown, field: string): string | undefined {
  const value: unknown = isObject(subject) ? Reflect.get(subject, field) : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** A failure's code: an HTTP status in the client SDK's spelling, else its string `code`, else its name. */
function adminCodeOf(error: unknown): string {
  const code: unknown = isObject(error) ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'number') return HTTP_CODES.get(code) ?? 'storage/unknown';
  if (typeof code === 'string') return code;
  return stringAt(error, 'name') ?? 'unknown';
}

/** The bucket a file or bucket belongs to: a file's `bucket`, or the bucket itself. */
function bucketOf(self: unknown): unknown {
  const owner: unknown = isObject(self) ? Reflect.get(self, 'bucket') : undefined;
  return isObject(owner) ? owner : self;
}

/** The `@google-cloud/storage` client a file or bucket belongs to. */
function clientOf(self: unknown): unknown {
  const bucket = bucketOf(self);
  return isObject(bucket) ? Reflect.get(bucket, 'storage') : undefined;
}

/** The project the client was given or has resolved, without asking it to resolve one. */
function projectIdOf(client: unknown): string | undefined {
  const projectId = stringAt(client, 'projectId');
  return projectId === UNRESOLVED_PROJECT ? undefined : projectId;
}

/** The object `Bucket.upload` writes: its `destination`, else the local file's name. */
function uploadName(args: readonly unknown[]): string | undefined {
  const options = args[1];
  const destination: unknown = isObject(options) ? Reflect.get(options, 'destination') : undefined;
  if (typeof destination === 'string') return destination;
  const named = stringAt(destination, 'name');
  if (named !== undefined) return named;
  return typeof args[0] === 'string' ? basename(args[0]) : undefined;
}

/** The object a call names: a file's own name, or the one an upload writes. None for the other bucket calls. */
function pathOf(name: string, args: readonly unknown[], self: unknown): string | undefined {
  if (name === 'upload') return uploadName(args);
  const isFile = bucketOf(self) !== self;
  return isFile ? stringAt(self, 'name') : undefined;
}

/** One call's context, read off the SDK's own objects: its project, bucket and object name. */
function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const projectId = projectIdOf(clientOf(self));
  const bucket = stringAt(bucketOf(self), 'name');
  const path = pathOf(name, args, self);
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(path === undefined ? {} : { path }),
  };
}

function calls(...names: string[]): AdminMethod[] {
  return names.map((name) => ({ name, context: (_name, args, self) => contextOf(name, args, self), codeOf: adminCodeOf, throwsLocally: true }));
}

/** The classes the row patches and the methods of each. */
const CLASSES: readonly { readonly className: string; readonly methods: readonly AdminMethod[] }[] = [
  { className: 'File', methods: calls('save', 'download', 'delete', 'exists', 'getMetadata', 'setMetadata', 'copy', 'move') },
  { className: 'Bucket', methods: calls('getFiles', 'upload', 'deleteFiles') },
];

/** Where the records go and which gate the calls pass. */
export interface AdminStorageRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

/** Each client's stand-in Admin app, as the gate reads it. */
const apps = new WeakMap<object, AdminApp>();

/**
 * The Admin app a call belongs to, for the gate. firebase-admin gives
 * `@google-cloud/storage` a project only with a `cert()` credential. A
 * client with none, such as one on application default credentials, gets a
 * credential that runs the client's own `getProjectId` (its auth client's
 * lookup), which sends no Storage request.
 */
function appOf(self: unknown): AdminApp {
  const client = clientOf(self);
  if (!isObject(client)) return { options: {} };
  const known = apps.get(client);
  if (known !== undefined) return known;
  const projectId = projectIdOf(client);
  const credential = { getProjectId: () => Promise.resolve(Reflect.apply(Reflect.get(client, 'getProjectId') as () => unknown, client, [])) };
  const app: AdminApp = { options: projectId === undefined ? { credential } : { projectId } };
  apps.set(client, app);
  return app;
}

/**
 * Gives `prototype` its own copy of each of `names` it inherits, so the
 * patcher, which leaves inherited methods alone, wraps it for this class
 * only. `File` inherits `exists` and `getMetadata` from `ServiceObject`,
 * which `Bucket` and the other classes share.
 */
function ownInherited(prototype: object, names: readonly string[]): void {
  for (const name of names) {
    const inherited: unknown = Reflect.get(prototype, name);
    const isInherited = !Object.hasOwn(prototype, name) && typeof inherited === 'function';
    if (isInherited) Object.defineProperty(prototype, name, { value: inherited, writable: true, configurable: true });
  }
}

function prototypeOf(sdk: unknown, className: string): object | undefined {
  const isModule = isObject(sdk) || typeof sdk === 'function';
  const defined: unknown = isModule ? Reflect.get(sdk, className) : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  return isObject(prototype) ? prototype : undefined;
}

/**
 * Patches the real `@google-cloud/storage` module `sdk` once. Later calls
 * change nothing. `_entryFile` is where it loaded from, as the other rows take it.
 */
export function observeAdminStorage(sdk: unknown, _entryFile: string, row: AdminStorageRow): void {
  const adminRow: AdminRow = { module: ADMIN_STORAGE_MODULE, observer: row.observer, gate: row.gate, appOf };
  for (const { className, methods } of CLASSES) {
    const prototype = prototypeOf(sdk, className);
    if (prototype !== undefined) ownInherited(prototype, methods.map((method) => method.name));
    patchAdminClass(prototype, className, methods, adminRow);
  }
}
