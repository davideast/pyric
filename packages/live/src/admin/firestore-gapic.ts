/**
 * Structural `AdminProjectGate` and `(default)` database gating for the low-level
 * GAPIC clients publicly exported by `firebase-admin/firestore` and
 * `@google-cloud/firestore` (`v1.FirestoreClient`, `v1.FirestoreAdminClient`,
 * and `v1beta1.FirestoreClient`).
 *
 * Internal `_clientPool` calls originating from an already-gated high-level
 * `Firestore` operation run inside `isObservingAdminCall()` and pass straight
 * through to the underlying gRPC stream/call without double-wrapping.
 */
import { Duplex, type Readable } from 'node:stream';
import type { LiveObserver } from '../observe.js';
import { liveAdminProjectRefusal, liveCallRefusal } from '../refusal.js';
import {
  isAdminMethodGated,
  isObservingAdminCall,
  keepShape,
  markAdminMethodGated,
  runInsideAdminCall,
  type AdminRow,
} from './patch.js';
import { UNREAD_APP, type AdminApp, type AdminProjectGate } from './project-gate.js';
import {
  entryRequire,
  gatePrototypeMethods,
  patchAsyncGeneratorMethod,
  patchObjectStreamMethod,
} from './prototype-gate.js';

type Method = (this: unknown, ...args: unknown[]) => unknown;

const RESOURCE_PATH_PATTERN = /(?:^|\/)projects\/([^/]+)(?:\/databases\/([^/]+))?/;
const MAX_SCAN_DEPTH = 5;

const V1_CLIENT_LOCAL: ReadonlySet<string> = new Set(['initialize', 'getProjectId', 'close']);
const V1_ADMIN_LOCAL: ReadonlySet<string> = new Set([
  'initialize', 'getProjectId', 'close',
  'backupPath', 'matchProjectFromBackupName', 'matchLocationFromBackupName', 'matchBackupFromBackupName',
  'backupSchedulePath', 'matchProjectFromBackupScheduleName', 'matchDatabaseFromBackupScheduleName', 'matchBackupScheduleFromBackupScheduleName',
  'collectionGroupPath', 'matchProjectFromCollectionGroupName', 'matchDatabaseFromCollectionGroupName', 'matchCollectionFromCollectionGroupName',
  'databasePath', 'matchProjectFromDatabaseName', 'matchDatabaseFromDatabaseName',
  'fieldPath', 'matchProjectFromFieldName', 'matchDatabaseFromFieldName', 'matchCollectionFromFieldName', 'matchFieldFromFieldName',
  'indexPath', 'matchProjectFromIndexName', 'matchDatabaseFromIndexName', 'matchCollectionFromIndexName', 'matchIndexFromIndexName',
  'locationPath', 'matchProjectFromLocationName', 'matchLocationFromLocationName',
  'projectPath', 'matchProjectFromProjectName',
]);

const SERVER_STREAM_METHODS = [
  'batchGetDocuments',
  'runQuery',
  'runAggregationQuery',
  'listDocumentsStream',
  'partitionQueryStream',
  'listCollectionIdsStream',
  'listIndexesStream',
  'listFieldsStream',
] as const;

const ASYNC_ITER_METHODS = [
  'listDocumentsAsync',
  'partitionQueryAsync',
  'listCollectionIdsAsync',
  'listIndexesAsync',
  'listFieldsAsync',
  'listLocationsAsync',
  'listOperationsAsync',
] as const;

const DUPLEX_METHODS = ['write', 'listen'] as const;

const gapicApps = new WeakMap<object, AdminApp>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function throwNamedDatabaseRefusal(databaseId: string, observer: LiveObserver): never {
  throw liveCallRefusal(
    {
      call: 'firebase-admin/firestore',
      reaches: `the Firestore database ${JSON.stringify(databaseId)}`,
      serves: 'only the (default) database',
    },
    observer.client ?? 'node',
  );
}

function checkResourceString(text: string, hostProjectId: string, observer: LiveObserver): void {
  const match = RESOURCE_PATH_PATTERN.exec(text);
  if (match === null) return;
  const projectId = match[1];
  const databaseId = match[2];
  if (projectId !== undefined && projectId !== '' && projectId !== hostProjectId) {
    throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: projectId, hostProjectId });
  }
  if (databaseId !== undefined && databaseId !== '' && databaseId !== '(default)' && databaseId !== '-') {
    throwNamedDatabaseRefusal(databaseId, observer);
  }
}

function scanRequestPayload(value: unknown, hostProjectId: string, observer: LiveObserver, depth: number): void {
  if (depth > MAX_SCAN_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    checkResourceString(value, hostProjectId, observer);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanRequestPayload(item, hostProjectId, observer, depth + 1);
    return;
  }
  if (!isObject(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'databaseId' && typeof entry === 'string' && entry !== '' && entry !== '(default)') {
      throwNamedDatabaseRefusal(entry, observer);
    }
    scanRequestPayload(entry, hostProjectId, observer, depth + 1);
  }
}

/** Validates GAPIC request arguments against `observer.hostProjectId` and `(default)` database. */
export function assertGapicPayloadAllowed(args: readonly unknown[], observer: LiveObserver): void {
  const hostProjectId = observer.hostProjectId;
  if (hostProjectId === undefined || args.length === 0) return;
  scanRequestPayload(args[0], hostProjectId, observer, 0);
}

function gapicAppOf(self: unknown): AdminApp {
  if (!isObject(self)) return UNREAD_APP;
  const cached = gapicApps.get(self);
  if (cached !== undefined) return cached;
  const opts: unknown = Reflect.get(self, '_opts');
  const explicitProject: unknown = isObject(opts) ? Reflect.get(opts, 'projectId') : undefined;
  const authClient: unknown = Reflect.get(self, 'auth');
  if (!isObject(opts) && !isObject(authClient)) return UNREAD_APP;

  let options: AdminApp['options'];
  if (typeof explicitProject === 'string' && explicitProject !== '') {
    options = { projectId: explicitProject };
  } else if (isObject(authClient) && typeof Reflect.get(authClient, 'getProjectId') === 'function') {
    options = {
      credential: {
        getProjectId: () =>
          Promise.resolve(Reflect.apply(Reflect.get(authClient, 'getProjectId') as () => unknown, authClient, [])),
      },
    };
  } else {
    options = {};
  }
  const app: AdminApp = { options };
  gapicApps.set(self, app);
  return app;
}

function patchGapicDuplexMethod(
  prototype: object | undefined,
  methodName: string,
  gate: AdminProjectGate,
  observer: LiveObserver,
): void {
  if (prototype === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (typeof descriptor?.value !== 'function' || isAdminMethodGated(descriptor.value)) return;
  const real = descriptor.value as (this: unknown, ...args: unknown[]) => Duplex;

  const wrapped = keepShape(function gatedGapicDuplex(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) return Reflect.apply(real, this, args);
    const self = this;
    let underlying: Duplex | undefined;
    let openPromise: Promise<Duplex> | undefined;

    const proxy = new Duplex({
      objectMode: true,
      read() {
        // Pushed by `underlying` data events once opened.
      },
      write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        try {
          assertGapicPayloadAllowed([chunk], observer);
        } catch (err) {
          const error = toError(err);
          callback(error);
          if (!proxy.destroyed) proxy.destroy(error);
          return;
        }
        ensureUnderlying()
          .then((target) => target.write(chunk, encoding, callback))
          .catch((err: unknown) => callback(toError(err)));
      },
      final(callback: (error?: Error | null) => void) {
        ensureUnderlying()
          .then((target) => {
            target.end();
            callback();
          })
          .catch((err: unknown) => callback(toError(err)));
      },
      destroy(error: Error | null, callback: (error: Error | null) => void) {
        if (underlying !== undefined && !underlying.destroyed) {
          underlying.destroy(error ?? undefined);
        }
        callback(error);
      },
    });

    function ensureUnderlying(): Promise<Duplex> {
      if (openPromise !== undefined) return openPromise;
      openPromise = gate(gapicAppOf(self), () =>
        runInsideAdminCall(() => {
          const created = Reflect.apply(real, self, args);
          underlying = created;
          created.on('data', (item: unknown) => {
            proxy.push(item);
          });
          created.on('end', () => {
            proxy.push(null);
          });
          created.on('error', (err: unknown) => {
            if (!proxy.destroyed) proxy.destroy(toError(err));
          });
          return created;
        }),
      );
      return openPromise;
    }

    ensureUnderlying().catch((err: unknown) => {
      if (!proxy.destroyed) proxy.destroy(toError(err));
    });

    return proxy;
  } as Method, real as unknown as Method);

  Object.defineProperty(prototype, methodName, { ...descriptor, value: markAdminMethodGated(wrapped) });
}

function resolveNamespace(sdk: unknown, entryFile: string, version: 'v1' | 'v1beta1'): unknown {
  const fromSdk: unknown = isObject(sdk) || typeof sdk === 'function' ? Reflect.get(sdk as object, version) : undefined;
  if (isObject(fromSdk) || typeof fromSdk === 'function') return fromSdk;
  try {
    return entryRequire(entryFile)(`./${version}`);
  } catch {
    return undefined;
  }
}

function prototypeFromNamespace(ns: unknown, exportName: string): object | undefined {
  if (!isObject(ns) && typeof ns !== 'function') return undefined;
  const ctor: unknown = Reflect.get(ns as object, exportName);
  const proto: unknown = typeof ctor === 'function' ? Reflect.get(ctor, 'prototype') : undefined;
  return isObject(proto) ? proto : undefined;
}

/** Patches `v1.FirestoreClient`, `v1.FirestoreAdminClient`, and `v1beta1.FirestoreClient` prototypes. */
export function patchFirestoreGapicClients(
  sdk: unknown,
  entryFile: string,
  moduleName: string,
  gate: AdminProjectGate,
  observer: LiveObserver,
): void {
  const v1 = resolveNamespace(sdk, entryFile, 'v1');
  const v1beta1 = resolveNamespace(sdk, entryFile, 'v1beta1');
  const targets: readonly [string, object | undefined, ReadonlySet<string>][] = [
    ['v1.FirestoreClient', prototypeFromNamespace(v1, 'FirestoreClient'), V1_CLIENT_LOCAL],
    ['v1.FirestoreAdminClient', prototypeFromNamespace(v1, 'FirestoreAdminClient'), V1_ADMIN_LOCAL],
    ['v1beta1.FirestoreClient', prototypeFromNamespace(v1beta1, 'FirestoreClient'), V1_CLIENT_LOCAL],
  ];

  const beforeCall = (_methodName: string, args: readonly unknown[]) => {
    assertGapicPayloadAllowed(args, observer);
  };
  const row: AdminRow = { module: moduleName, observer, gate, appOf: gapicAppOf };

  for (const [className, proto, allowlist] of targets) {
    if (proto === undefined) continue;
    for (const streamMethod of SERVER_STREAM_METHODS) {
      patchObjectStreamMethod(proto, streamMethod, row, className, { beforeCall });
    }
    for (const asyncMethod of ASYNC_ITER_METHODS) {
      patchAsyncGeneratorMethod(proto, asyncMethod, row, className, { beforeCall });
    }
    for (const duplexMethod of DUPLEX_METHODS) {
      patchGapicDuplexMethod(proto, duplexMethod, gate, observer);
    }
    gatePrototypeMethods(proto, {
      className,
      gate,
      appOf: gapicAppOf,
      allowlist,
      nodeCallback: true,
      skipWhenObserving: true,
      beforeCall,
    });
  }
}
