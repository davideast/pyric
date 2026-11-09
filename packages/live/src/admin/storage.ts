/**
 * The Admin Storage row: patches the classes of the real
 * `@google-cloud/storage` that firebase-admin loads (`patch.ts`), so each
 * Admin call makes a record named `<Class>.<method>` with the bucket and
 * object name it touched, and production's code in the client SDK's spelling
 * (HTTP 404 is `storage/object-not-found`).
 *
 * Observed: `File` `save`, `createWriteStream`, `download`, `delete`, `exists`,
 * `getMetadata`, `setMetadata`, `copy` and `move`; `Bucket` `getFiles`,
 * `upload` and `deleteFiles`. A call the SDK makes inside another, as `exists`
 * reads the metadata, `save` opens `createWriteStream`, and `move` copies then
 * deletes, is part of the outer record.
 *
 * A call in the SDK's callback form (`file.download((error, bytes) => ...)`)
 * is recorded when it settles, and its callback gets the SDK's answer or the
 * gate's refusal.
 *
 * A record never carries an object's bytes.
 */
import { basename } from 'node:path';
import { Writable } from 'node:stream';
import type { CallContext, LiveCallRecord, LiveObserver } from '../observe.js';
import { attachSessionData, type ObservedSessionDelta } from '../session-data.js';
import {
  isObservingAdminCall,
  keepShape,
  patchAdminClass,
  runInsideAdminCall,
  type AdminMethod,
  type AdminRow,
} from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';
import {
  adminStorageRejection,
  adminStorageResult,
  adminStorageSessionContext,
  captureAdminWriteStreamDelta,
  extractAdminWriteOptionsMetadata,
  numericByteLengthOf,
} from './storage-session-capture.js';

/** The module an Admin Storage record names: the load the row patches. */
export const ADMIN_STORAGE_MODULE = '@google-cloud/storage';

const WRITE_STREAM_PATCHED = Symbol.for('pyric.live.admin.storage.writeStream');

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
  if (!isObject(subject)) return undefined;
  const value: unknown = Reflect.get(subject, field);
  if (typeof value === 'string') return value;
  return undefined;
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
  if (isObject(owner)) return owner;
  return self;
}

/** The `@google-cloud/storage` client a file or bucket belongs to. */
function clientOf(self: unknown): unknown {
  const bucket = bucketOf(self);
  if (!isObject(bucket)) return undefined;
  return Reflect.get(bucket, 'storage');
}

/** The project the client was given or has resolved, without asking it to resolve one. */
function projectIdOf(client: unknown): string | undefined {
  const projectId = stringAt(client, 'projectId');
  if (projectId === UNRESOLVED_PROJECT) return undefined;
  return projectId;
}

/** The object `Bucket.upload` writes: its `destination`, else the local file's name. */
function uploadName(args: readonly unknown[]): string | undefined {
  const options = args[1];
  const destination: unknown = isObject(options) ? Reflect.get(options, 'destination') : undefined;
  if (typeof destination === 'string') return destination;
  const named = stringAt(destination, 'name');
  if (named !== undefined) return named;
  if (typeof args[0] === 'string') return basename(args[0]);
  return undefined;
}

/** The object a call names: a file's own name, or the one an upload writes. None for the other bucket calls. */
function pathOf(name: string, args: readonly unknown[], self: unknown): string | undefined {
  if (name === 'upload') return uploadName(args);
  const isFile = bucketOf(self) !== self;
  if (!isFile) return undefined;
  return stringAt(self, 'name');
}

/** One call's context, read off the SDK's own objects: its project, bucket and object name. */
function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const projectId = projectIdOf(clientOf(self));
  const bucket = stringAt(bucketOf(self), 'name');
  const path = pathOf(name, args, self);
  const session = adminStorageSessionContext(name, bucket, path, args, self);
  const context: {
    projectId?: string;
    bucket?: string;
    path?: string;
    sessionData?: ObservedSessionDelta;
  } = {};
  if (projectId !== undefined) context.projectId = projectId;
  if (bucket !== undefined) context.bucket = bucket;
  if (path !== undefined) context.path = path;
  if (session.sessionData !== undefined) context.sessionData = session.sessionData;
  return context;
}

function calls(...names: string[]): AdminMethod[] {
  return names.map((name) => ({
    name,
    context: (_name, args, self) => contextOf(name, args, self),
    resultOf: adminStorageResult,
    rejectionOf: adminStorageRejection,
    codeOf: adminCodeOf,
    throwsLocally: true,
    nodeCallback: true,
  }));
}

/** The classes the row patches and the methods of each. */
const CLASSES: readonly { readonly className: string; readonly methods: readonly AdminMethod[] }[] = [
  {
    className: 'File',
    methods: calls('save', 'download', 'delete', 'exists', 'getMetadata', 'setMetadata', 'copy', 'move'),
  },
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
  const credential = {
    getProjectId: () =>
      Promise.resolve(Reflect.apply(Reflect.get(client, 'getProjectId') as () => unknown, client, [])),
  };
  let appOptions: AdminApp['options'];
  if (projectId === undefined) {
    appOptions = { credential };
  } else {
    appOptions = { projectId };
  }
  const app: AdminApp = { options: appOptions };
  apps.set(client, app);
  return app;
}

function emitWriteStreamRecord(
  observer: LiveObserver,
  base: { projectId?: string; bucket?: string; path?: string },
  outcome: 'resolved' | 'rejected',
  writtenBytes: number,
  sessionData: ObservedSessionDelta | undefined,
  error?: unknown,
): void {
  const record: {
    module: string;
    sdk: 'admin';
    name: string;
    outcome: 'resolved' | 'rejected';
    projectId?: string;
    bucket?: string;
    path?: string;
    code?: string;
    usage?: { uploadedBytes: number };
  } = {
    module: ADMIN_STORAGE_MODULE,
    sdk: 'admin',
    name: 'File.createWriteStream',
    outcome,
  };
  if (base.projectId !== undefined) record.projectId = base.projectId;
  if (base.bucket !== undefined) record.bucket = base.bucket;
  if (base.path !== undefined) record.path = base.path;
  if (outcome === 'resolved') {
    record.usage = { uploadedBytes: writtenBytes };
  } else {
    record.code = adminCodeOf(error);
  }
  const finalized = record as LiveCallRecord;
  if (outcome === 'resolved') {
    attachSessionData(finalized, sessionData);
  }
  try {
    observer(finalized);
  } catch {
    // Observer failures never alter stream settlement.
  }
}

const STANDARD_WRITABLE_EVENTS: ReadonlySet<string | symbol> = new Set([
  'close',
  'drain',
  'error',
  'finish',
  'newListener',
  'pipe',
  'prefinish',
  'removeListener',
  'unpipe',
]);

function patchCreateWriteStream(prototype: object | undefined, adminRow: AdminRow): void {
  if (prototype === undefined || Object.hasOwn(prototype, WRITE_STREAM_PATCHED)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createWriteStream');
  const real = descriptor?.value as unknown;
  if (typeof real !== 'function') return;
  const realFn = real as (this: unknown, ...args: unknown[]) => Writable;

  const wrapped = keepShape(function adminCreateWriteStream(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) {
      return Reflect.apply(realFn, this, args);
    }
    const self = this;
    const projectId = projectIdOf(clientOf(self));
    const bucket = stringAt(bucketOf(self), 'name');
    const path = pathOf('createWriteStream', args, self);
    const optionsMeta = extractAdminWriteOptionsMetadata(args[0]);
    const base: { projectId?: string; bucket?: string; path?: string } = {};
    if (projectId !== undefined) base.projectId = projectId;
    if (bucket !== undefined) base.bucket = bucket;
    if (path !== undefined) base.path = path;

    let writtenBytes = 0;
    let reachedSdk = false;
    let settled = false;
    let underlying: Writable | undefined;
    const wantedCustomEvents = new Set<string | symbol>(['response']);
    const bridgedCustomEvents = new Set<string | symbol>();

    const recordOnce = (outcome: 'resolved' | 'rejected', error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (outcome === 'rejected' && !reachedSdk) return;
      let delta: ObservedSessionDelta | undefined;
      if (outcome === 'resolved') {
        delta = captureAdminWriteStreamDelta(bucket, path, self, writtenBytes, optionsMeta);
      }
      emitWriteStreamRecord(adminRow.observer, base, outcome, writtenBytes, delta, error);
    };

    const toError = (err: unknown): Error => {
      if (err instanceof Error) return err;
      return new Error(String(err));
    };

    const proxy: Writable = new Writable({
      write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const chunkLen = numericByteLengthOf(chunk);
        if (chunkLen !== undefined) writtenBytes += chunkLen;
        ensureUnderlying()
          .then((target) => {
            target.write(chunk, encoding, callback);
          })
          .catch((err: unknown) => {
            callback(toError(err));
          });
      },
      final(callback: (error?: Error | null) => void) {
        ensureUnderlying()
          .then((target) => {
            const onFinish = (): void => {
              target.removeListener('error', onError);
              recordOnce('resolved');
              callback();
            };
            const onError = (err: unknown): void => {
              target.removeListener('finish', onFinish);
              recordOnce('rejected', err);
              callback(toError(err));
            };
            target.once('finish', onFinish);
            target.once('error', onError);
            target.end();
          })
          .catch((err: unknown) => {
            callback(toError(err));
          });
      },
      destroy(error: Error | null, callback: (error: Error | null) => void) {
        if (error !== null) recordOnce('rejected', error);
        if (underlying !== undefined && !underlying.destroyed) {
          underlying.destroy(error ?? undefined);
        }
        callback(error);
      },
    });

    function bridgeCustomEvent(target: Writable, event: string | symbol): void {
      if (bridgedCustomEvents.has(event)) return;
      bridgedCustomEvents.add(event);
      target.on(event, (...eventArgs: unknown[]) => {
        proxy.emit(event, ...eventArgs);
      });
    }

    proxy.on('newListener', (event: string | symbol) => {
      if (STANDARD_WRITABLE_EVENTS.has(event)) return;
      wantedCustomEvents.add(event);
      if (underlying !== undefined) {
        bridgeCustomEvent(underlying, event);
      }
    });

    let openPromise: Promise<Writable> | undefined;
    function ensureUnderlying(): Promise<Writable> {
      if (openPromise !== undefined) return openPromise;
      openPromise = adminRow.gate(adminRow.appOf(self), () =>
        runInsideAdminCall(() => {
          const created = Reflect.apply(realFn, self, args);
          reachedSdk = true;
          underlying = created;
          for (const event of wantedCustomEvents) {
            bridgeCustomEvent(created, event);
          }
          created.on('error', (err: unknown) => {
            recordOnce('rejected', err);
            if (!proxy.destroyed) {
              proxy.destroy(toError(err));
            }
          });
          return created;
        }),
      );
      return openPromise;
    }

    // Trigger gate check immediately so project refusals surface even on empty streams.
    ensureUnderlying().catch((err: unknown) => {
      if (!proxy.destroyed) {
        proxy.destroy(toError(err));
      }
    });

    return proxy;
  }, real as (this: unknown, ...args: unknown[]) => unknown);

  Object.defineProperty(prototype, 'createWriteStream', { ...descriptor, value: wrapped });
  Object.defineProperty(prototype, WRITE_STREAM_PATCHED, { value: true });
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
    if (isInherited) {
      Object.defineProperty(prototype, name, { value: inherited, writable: true, configurable: true });
    }
  }
}

function prototypeOf(sdk: unknown, className: string): object | undefined {
  const isModule = isObject(sdk) || typeof sdk === 'function';
  if (!isModule) return undefined;
  const defined: unknown = Reflect.get(sdk, className);
  if (typeof defined !== 'function') return undefined;
  const prototype: unknown = Reflect.get(defined, 'prototype');
  if (!isObject(prototype)) return undefined;
  return prototype;
}

/**
 * Patches the real `@google-cloud/storage` module `sdk` once. Later calls
 * change nothing. `_entryFile` is where it loaded from, as the other rows take it.
 */
export function observeAdminStorage(sdk: unknown, _entryFile: string, row: AdminStorageRow): void {
  const adminRow: AdminRow = { module: ADMIN_STORAGE_MODULE, observer: row.observer, gate: row.gate, appOf };
  const filePrototype = prototypeOf(sdk, 'File');
  patchCreateWriteStream(filePrototype, adminRow);
  for (const { className, methods } of CLASSES) {
    const prototype = prototypeOf(sdk, className);
    if (prototype !== undefined) ownInherited(prototype, methods.map((method) => method.name));
    patchAdminClass(prototype, className, methods, adminRow);
  }
}
