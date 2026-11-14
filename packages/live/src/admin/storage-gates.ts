/**
 * Cross-project bucket, `HmacKey`, `userProject`, per-call option, and
 * `makeAuthenticatedRequest` / `getDownloadURL` gates for `@google-cloud/storage`
 * and `firebase-admin/storage`.
 */
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import type { LiveObserver } from '../observe.js';
import { liveAdminProjectRefusal, liveProjectRefusal } from '../refusal.js';
import {
  isAdminMethodGated,
  isObservingAdminCall,
  keepShape,
  markAdminMethodGated,
  nodeCallbackOf,
  runInsideAdminCall,
  settleToCallback,
  type AdminRow,
} from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';
import { entryRequire } from './prototype-gate.js';

type Method = (this: unknown, ...args: unknown[]) => unknown;

const DEFAULT_BUCKET = /^(?:gs:\/\/)?([a-z0-9-]+)\.(?:appspot\.com|firebasestorage\.app)\/?$/i;
const HMAC_BASE_URL_PROJECT = /^\/projects\/([^/]+)\/hmacKeys(?:\/|$)/;
const URI_BUCKET_SEGMENT = /\/b\/([^/?#]+)/;
const UNRESOLVED_PROJECT = '{{projectId}}';
const CALL_CHECKS_PATCHED = Symbol.for('pyric.live.admin.storage.callChecks');
const UTILS_PATCHED = Symbol.for('pyric.live.admin.storage.firebaseUtils');

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringAt(subject: unknown, field: string): string | undefined {
  if (!isObject(subject)) return undefined;
  const value: unknown = Reflect.get(subject, field);
  return typeof value === 'string' ? value : undefined;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function isResolvedProjectString(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== UNRESOLVED_PROJECT;
}

/** Refusal when `bucketName` is a `<project>.appspot.com` or `<project>.firebasestorage.app` bucket of another project. */
export function bucketProjectRefusal(
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

/** Extracts an explicit project id embedded on an `HmacKey` handle (`projectId` or `/projects/<id>/hmacKeys`). */
export function hmacKeyProjectOf(self: unknown): string | undefined {
  const direct = stringAt(self, 'projectId');
  if (isResolvedProjectString(direct)) return direct;
  const baseUrl = stringAt(self, 'baseUrl');
  const fromUrl = baseUrl === undefined ? undefined : HMAC_BASE_URL_PROJECT.exec(baseUrl)?.[1];
  return isResolvedProjectString(fromUrl) ? fromUrl : undefined;
}

/** Extracts any `userProject` configured on a `File`, `Bucket`, or sub-handle owner. */
export function userProjectOf(self: unknown, bucket: object | undefined): string | undefined {
  const own = stringAt(self, 'userProject');
  if (isResolvedProjectString(own)) return own;
  const fromBucket = stringAt(bucket, 'userProject');
  return isResolvedProjectString(fromBucket) ? fromBucket : undefined;
}

function isPlainOptionsObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Validates per-call `{ project, projectId, userProject }` option objects against `observer.hostProjectId`. */
export function assertStorageCallOptionsAllowed(
  _callName: string,
  args: readonly unknown[],
  observer: LiveObserver,
): void {
  const hostProjectId = observer.hostProjectId;
  if (hostProjectId === undefined) return;
  for (const arg of args) {
    if (!isPlainOptionsObject(arg)) continue;
    for (const key of ['project', 'projectId', 'userProject'] as const) {
      const val = arg[key];
      if (typeof val === 'string' && isResolvedProjectString(val) && val !== hostProjectId) {
        throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: val, hostProjectId });
      }
    }
    if (isPlainOptionsObject(arg.qs)) {
      assertStorageCallOptionsAllowed(_callName, [arg.qs], observer);
    }
  }
}

/** Wraps `Bucket.prototype.setUserProject` and `File.prototype.setUserProject` with synchronous project checks. */
export function patchSetUserProject(
  prototype: object | undefined,
  observer: LiveObserver,
  clientProjectOf: (self: unknown) => string | undefined,
): void {
  if (prototype === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'setUserProject');
  if (typeof descriptor?.value !== 'function' || isAdminMethodGated(descriptor.value)) return;
  const real = descriptor.value as Method;
  const wrapped = keepShape(function gatedSetUserProject(this: unknown, ...args: unknown[]): unknown {
    const hostProjectId = observer.hostProjectId;
    if (hostProjectId !== undefined) {
      const ownerProj = clientProjectOf(this);
      if (ownerProj !== undefined && ownerProj !== hostProjectId) {
        throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: ownerProj, hostProjectId });
      }
      const targetProj = args[0];
      if (typeof targetProj === 'string' && isResolvedProjectString(targetProj) && targetProj !== hostProjectId) {
        throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: targetProj, hostProjectId });
      }
    }
    return Reflect.apply(real, this, args);
  }, real);
  Object.defineProperty(prototype, 'setUserProject', { ...descriptor, value: markAdminMethodGated(wrapped) });
}

function targetBucketName(
  target: unknown,
  isBucketNameArg: boolean,
  isEntity: (value: unknown) => boolean,
  bucketOf: (value: unknown) => object | undefined,
): string | undefined {
  if (typeof target === 'string') {
    if (isBucketNameArg) return target;
    if (!target.startsWith('gs://')) return undefined;
    const rest = target.slice('gs://'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.slice(0, slash);
  }
  if (isEntity(target)) {
    return stringAt(bucketOf(target), 'name');
  }
  return undefined;
}

/**
 * Wraps observed `File`, `Bucket`, and `Storage` methods so per-call option
 * overrides (`project`, `projectId`, `userProject`) and extra target buckets/entities
 * (`copy`, `move`, `moveFileAtomic`, `rename`, `combine`, `createBucket`) are
 * checked before the observed call runs (producing no record on refusal).
 */
export function patchStorageCallChecks(
  prototype: object | undefined,
  className: string,
  methodNames: readonly string[],
  extraTargetMethods: ReadonlySet<string>,
  adminRow: AdminRow,
  isEntity: (value: unknown) => boolean,
  bucketOf: (value: unknown) => object | undefined,
): void {
  if (prototype === undefined || Object.hasOwn(prototype, CALL_CHECKS_PATCHED)) return;

  const checkCall = async (methodName: string, callArgs: readonly unknown[]): Promise<void> => {
    const callName = `${className}.${methodName}`;
    assertStorageCallOptionsAllowed(callName, callArgs, adminRow.observer);
    if (!extraTargetMethods.has(methodName)) return;
    const isCombine = className === 'Bucket' && methodName === 'combine';
    const isCreateBucket = className === 'Storage' && methodName === 'createBucket';
    let targets: unknown[] = [callArgs[0]];
    if (isCombine) {
      const sources = Array.isArray(callArgs[0]) ? callArgs[0] : [];
      targets = [...sources, callArgs[1]];
    }
    for (const target of targets) {
      const refusal = bucketProjectRefusal(
        callName,
        targetBucketName(target, isCreateBucket, isEntity, bucketOf),
        adminRow.observer,
      );
      if (refusal !== null) throw refusal;
      if (isEntity(target)) {
        await adminRow.gate(adminRow.appOf(target), () => undefined);
      }
    }
  };

  for (const methodName of methodNames) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    const patched = descriptor?.value as unknown;
    if (typeof patched !== 'function') continue;
    const patchedFn = patched as Method;
    const guarded = markAdminMethodGated(keepShape(function adminCheckedStorageCall(this: unknown, ...args: unknown[]): unknown {
      if (isObservingAdminCall()) {
        return Reflect.apply(patchedFn, this, args);
      }
      const cb = nodeCallbackOf(args);
      if (cb !== undefined) {
        const pending = checkCall(methodName, cb.before).then(() =>
          Reflect.apply(patchedFn, this, cb.before),
        );
        settleToCallback(pending, cb.callback);
        return undefined;
      }
      return checkCall(methodName, args).then(() => Reflect.apply(patchedFn, this, args));
    }, patchedFn));
    Object.defineProperty(prototype, methodName, { ...descriptor, value: guarded });
  }
  Object.defineProperty(prototype, CALL_CHECKS_PATCHED, { value: true });
}

/** Gates `Service` constructor's own `makeAuthenticatedRequest` property (used by `getDownloadURL`). */
export function gateMakeAuthenticatedRequest(
  serviceProto: object | undefined,
  gate: AdminProjectGate,
  appOf: (self: unknown) => AdminApp,
  observer: LiveObserver,
): void {
  if (serviceProto === undefined) return;
  const existing = Object.getOwnPropertyDescriptor(serviceProto, 'makeAuthenticatedRequest');
  if (isAdminMethodGated(existing?.get)) return;
  const perInstance = new WeakMap<object, Method>();

  const wrapAuthRequest = (owner: object, real: Method): Method =>
    markAdminMethodGated(keepShape(function gatedMakeAuthenticatedRequest(this: unknown, ...args: unknown[]): unknown {
      if (isObservingAdminCall()) return Reflect.apply(real, this, args);
      const checkUriAndOpts = (): void => {
        assertStorageCallOptionsAllowed('Storage.makeAuthenticatedRequest', args, observer);
        const uri = stringAt(args[0], 'uri');
        const uriBucket = uri === undefined ? undefined : URI_BUCKET_SEGMENT.exec(uri)?.[1];
        const decodedBucket = uriBucket === undefined ? undefined : decodeURIComponent(uriBucket);
        const refusal = bucketProjectRefusal('firebase-admin/storage', decodedBucket, observer);
        if (refusal !== null) throw refusal;
      };

      const cb = nodeCallbackOf(args);
      if (cb !== undefined) {
        let reached = false;
        gate(appOf(owner), () => {
          checkUriAndOpts();
          reached = true;
          return runInsideAdminCall(() => Reflect.apply(real, this, args));
        }).catch((err: unknown) => {
          if (!reached) process.nextTick(() => Reflect.apply(cb.callback, undefined, [err]));
        });
        return undefined;
      }

      const proxy = new PassThrough();
      gate(appOf(owner), () => {
        checkUriAndOpts();
        if (proxy.destroyed) return undefined;
        return runInsideAdminCall(() => {
          const stream = Reflect.apply(real, this, args) as NodeJS.ReadWriteStream;
          stream.on('error', (err: unknown) => {
            if (!proxy.destroyed) proxy.destroy(toError(err));
          });
          stream.pipe(proxy);
          return stream;
        });
      }).catch((err: unknown) => {
        if (!proxy.destroyed) proxy.destroy(toError(err));
      });
      return proxy;
    }, real));

  const getter = markAdminMethodGated(function getMakeAuthenticatedRequest(this: unknown): Method | undefined {
    return isObject(this) ? perInstance.get(this) : undefined;
  });

  Object.defineProperty(serviceProto, 'makeAuthenticatedRequest', {
    configurable: true,
    enumerable: true,
    get: getter,
    set(this: unknown, value: unknown) {
      if (!isObject(this) || typeof value !== 'function') return;
      perInstance.set(this, wrapAuthRequest(this, value as Method));
    },
  });
}

/** Gates `firebase-admin/lib/storage/utils.js`'s `getFirebaseMetadata` helper backing `getDownloadURL`. */
export function patchAdminStorageUtils(
  requiredBy: string | undefined,
  gate: AdminProjectGate,
  appOf: (self: unknown) => AdminApp,
): void {
  try {
    const adminStorageIndex = requiredBy ?? createRequire(import.meta.url).resolve('firebase-admin/storage');
    const utilsMod: unknown = entryRequire(adminStorageIndex)('./utils');
    if (!isObject(utilsMod) || Object.hasOwn(utilsMod, UTILS_PATCHED)) return;
    const descriptor = Object.getOwnPropertyDescriptor(utilsMod, 'getFirebaseMetadata');
    if (typeof descriptor?.value !== 'function') return;
    const real = descriptor.value as Method;
    const wrapped = markAdminMethodGated(keepShape(function gatedGetFirebaseMetadata(this: unknown, ...args: unknown[]): unknown {
      const file = args[1];
      return gate(appOf(file), () => Reflect.apply(real, this, args));
    }, real));
    Object.defineProperty(utilsMod, 'getFirebaseMetadata', { ...descriptor, value: wrapped });
    Object.defineProperty(utilsMod, UTILS_PATCHED, { value: true });
  } catch {
    // Standalone `@google-cloud/storage` without `firebase-admin/storage` has no `utils.js`.
  }
}
