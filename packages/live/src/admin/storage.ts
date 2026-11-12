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
import { PassThrough, Readable, Writable } from 'node:stream';
import type { CallContext, LiveCallRecord, LiveObserver } from '../observe.js';
import { liveProjectRefusal } from '../refusal.js';
import { attachSessionData, type ObservedSessionDelta } from '../session-data.js';
import {
  isObservingAdminCall,
  keepShape,
  nodeCallbackOf,
  patchAdminClass,
  runInsideAdminCall,
  type AdminMethod,
  type AdminRow,
} from './patch.js';
import { failClosedGate, UNREAD_APP, type AdminApp, type AdminProjectGate } from './project-gate.js';
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
const READ_STREAM_PATCHED = Symbol.for('pyric.live.admin.storage.readStream');
const EXTRA_TARGETS_PATCHED = Symbol.for('pyric.live.admin.storage.extraTargets');
const DEFAULT_BUCKET = /^(?:gs:\/\/)?([a-z0-9-]+)\.(?:appspot\.com|firebasestorage\.app)\/?$/i;

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
    methods: calls(
      'save',
      'download',
      'delete',
      'exists',
      'getMetadata',
      'setMetadata',
      'copy',
      'move',
      'moveFileAtomic',
      'rename',
      'createResumableUpload',
      'makePublic',
      'makePrivate',
      'isPublic',
      'restore',
    ),
  },
  {
    className: 'Bucket',
    methods: calls('getFiles', 'upload', 'deleteFiles', 'combine', 'delete', 'exists', 'getMetadata', 'setMetadata'),
  },
];

function bucketProjectRefusal(
  callName: string,
  bucketName: string | undefined,
  observer: LiveObserver,
): Error | null {
  const hostProjectId = observer.hostProjectId;
  if (hostProjectId === undefined || bucketName === undefined) return null;
  const matched = DEFAULT_BUCKET.exec(bucketName.trim())?.[1]?.toLowerCase();
  if (matched === undefined || matched === hostProjectId) return null;
  return liveProjectRefusal(
    callName,
    { field: 'bucket', appProjectId: matched, hostProjectId },
    observer.client ?? 'node',
  );
}

function isStorageEntity(value: unknown): boolean {
  if (!isObject(value)) return false;
  return isObject(Reflect.get(value, 'bucket')) || isObject(Reflect.get(value, 'storage'));
}

function targetBucketName(target: unknown): string | undefined {
  if (typeof target === 'string') {
    if (!target.startsWith('gs://')) return undefined;
    const rest = target.slice('gs://'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.slice(0, slash);
  }
  if (isStorageEntity(target)) {
    return stringAt(bucketOf(target), 'name');
  }
  return undefined;
}

async function checkExtraStorageTargets(
  className: string,
  methodName: string,
  args: readonly unknown[],
  adminRow: AdminRow,
): Promise<void> {
  const callName = `${className}.${methodName}`;
  const targets =
    className === 'Bucket' && methodName === 'combine'
      ? [...(Array.isArray(args[0]) ? args[0] : []), args[1]]
      : [args[0]];
  for (const target of targets) {
    const refusal = bucketProjectRefusal(callName, targetBucketName(target), adminRow.observer);
    if (refusal !== null) throw refusal;
    if (isStorageEntity(target)) {
      await adminRow.gate(adminRow.appOf(target), () => undefined);
    }
  }
}

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
  if (!isObject(client)) return UNREAD_APP;
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

function emitStreamRecord(
  observer: LiveObserver,
  name: 'File.createWriteStream' | 'File.createReadStream',
  base: { projectId?: string; bucket?: string; path?: string },
  outcome: 'resolved' | 'rejected',
  usage: { uploadedBytes: number } | { downloadedBytes: number } | undefined,
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
    usage?: { uploadedBytes?: number; downloadedBytes?: number };
  } = {
    module: ADMIN_STORAGE_MODULE,
    sdk: 'admin',
    name,
    outcome,
  };
  if (base.projectId !== undefined) record.projectId = base.projectId;
  if (base.bucket !== undefined) record.bucket = base.bucket;
  if (base.path !== undefined) record.path = base.path;
  if (outcome === 'resolved') {
    if (usage !== undefined) record.usage = usage;
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
      emitStreamRecord(
        adminRow.observer,
        'File.createWriteStream',
        base,
        outcome,
        { uploadedBytes: writtenBytes },
        delta,
        error,
      );
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
      openPromise = adminRow.gate(adminRow.appOf(self), () => {
        const refusal = bucketProjectRefusal('File.createWriteStream', bucket, adminRow.observer);
        if (refusal !== null) throw refusal;
        return runInsideAdminCall(() => {
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
        });
      });
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

function patchCreateReadStream(prototype: object | undefined, adminRow: AdminRow): void {
  if (prototype === undefined || Object.hasOwn(prototype, READ_STREAM_PATCHED)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createReadStream');
  const real = descriptor?.value as unknown;
  if (typeof real !== 'function') return;
  const realFn = real as (this: unknown, ...args: unknown[]) => Readable;

  const wrapped = keepShape(function adminCreateReadStream(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) {
      return Reflect.apply(realFn, this, args);
    }
    const self = this;
    const projectId = projectIdOf(clientOf(self));
    const bucket = stringAt(bucketOf(self), 'name');
    const path = pathOf('createReadStream', args, self);
    const base: { projectId?: string; bucket?: string; path?: string } = {};
    if (projectId !== undefined) base.projectId = projectId;
    if (bucket !== undefined) base.bucket = bucket;
    if (path !== undefined) base.path = path;

    let downloadedBytes = 0;
    let reachedSdk = false;
    let settled = false;
    let underlying: Readable | undefined;

    const toError = (err: unknown): Error => {
      if (err instanceof Error) return err;
      return new Error(String(err));
    };

    const recordOnce = (outcome: 'resolved' | 'rejected', error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (outcome === 'rejected' && !reachedSdk) return;
      emitStreamRecord(
        adminRow.observer,
        'File.createReadStream',
        base,
        outcome,
        { downloadedBytes },
        undefined,
        error,
      );
    };

    const proxy = new PassThrough();
    proxy.on('close', () => {
      if (underlying !== undefined && !underlying.destroyed) {
        underlying.destroy();
      }
    });

    adminRow
      .gate(adminRow.appOf(self), () => {
        const refusal = bucketProjectRefusal('File.createReadStream', bucket, adminRow.observer);
        if (refusal !== null) throw refusal;
        if (proxy.destroyed) return undefined;
        return runInsideAdminCall(() => {
          const created = Reflect.apply(realFn, self, args);
          reachedSdk = true;
          underlying = created;
          created.on('response', (...eventArgs: unknown[]) => {
            proxy.emit('response', ...eventArgs);
          });
          created.on('data', (chunk: unknown) => {
            const chunkLen = numericByteLengthOf(chunk);
            if (chunkLen !== undefined) downloadedBytes += chunkLen;
          });
          created.on('end', () => {
            recordOnce('resolved');
          });
          created.on('error', (err: unknown) => {
            recordOnce('rejected', err);
            if (!proxy.destroyed) {
              proxy.destroy(toError(err));
            }
          });
          created.pipe(proxy);
          return created;
        });
      })
      .catch((err: unknown) => {
        if (!proxy.destroyed) {
          proxy.destroy(toError(err));
        }
      });

    return proxy;
  }, real as (this: unknown, ...args: unknown[]) => unknown);

  Object.defineProperty(prototype, 'createReadStream', { ...descriptor, value: wrapped });
  Object.defineProperty(prototype, READ_STREAM_PATCHED, { value: true });
}

function patchExtraStorageTargets(
  prototype: object | undefined,
  className: string,
  methodNames: readonly string[],
  adminRow: AdminRow,
): void {
  if (prototype === undefined || Object.hasOwn(prototype, EXTRA_TARGETS_PATCHED)) return;
  for (const methodName of methodNames) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    const patched = descriptor?.value as unknown;
    if (typeof patched !== 'function') continue;
    const patchedFn = patched as (this: unknown, ...args: unknown[]) => unknown;
    const guarded = keepShape(function adminExtraTargetsCall(this: unknown, ...args: unknown[]): unknown {
      if (isObservingAdminCall()) {
        return Reflect.apply(patchedFn, this, args);
      }
      const cb = nodeCallbackOf(args);
      if (cb !== undefined) {
        const pending = checkExtraStorageTargets(className, methodName, cb.before, adminRow).then(() =>
          Reflect.apply(patchedFn, this, cb.before),
        );
        pending.then(
          (value: unknown) => {
            let results: unknown[] = [];
            if (Array.isArray(value)) results = value;
            else if (value !== undefined) results = [value];
            process.nextTick(() => Reflect.apply(cb.callback, undefined, [null, ...results]));
          },
          (error: unknown) => {
            process.nextTick(() => Reflect.apply(cb.callback, undefined, [error]));
          },
        );
        return undefined;
      }
      return checkExtraStorageTargets(className, methodName, args, adminRow).then(() =>
        Reflect.apply(patchedFn, this, args),
      );
    }, patchedFn);
    Object.defineProperty(prototype, methodName, { ...descriptor, value: guarded });
  }
  Object.defineProperty(prototype, EXTRA_TARGETS_PATCHED, { value: true });
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
  const gate = failClosedGate(row.gate, 'Storage');
  const adminRow: AdminRow = { module: ADMIN_STORAGE_MODULE, observer: row.observer, gate, appOf };
  const filePrototype = prototypeOf(sdk, 'File');
  const bucketPrototype = prototypeOf(sdk, 'Bucket');
  patchCreateWriteStream(filePrototype, adminRow);
  patchCreateReadStream(filePrototype, adminRow);
  for (const { className, methods } of CLASSES) {
    const prototype = prototypeOf(sdk, className);
    if (prototype !== undefined) ownInherited(prototype, methods.map((method) => method.name));
    patchAdminClass(prototype, className, methods, adminRow);
  }
  patchExtraStorageTargets(filePrototype, 'File', ['copy', 'move', 'moveFileAtomic', 'rename'], adminRow);
  patchExtraStorageTargets(bucketPrototype, 'Bucket', ['combine'], adminRow);
}
