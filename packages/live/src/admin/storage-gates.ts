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
const URI_BUCKET_SEGMENT = /\/b\/([^/?#]+)/g;
const URI_PROJECTS_SEGMENT = /(?:^|\/)projects\/([^/?#:]+)/g;
const URI_PROJECT_QUERY = /[?&](?:project|projectId|userProject)=([^&#]+)/gi;
const VIRTUAL_HOST_SUFFIX = '.storage.googleapis.com';
const UNRESOLVED_PROJECT = '{{projectId}}';
const MAX_OPTION_SCAN_DEPTH = 4;
const PROJECT_OPTION_KEYS = ['project', 'projectId', 'userProject'] as const;
const PROJECT_QUERY_KEYS: ReadonlySet<string> = new Set(['project', 'projectid', 'userproject']);
const BUCKET_QUERY_KEYS: ReadonlySet<string> = new Set(['bucket', 'destinationbucket']);
const USER_PROJECT_HEADER = 'x-goog-user-project';
const CALL_CHECKS_PATCHED = Symbol.for('pyric.live.admin.storage.callChecks');
const UTILS_PATCHED = Symbol.for('pyric.live.admin.storage.firebaseUtils');

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function safeGet(subject: object, field: string): unknown {
  try {
    return Reflect.get(subject, field);
  } catch {
    return undefined;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stringAt(subject: unknown, field: string): string | undefined {
  if (!isObject(subject)) return undefined;
  const value: unknown = safeGet(subject, field);
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

function isSkippableOptionObject(value: object): boolean {
  if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) return true;
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Promise ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof URL
  );
}

function assertProjectValueAllowed(value: unknown, hostProjectId: string): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (isResolvedProjectString(trimmed) && trimmed !== hostProjectId) {
      throw liveAdminProjectRefusal({ source: 'options.projectId', appProjectId: trimmed, hostProjectId });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertProjectValueAllowed(item, hostProjectId);
  }
}

function assertBucketAllowed(callName: string, bucketName: string | undefined, observer: LiveObserver): void {
  const refusal = bucketProjectRefusal(callName, bucketName, observer);
  if (refusal !== null) throw refusal;
}

function assertStorageUriFallback(callName: string, rawUri: string, observer: LiveObserver, hostProjectId: string): void {
  for (const match of rawUri.matchAll(URI_BUCKET_SEGMENT)) {
    const seg = match[1];
    if (seg !== undefined) assertBucketAllowed(callName, safeDecode(seg), observer);
  }
  for (const match of rawUri.matchAll(URI_PROJECTS_SEGMENT)) {
    const seg = match[1];
    if (seg !== undefined) assertProjectValueAllowed(safeDecode(seg), hostProjectId);
  }
  for (const match of rawUri.matchAll(URI_PROJECT_QUERY)) {
    const val = match[1];
    if (val !== undefined) assertProjectValueAllowed(safeDecode(val), hostProjectId);
  }
}

function assertStorageUriAllowed(callName: string, rawUri: string, observer: LiveObserver): void {
  const hostProjectId = observer.hostProjectId;
  const trimmed = rawUri.trim();
  if (hostProjectId === undefined || trimmed === '') return;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://storage.pyric.invalid');
  } catch {
    assertStorageUriFallback(callName, trimmed, observer, hostProjectId);
    return;
  }

  if (parsed.protocol === 'gs:') {
    assertBucketAllowed(callName, safeDecode(parsed.hostname), observer);
  }

  const hostLower = parsed.hostname.toLowerCase();
  if (hostLower.endsWith(VIRTUAL_HOST_SUFFIX)) {
    const hostBucket = parsed.hostname.slice(0, -VIRTUAL_HOST_SUFFIX.length);
    assertBucketAllowed(callName, safeDecode(hostBucket), observer);
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0) {
    assertBucketAllowed(callName, safeDecode(segments[0] ?? ''), observer);
  }

  let seenBucket = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = safeDecode(segments[i] ?? '');
    const nextSeg = i + 1 < segments.length ? segments[i + 1] : undefined;
    if (seg === 'b' && nextSeg !== undefined) {
      seenBucket = true;
      assertBucketAllowed(callName, safeDecode(nextSeg), observer);
    } else if (seg === 'projects' && !seenBucket && nextSeg !== undefined) {
      const decoded = safeDecode(nextSeg);
      const colon = decoded.indexOf(':');
      const projectId = colon === -1 ? decoded : decoded.slice(0, colon);
      assertProjectValueAllowed(projectId, hostProjectId);
    }
  }

  for (const [rawKey, rawVal] of parsed.searchParams.entries()) {
    const key = rawKey.trim().toLowerCase();
    if (PROJECT_QUERY_KEYS.has(key)) {
      assertProjectValueAllowed(rawVal, hostProjectId);
    } else if (BUCKET_QUERY_KEYS.has(key)) {
      assertBucketAllowed(callName, rawVal, observer);
    }
  }
}

function assertHeadersAllowed(headers: unknown, hostProjectId: string): void {
  if (!isObject(headers)) return;
  if (typeof Headers === 'function' && headers instanceof Headers) {
    assertProjectValueAllowed(headers.get(USER_PROJECT_HEADER), hostProjectId);
    return;
  }
  if (headers instanceof Map) {
    for (const [key, val] of headers.entries()) {
      if (typeof key === 'string' && key.trim().toLowerCase() === USER_PROJECT_HEADER) {
        assertProjectValueAllowed(val, hostProjectId);
      }
    }
    return;
  }
  assertProjectValueAllowed(safeGet(headers, USER_PROJECT_HEADER), hostProjectId);
  for (const key of Object.keys(headers)) {
    if (key.trim().toLowerCase() === USER_PROJECT_HEADER) {
      assertProjectValueAllowed(safeGet(headers, key), hostProjectId);
    }
  }
}

function assertUriFieldAllowed(callName: string, raw: unknown, observer: LiveObserver): void {
  if (typeof raw === 'string') {
    assertStorageUriAllowed(callName, raw, observer);
  } else if (raw instanceof URL) {
    assertStorageUriAllowed(callName, raw.href, observer);
  }
}

function scanStorageOptionObject(
  callName: string,
  value: unknown,
  observer: LiveObserver,
  depth: number,
  seen: Set<object>,
): void {
  const hostProjectId = observer.hostProjectId;
  if (hostProjectId === undefined || depth > MAX_OPTION_SCAN_DEPTH || !isObject(value)) return;

  if (value instanceof URLSearchParams) {
    for (const [rawKey, rawVal] of value.entries()) {
      const key = rawKey.trim().toLowerCase();
      if (PROJECT_QUERY_KEYS.has(key)) {
        assertProjectValueAllowed(rawVal, hostProjectId);
      } else if (BUCKET_QUERY_KEYS.has(key)) {
        assertBucketAllowed(callName, rawVal, observer);
      }
    }
    return;
  }

  if (value instanceof Map) {
    for (const [rawKey, rawVal] of value.entries()) {
      if (typeof rawKey !== 'string') continue;
      const key = rawKey.trim().toLowerCase();
      if (PROJECT_QUERY_KEYS.has(key)) {
        assertProjectValueAllowed(rawVal, hostProjectId);
      } else if (BUCKET_QUERY_KEYS.has(key) && typeof rawVal === 'string') {
        assertBucketAllowed(callName, rawVal, observer);
      } else if (key === 'uri' || key === 'url') {
        assertUriFieldAllowed(callName, rawVal, observer);
      }
    }
    return;
  }

  if (isSkippableOptionObject(value) || seen.has(value)) return;
  seen.add(value);

  for (const key of PROJECT_OPTION_KEYS) {
    assertProjectValueAllowed(safeGet(value, key), hostProjectId);
  }
  assertUriFieldAllowed(callName, safeGet(value, 'uri'), observer);
  assertUriFieldAllowed(callName, safeGet(value, 'url'), observer);
  assertHeadersAllowed(safeGet(value, 'headers'), hostProjectId);

  const qs = safeGet(value, 'qs');
  if (qs !== undefined) scanStorageOptionObject(callName, qs, observer, depth + 1, seen);
  const nestedRequest = safeGet(value, 'request');
  if (nestedRequest !== undefined) scanStorageOptionObject(callName, nestedRequest, observer, depth + 1, seen);
}

/** Validates per-call Storage option objects (plain or non-plain), URIs, query params, and headers against `observer.hostProjectId`. */
export function assertStorageCallOptionsAllowed(
  callName: string,
  args: readonly unknown[],
  observer: LiveObserver,
): void {
  if (observer.hostProjectId === undefined) return;
  const seen = new Set<object>();
  for (const arg of args) {
    scanStorageOptionObject(callName, arg, observer, 0, seen);
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

function onAuthenticatedOf(args: readonly unknown[]): { receiver: object; fn: Method } | undefined {
  const second = args[1];
  if (!isObject(second)) return undefined;
  const fn = safeGet(second, 'onAuthenticated');
  if (typeof fn !== 'function') return undefined;
  return { receiver: second, fn: fn as Method };
}

function refusedStream(err: unknown): PassThrough {
  const proxy = new PassThrough();
  process.nextTick(() => {
    if (!proxy.destroyed) proxy.destroy(toError(err));
  });
  return proxy;
}

/** Gates `Service` constructor's own `makeAuthenticatedRequest` property (used by `getDownloadURL`, `request`, and `requestStream`). */
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
      const checkUriAndOpts = (): void => {
        assertStorageCallOptionsAllowed('Storage.makeAuthenticatedRequest', args, observer);
      };

      const cb = nodeCallbackOf(args);
      const onAuth = cb === undefined ? onAuthenticatedOf(args) : undefined;

      // Never skip URI/options enforcement when called reentrantly (e.g. from Service.requestStream / Service.request).
      if (isObservingAdminCall()) {
        try {
          checkUriAndOpts();
        } catch (err: unknown) {
          if (cb !== undefined) {
            process.nextTick(() => Reflect.apply(cb.callback, undefined, [err]));
            return { abort() {} };
          }
          if (onAuth !== undefined) {
            process.nextTick(() => Reflect.apply(onAuth.fn, onAuth.receiver, [err]));
            return { abort() {} };
          }
          return refusedStream(err);
        }
        return Reflect.apply(real, this, args);
      }

      if (cb !== undefined) {
        let reached = false;
        gate(appOf(owner), () => {
          checkUriAndOpts();
          reached = true;
          return runInsideAdminCall(() => Reflect.apply(real, this, args));
        }).catch((err: unknown) => {
          if (!reached) process.nextTick(() => Reflect.apply(cb.callback, undefined, [err]));
        });
        return { abort() {} };
      }

      if (onAuth !== undefined) {
        let reached = false;
        gate(appOf(owner), () => {
          checkUriAndOpts();
          reached = true;
          return runInsideAdminCall(() => Reflect.apply(real, this, args));
        }).catch((err: unknown) => {
          if (!reached) process.nextTick(() => Reflect.apply(onAuth.fn, onAuth.receiver, [err]));
        });
        return { abort() {} };
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
