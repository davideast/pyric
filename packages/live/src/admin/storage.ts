/**
 * The Admin Storage row: patches the classes of the real
 * `@google-cloud/storage` that firebase-admin loads (`patch.ts`), so every
 * Admin Storage RPC passes `AdminProjectGate` (and cross-project bucket,
 * `HmacKey`, `userProject`, and per-call option checks) before any request and
 * makes a record named `<Class>.<method>` with the bucket and object name it
 * touched, and production's code in the client SDK's spelling.
 *
 * A record never carries an object's bytes.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type { CallContext, LiveObserver } from '../observe.js';
import { liveAdminProjectRefusal } from '../refusal.js';
import type { ObservedSessionDelta } from '../session-data.js';
import {
  markAdminMethodGated,
  patchAdminClass,
  type AdminMethod,
  type AdminRow,
} from './patch.js';
import { failClosedGate, UNREAD_APP, type AdminApp, type AdminProjectGate } from './project-gate.js';
import {
  entryRequire,
  gateInstanceStreamProperty,
  gatePrototypeMethods,
  patchObjectStreamMethod,
  patchVoidUploadMethod,
  withExportedClass,
} from './prototype-gate.js';
import {
  assertStorageCallOptionsAllowed,
  bucketProjectRefusal,
  gateMakeAuthenticatedRequest,
  hmacKeyProjectOf,
  patchAdminStorageUtils,
  patchSetUserProject,
  patchStorageCallChecks,
  userProjectOf,
} from './storage-gates.js';
import {
  adminStorageRejection,
  adminStorageResult,
  adminStorageSessionContext,
} from './storage-session-capture.js';
import {
  patchCreateReadStream,
  patchCreateWriteStream,
  type StorageStreamBase,
} from './storage-streams.js';

/** The module an Admin Storage record names: the load the row patches. */
export const ADMIN_STORAGE_MODULE = '@google-cloud/storage';

const SUBHANDLES_TRACKED = Symbol.for('pyric.live.admin.storage.subhandlesTracked');
const ADMIN_WRAPPER_TRACKED = Symbol.for('pyric.live.admin.storage.adminWrapperTracked');
const UNRESOLVED_PROJECT = '{{projectId}}';

/** HTTP statuses in the client SDK's spelling. */
const HTTP_CODES: ReadonlyMap<number, string> = new Map([
  [401, 'storage/unauthenticated'],
  [403, 'storage/unauthorized'],
  [404, 'storage/object-not-found'],
  [412, 'storage/precondition-failed'],
  [429, 'storage/quota-exceeded'],
]);

const LOCAL_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  Service: new Set(['getRequestInterceptors', 'getProjectId', 'getProjectIdAsync']),
  ServiceObject: new Set(['getRequestInterceptors']),
  Storage: new Set(['bucket', 'channel', 'hmacKey']),
  Bucket: new Set(['file', 'notification', 'getId', 'disableAutoRetryConditionallyIdempotent_']),
  File: new Set([
    'shouldRetryBasedOnPreconditionAndIdempotencyStrat', 'setEncryptionKey',
    'publicUrl', 'disableAutoRetryConditionallyIdempotent_', 'getBufferFromReadable',
  ]),
  Acl: new Set(['makeAclObject_']),
  Iam: new Set(),
  HmacKey: new Set(),
  Channel: new Set(),
  Notification: new Set(),
  TransferManager: new Set(['getPathsFromDirectory']),
};

const ownerBySubHandle = new WeakMap<object, object>();
const firebaseAppByClient = new WeakMap<object, object>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringAt(subject: unknown, field: string): string | undefined {
  if (!isObject(subject)) return undefined;
  const value: unknown = Reflect.get(subject, field);
  return typeof value === 'string' ? value : undefined;
}

/** A failure's code: an HTTP status in the client SDK's spelling, else its string `code`, else its name. */
function adminCodeOf(error: unknown): string {
  const code: unknown = isObject(error) ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'number') return HTTP_CODES.get(code) ?? 'storage/unknown';
  if (typeof code === 'string') return code;
  return stringAt(error, 'name') ?? 'unknown';
}

function isStorageClient(value: unknown): value is object {
  if (!isObject(value)) return false;
  if (typeof Reflect.get(value, 'getBuckets') === 'function' || 'authClient' in value) {
    return true;
  }
  if (isObject(Reflect.get(value, 'storage')) || isObject(Reflect.get(value, 'bucket'))) {
    return false;
  }
  return (
    typeof Reflect.get(value, 'projectId') === 'string' ||
    typeof Reflect.get(value, 'getProjectId') === 'function'
  );
}

function isBucketInstance(value: unknown): value is object {
  if (!isObject(value) || isObject(Reflect.get(value, 'bucket'))) return false;
  return isStorageClient(Reflect.get(value, 'storage')) && typeof Reflect.get(value, 'name') === 'string';
}

function resolveOwner(self: unknown): unknown {
  let current: unknown = self;
  while (isObject(current) && ownerBySubHandle.has(current)) {
    current = ownerBySubHandle.get(current);
  }
  return current;
}

/** The bucket a handle belongs to, or `undefined` for client-level handles (`Storage`, `Channel`, `HmacKey`). */
function bucketOf(self: unknown): object | undefined {
  const target = resolveOwner(self);
  if (!isObject(target) || isStorageClient(target)) return undefined;
  if (isBucketInstance(target)) return target;
  const directBucket: unknown = Reflect.get(target, 'bucket');
  if (isBucketInstance(directBucket)) return directBucket;
  const parent: unknown = Reflect.get(target, 'parent');
  if (isBucketInstance(parent)) return parent;
  return undefined;
}

/** The `@google-cloud/storage` `Storage` client any Storage handle belongs to. */
function clientOf(self: unknown): object | undefined {
  const target = resolveOwner(self);
  if (!isObject(target)) return undefined;
  if (isStorageClient(target)) return target;
  const directStorage: unknown = Reflect.get(target, 'storage');
  if (isStorageClient(directStorage)) return directStorage;
  const bucket = bucketOf(target);
  if (bucket !== undefined) {
    const bucketStorage: unknown = Reflect.get(bucket, 'storage');
    if (isStorageClient(bucketStorage)) return bucketStorage;
  }
  const parent: unknown = Reflect.get(target, 'parent');
  if (isStorageClient(parent)) return parent;
  return undefined;
}

/** The project the client or its owning `firebase-admin` `App` was given, without asking ADC to resolve one. */
function projectIdOf(client: unknown): string | undefined {
  if (isObject(client)) {
    const firebaseApp = firebaseAppByClient.get(client);
    const appOptions: unknown = isObject(firebaseApp) ? Reflect.get(firebaseApp, 'options') : undefined;
    const appProjectId = stringAt(appOptions, 'projectId');
    if (appProjectId !== undefined && appProjectId !== '') return appProjectId;
  }
  const projectId = stringAt(client, 'projectId');
  if (projectId === UNRESOLVED_PROJECT || projectId === '') return undefined;
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

/** The object a call names: a file's own name, or the one an upload writes. */
function pathOf(name: string, args: readonly unknown[], self: unknown): string | undefined {
  if (name === 'upload') return uploadName(args);
  const isFile = isObject(self) && isBucketInstance(Reflect.get(self, 'bucket'));
  if (!isFile) return undefined;
  return stringAt(self, 'name');
}

function streamBaseOf(methodName: string, args: readonly unknown[], self: unknown): StorageStreamBase {
  const projectId = projectIdOf(clientOf(self));
  const bucket = stringAt(bucketOf(self), 'name');
  const path = pathOf(methodName, args, self);
  const base: StorageStreamBase = {};
  if (projectId !== undefined) base.projectId = projectId;
  if (bucket !== undefined) base.bucket = bucket;
  if (path !== undefined) base.path = path;
  return base;
}

function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const base = streamBaseOf(name, args, self);
  const session = adminStorageSessionContext(name, base.bucket, base.path, args, self);
  const context: {
    projectId?: string;
    bucket?: string;
    path?: string;
    sessionData?: ObservedSessionDelta;
  } = { ...base };
  if (session.sessionData !== undefined) context.sessionData = session.sessionData;
  return context;
}

function streamContextOf(fullName: string, args: readonly unknown[], self: unknown): CallContext {
  const dot = fullName.indexOf('.');
  const method = dot === -1 ? fullName : fullName.slice(dot + 1);
  return streamBaseOf(method, args, self);
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

const FILE_INHERITED = ['delete', 'exists', 'get', 'getMetadata', 'setMetadata'] as const;
const BUCKET_INHERITED = ['create', 'delete', 'exists', 'get', 'getMetadata', 'setMetadata'] as const;

const CLASSES: readonly {
  readonly className: string;
  readonly inherited: readonly string[];
  readonly extraTargetMethods: ReadonlySet<string>;
  readonly methods: readonly AdminMethod[];
}[] = [
  {
    className: 'File',
    inherited: FILE_INHERITED,
    extraTargetMethods: new Set(['copy', 'move', 'moveFileAtomic', 'rename']),
    methods: calls(
      'save', 'download', 'delete', 'exists', 'get', 'getMetadata', 'setMetadata',
      'copy', 'move', 'moveFileAtomic', 'rename', 'createResumableUpload',
      'makePublic', 'makePrivate', 'isPublic', 'restore',
    ),
  },
  {
    className: 'Bucket',
    inherited: BUCKET_INHERITED,
    extraTargetMethods: new Set(['combine']),
    methods: calls(
      'getFiles', 'upload', 'deleteFiles', 'combine', 'create', 'delete', 'exists',
      'get', 'getMetadata', 'setMetadata', 'makePublic', 'makePrivate', 'restore',
      'createNotification', 'getNotifications', 'createChannel',
    ),
  },
  {
    className: 'Storage',
    inherited: [],
    extraTargetMethods: new Set(['createBucket']),
    methods: calls('createBucket', 'getBuckets', 'createHmacKey', 'getHmacKeys', 'getServiceAccount'),
  },
];

function isStorageEntity(value: unknown): boolean {
  if (!isObject(value)) return false;
  return isBucketInstance(value) || isBucketInstance(Reflect.get(value, 'bucket'));
}

/** Where the records go and which gate the calls pass. */
export interface AdminStorageRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

type StorageAdminApp = AdminApp & {
  readonly clientApp: AdminApp;
  readonly bucketName?: string;
  readonly overrideProjectId?: string;
  readonly userProject?: string;
};

const clientApps = new WeakMap<object, AdminApp>();

function clientAppOf(client: object): AdminApp {
  const known = clientApps.get(client);
  if (known !== undefined) return known;
  const firebaseApp = firebaseAppByClient.get(client);
  const appOptions: unknown = isObject(firebaseApp) ? Reflect.get(firebaseApp, 'options') : undefined;
  const appCred: unknown = isObject(appOptions) ? Reflect.get(appOptions, 'credential') : undefined;
  const hasAppCred =
    isObject(appCred) &&
    (typeof Reflect.get(appCred, 'projectId') === 'string' ||
      typeof Reflect.get(appCred, 'getProjectId') === 'function');
  const projectId = projectIdOf(client);
  const clientCredential = {
    getProjectId: () =>
      Promise.resolve(Reflect.apply(Reflect.get(client, 'getProjectId') as () => unknown, client, [])),
  };
  let options: AdminApp['options'];
  if (projectId !== undefined) {
    options = { projectId };
  } else if (hasAppCred) {
    options = { credential: appCred as object };
  } else {
    options = { credential: clientCredential };
  }
  const app: AdminApp = { options };
  clientApps.set(client, app);
  return app;
}

function appOf(self: unknown): AdminApp {
  const client = clientOf(self);
  if (!isObject(client)) return UNREAD_APP;
  const clientApp = clientAppOf(client);
  const bucket = bucketOf(self);
  const bucketName = stringAt(bucket, 'name');
  const overrideProjectId = hmacKeyProjectOf(self);
  const userProject = userProjectOf(resolveOwner(self), bucket);
  if (bucketName === undefined && overrideProjectId === undefined && userProject === undefined) {
    return clientApp;
  }
  const scoped: StorageAdminApp = {
    options: clientApp.options,
    clientApp,
    bucketName,
    overrideProjectId,
    userProject,
  };
  return scoped;
}

function trackAdminStorageWrapper(requiredBy: string | undefined): void {
  try {
    const adminStorageIndex = requiredBy ?? createRequire(import.meta.url).resolve('firebase-admin/storage');
    const wrapperMod: unknown = entryRequire(adminStorageIndex)('./storage');
    withExportedClass(wrapperMod, 'Storage', (wrapperCtor) => {
      const proto: unknown = Reflect.get(wrapperCtor, 'prototype');
      if (!isObject(proto) || Object.hasOwn(proto, ADMIN_WRAPPER_TRACKED)) return;
      const appsByWrapper = new WeakMap<object, unknown>();
      Object.defineProperty(proto, 'appInternal', {
        configurable: true,
        enumerable: true,
        get(this: unknown): unknown {
          return isObject(this) ? appsByWrapper.get(this) : undefined;
        },
        set(this: unknown, app: unknown): void {
          if (!isObject(this)) return;
          appsByWrapper.set(this, app);
          const client: unknown = Reflect.get(this, 'storageClient');
          if (isObject(client) && isObject(app)) {
            firebaseAppByClient.set(client, app);
            clientApps.delete(client);
          }
        },
      });
      Object.defineProperty(proto, ADMIN_WRAPPER_TRACKED, { value: true });
    });
  } catch {
    // Standalone `@google-cloud/storage` without `firebase-admin/storage` needs no wrapper link.
  }
}

function trackSubHandleProperties(prototype: object | undefined, fields: readonly string[]): void {
  if (prototype === undefined || Object.hasOwn(prototype, SUBHANDLES_TRACKED)) return;
  for (const field of fields) {
    const store = new WeakMap<object, unknown>();
    const bindSub = (owner: object, sub: unknown): void => {
      if (!isObject(sub)) return;
      ownerBySubHandle.set(sub, owner);
      const reqFn: unknown = Reflect.get(sub, 'request_');
      if (typeof reqFn === 'function') markAdminMethodGated(reqFn);
      const defaultAcl: unknown = Reflect.get(sub, 'default');
      if (isObject(defaultAcl)) {
        ownerBySubHandle.set(defaultAcl, owner);
        const defaultReq: unknown = Reflect.get(defaultAcl, 'request_');
        if (typeof defaultReq === 'function') markAdminMethodGated(defaultReq);
      }
    };
    Object.defineProperty(prototype, field, {
      configurable: true,
      enumerable: true,
      get(this: unknown): unknown {
        if (!isObject(this)) return undefined;
        const val = store.get(this);
        bindSub(this, val);
        return val;
      },
      set(this: unknown, val: unknown): void {
        if (!isObject(this)) return;
        store.set(this, val);
        bindSub(this, val);
      },
    });
  }
  Object.defineProperty(prototype, SUBHANDLES_TRACKED, { value: true });
}

function ownInherited(prototype: object, names: readonly string[]): void {
  for (const name of names) {
    const inherited: unknown = Reflect.get(prototype, name);
    const isInherited = !Object.hasOwn(prototype, name) && typeof inherited === 'function';
    if (isInherited) {
      Object.defineProperty(prototype, name, { value: inherited, writable: true, configurable: true });
    }
  }
}

function parentSdkPrototypeOf(prototype: object | undefined): object | undefined {
  if (prototype === undefined) return undefined;
  const parent: unknown = Object.getPrototypeOf(prototype);
  if (!isObject(parent) || parent === Object.prototype || parent === EventEmitter.prototype) return undefined;
  return parent;
}

function prototypeOf(sdk: unknown, className: string): object | undefined {
  const isModule = isObject(sdk) || typeof sdk === 'function';
  if (!isModule) return undefined;
  const defined: unknown = Reflect.get(sdk, className);
  if (typeof defined !== 'function') return undefined;
  const prototype: unknown = Reflect.get(defined, 'prototype');
  return isObject(prototype) ? prototype : undefined;
}

function aclPrototypeOf(entryFile: string): object | undefined {
  try {
    const loaded: unknown = entryRequire(entryFile)('./acl.js');
    const aclCtor: unknown = isObject(loaded) ? Reflect.get(loaded, 'Acl') : undefined;
    const proto: unknown = typeof aclCtor === 'function' ? Reflect.get(aclCtor, 'prototype') : undefined;
    return isObject(proto) ? proto : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Patches the real `@google-cloud/storage` module `sdk` once. Later calls
 * change nothing.
 */
export function observeAdminStorage(
  sdk: unknown,
  entryFile: string,
  row: AdminStorageRow,
  requiredBy?: string,
): void {
  trackAdminStorageWrapper(requiredBy);
  const baseGate = failClosedGate(row.gate, 'Storage');
  const gate: AdminProjectGate = (app, call) => {
    if (app === UNREAD_APP) return baseGate(UNREAD_APP, call);
    const typed = app as Partial<StorageAdminApp>;
    const rootApp = typed.clientApp ?? app;
    return baseGate(rootApp, () => {
      const hostProjectId = row.observer.hostProjectId;
      if (hostProjectId !== undefined) {
        for (const extraProj of [typed.overrideProjectId, typed.userProject]) {
          if (extraProj !== undefined && extraProj !== hostProjectId) {
            throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: extraProj, hostProjectId });
          }
        }
      }
      const refusal = bucketProjectRefusal('firebase-admin/storage', typed.bucketName, row.observer);
      if (refusal !== null) throw refusal;
      return call();
    });
  };
  patchAdminStorageUtils(requiredBy, gate, appOf);
  const adminRow: AdminRow = { module: ADMIN_STORAGE_MODULE, observer: row.observer, gate, appOf };
  const checkCallOpts = (callName: string, args: readonly unknown[]) => {
    assertStorageCallOptionsAllowed(callName, args, row.observer);
  };

  const storageProto = prototypeOf(sdk, 'Storage');
  const bucketProto = prototypeOf(sdk, 'Bucket');
  const fileProto = prototypeOf(sdk, 'File');
  const serviceProto = parentSdkPrototypeOf(storageProto);
  const serviceObjectProto = parentSdkPrototypeOf(bucketProto);

  trackSubHandleProperties(bucketProto, ['acl', 'iam']);
  trackSubHandleProperties(fileProto, ['acl']);
  gateMakeAuthenticatedRequest(serviceProto, gate, appOf, row.observer);

  const clientProjectOf = (self: unknown) => projectIdOf(clientOf(self));
  patchSetUserProject(bucketProto, row.observer, clientProjectOf);
  patchSetUserProject(fileProto, row.observer, clientProjectOf);

  const streamHelpers = {
    moduleName: ADMIN_STORAGE_MODULE,
    baseOf: streamBaseOf,
    codeOf: adminCodeOf,
    beforeCall: checkCallOpts,
  };
  patchCreateWriteStream(fileProto, adminRow, streamHelpers);
  patchCreateReadStream(fileProto, adminRow, streamHelpers);

  const objectStreamOpts = { observe: true, context: streamContextOf, codeOf: adminCodeOf, beforeCall: checkCallOpts };
  gateInstanceStreamProperty(storageProto, 'getBucketsStream', adminRow, 'Storage', objectStreamOpts);
  gateInstanceStreamProperty(storageProto, 'getHmacKeysStream', adminRow, 'Storage', objectStreamOpts);
  gateInstanceStreamProperty(bucketProto, 'getFilesStream', adminRow, 'Bucket', objectStreamOpts);

  patchObjectStreamMethod(serviceProto, 'requestStream', adminRow, 'Service', { beforeCall: checkCallOpts });
  patchObjectStreamMethod(serviceObjectProto, 'requestStream', adminRow, 'ServiceObject', { beforeCall: checkCallOpts });
  patchVoidUploadMethod(fileProto, 'startResumableUpload_', gate, appOf, checkCallOpts);
  patchVoidUploadMethod(fileProto, 'startSimpleUpload_', gate, appOf, checkCallOpts);

  gatePrototypeMethods(serviceProto, { className: 'Service', gate, appOf, allowlist: LOCAL_METHODS.Service!, nodeCallback: true, skipWhenObserving: true, beforeCall: checkCallOpts });
  gatePrototypeMethods(serviceObjectProto, { className: 'ServiceObject', gate, appOf, allowlist: LOCAL_METHODS.ServiceObject!, nodeCallback: true, skipWhenObserving: true, beforeCall: checkCallOpts });

  for (const { className, inherited, extraTargetMethods, methods } of CLASSES) {
    const prototype = prototypeOf(sdk, className);
    if (prototype !== undefined && inherited.length > 0) ownInherited(prototype, inherited);
    patchAdminClass(prototype, className, methods, adminRow);
    patchStorageCallChecks(prototype, className, methods.map((m) => m.name), extraTargetMethods, adminRow, isStorageEntity, bucketOf);
  }

  const protoTargets: readonly [object | undefined, string, boolean][] = [
    [storageProto, 'Storage', true],
    [bucketProto, 'Bucket', true],
    [fileProto, 'File', true],
    [aclPrototypeOf(entryFile), 'Acl', true],
    [prototypeOf(sdk, 'Iam'), 'Iam', true],
    [prototypeOf(sdk, 'HmacKey'), 'HmacKey', true],
    [prototypeOf(sdk, 'Channel'), 'Channel', true],
    [prototypeOf(sdk, 'Notification'), 'Notification', true],
    [prototypeOf(sdk, 'TransferManager'), 'TransferManager', false],
  ];
  for (const [proto, name, nodeCallback] of protoTargets) {
    gatePrototypeMethods(proto, {
      className: name,
      gate,
      appOf,
      allowlist: LOCAL_METHODS[name]!,
      nodeCallback,
      skipWhenObserving: true,
      beforeCall: checkCallOpts,
    });
  }
}
