/**
 * Structural prototype-reflection gating helpers shared across Admin rows.
 *
 * Beyond the curated observed methods patched via `patchAdminClass`, Admin SDK
 * classes expose sub-managers, query variants, object/pagination streams,
 * async generators, and internal RPC helpers. Sweeping prototypes structurally
 * guarantees every non-allowlisted method enforces `AdminProjectGate` before
 * any request leaves the process.
 */
import { EventEmitter } from 'node:events';
import Module, { createRequire } from 'node:module';
import { PassThrough, type Readable } from 'node:stream';
import type { CallContext, LiveCallRecord } from '../observe.js';
import {
  isAdminMethodGated,
  isObservingAdminCall,
  keepShape,
  markAdminMethodGated,
  nodeCallbackOf,
  runInsideAdminCall,
  type AdminRow,
} from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

type Method = (this: unknown, ...args: unknown[]) => unknown;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function settleCallback(pending: Promise<unknown>, callback: Method): void {
  pending.then(
    (value: unknown) => {
      let results: unknown[] = [];
      if (Array.isArray(value)) results = value;
      else if (value !== undefined) results = [value];
      process.nextTick(() => Reflect.apply(callback, undefined, [null, ...results]));
    },
    (error: unknown) => {
      process.nextTick(() => Reflect.apply(callback, undefined, [error]));
    },
  );
}

/**
 * Resolves a CommonJS `require` bound to `entryFile`'s cached `Module` when
 * loaded, so relative requires inside the Admin SDK tree carry `entryFile` as
 * their importer.
 */
export function entryRequire(entryFile: string): (id: string) => unknown {
  const cache = (Module as unknown as { _cache?: Record<string, { require?: (id: string) => unknown }> })._cache;
  const cached = cache?.[entryFile];
  if (typeof cached?.require === 'function') {
    return cached.require.bind(cached);
  }
  return createRequire(entryFile);
}

/**
 * Invokes `onClass` immediately if `moduleExports[exportName]` is already a
 * constructor function, or as soon as circular CommonJS initialization assigns it.
 */
export function withExportedClass(
  moduleExports: unknown,
  exportName: string,
  onClass: (ctor: Function) => void,
): void {
  if (!isObject(moduleExports)) return;
  const existing: unknown = Reflect.get(moduleExports, exportName);
  if (typeof existing === 'function') {
    onClass(existing);
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(moduleExports, exportName);
  if (descriptor !== undefined && descriptor.configurable === false) return;
  let current: unknown = existing;
  Object.defineProperty(moduleExports, exportName, {
    configurable: true,
    enumerable: true,
    get() {
      return current;
    },
    set(next: unknown) {
      current = next;
      if (typeof next === 'function') onClass(next);
    },
  });
}

interface GatePromiseOptions {
  readonly nodeCallback?: boolean;
  readonly skipWhenObserving?: boolean;
}

/** Wraps an async or node-callback method so `gate` runs before `real`. */
function gatePromiseMethod(
  gate: AdminProjectGate,
  appOf: (self: unknown) => AdminApp,
  real: Method,
  options: GatePromiseOptions = {},
): Method {
  const wrapped = keepShape(function gatedAdminMethod(this: unknown, ...args: unknown[]): unknown {
    if (options.skipWhenObserving === true && isObservingAdminCall()) {
      return Reflect.apply(real, this, args);
    }
    const cb = options.nodeCallback === true ? nodeCallbackOf(args) : undefined;
    if (cb !== undefined) {
      const isPromisified = Reflect.get(real, 'promisified_') === true;
      if (!isPromisified) {
        let reached = false;
        gate(appOf(this), () => {
          reached = true;
          return Reflect.apply(real, this, args);
        }).catch((err: unknown) => {
          if (!reached) process.nextTick(() => Reflect.apply(cb.callback, undefined, [err]));
        });
        return undefined;
      }
      const pending = gate(appOf(this), () => Reflect.apply(real, this, cb.before));
      settleCallback(pending, cb.callback);
      return undefined;
    }
    return gate(appOf(this), () => Reflect.apply(real, this, args));
  }, real);
  return markAdminMethodGated(wrapped);
}

export interface StreamGateOptions {
  readonly observe?: boolean;
  readonly context?: (name: string, args: readonly unknown[], self: unknown) => CallContext;
  readonly codeOf?: (error: unknown) => string;
}

function emitObservedOutcome(
  row: AdminRow,
  callName: string,
  ctx: CallContext | undefined,
  outcome: 'resolved' | 'rejected',
  codeOf: ((error: unknown) => string) | undefined,
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
  } = {
    module: row.module,
    sdk: 'admin',
    name: callName,
    outcome,
  };
  if (ctx?.projectId !== undefined) record.projectId = ctx.projectId;
  if (ctx?.bucket !== undefined) record.bucket = ctx.bucket;
  if (ctx?.path !== undefined) record.path = ctx.path;
  if (outcome === 'rejected') {
    let fallbackCode = 'unknown';
    if (isObject(error) && typeof Reflect.get(error, 'code') === 'string') {
      fallbackCode = Reflect.get(error, 'code') as string;
    }
    record.code = codeOf !== undefined ? codeOf(error) : fallbackCode;
  }
  try {
    row.observer(record as LiveCallRecord);
  } catch {
    // Observer errors never alter SDK stream/generator settlement.
  }
}

/** Wraps a synchronous `Readable`-returning method in an object-mode `PassThrough` gated on `row.gate`. */
function gateObjectStreamMethod(
  row: AdminRow,
  className: string,
  methodName: string,
  real: Method,
  options: StreamGateOptions = {},
): Method {
  const callName = `${className}.${methodName}`;
  const wrapped = keepShape(function gatedObjectStream(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) return Reflect.apply(real, this, args);
    const self = this;
    const ctx = options.observe === true ? options.context?.(callName, args, self) : undefined;
    let reachedSdk = false;
    let settled = false;
    let underlying: Readable | undefined;
    const proxy = new PassThrough({ objectMode: true });

    const finishOnce = (outcome: 'resolved' | 'rejected', error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (options.observe !== true) return;
      if (outcome === 'rejected' && !reachedSdk) return;
      emitObservedOutcome(row, callName, ctx, outcome, options.codeOf, error);
    };

    proxy.on('close', () => {
      if (underlying !== undefined && !underlying.destroyed) underlying.destroy();
    });

    row
      .gate(row.appOf(self), () => {
        if (proxy.destroyed) return undefined;
        return runInsideAdminCall(() => {
          const created = Reflect.apply(real, self, args) as Readable;
          reachedSdk = true;
          underlying = created;
          created.on('response', (...eventArgs: unknown[]) => {
            proxy.emit('response', ...eventArgs);
          });
          created.on('end', () => finishOnce('resolved'));
          created.on('error', (err: unknown) => {
            finishOnce('rejected', err);
            if (!proxy.destroyed) proxy.destroy(toError(err));
          });
          created.pipe(proxy);
          return created;
        });
      })
      .catch((err: unknown) => {
        if (!proxy.destroyed) proxy.destroy(toError(err));
      });

    return proxy;
  }, real);
  return markAdminMethodGated(wrapped);
}

/** Patches `prototype[methodName]` in place with {@link gateObjectStreamMethod} once. */
export function patchObjectStreamMethod(
  prototype: object | undefined,
  methodName: string,
  row: AdminRow,
  className: string,
  options: StreamGateOptions = {},
): void {
  if (prototype === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (typeof descriptor?.value !== 'function' || isAdminMethodGated(descriptor.value)) return;
  const wrapped = gateObjectStreamMethod(row, className, methodName, descriptor.value as Method, options);
  Object.defineProperty(prototype, methodName, { ...descriptor, value: wrapped });
}

/**
 * Gates a stream method that constructors overwrite per instance (such as
 * `@google-cloud/paginator`'s `streamify` properties on `Storage` and `Bucket`).
 */
export function gateInstanceStreamProperty(
  prototype: object | undefined,
  propertyName: string,
  row: AdminRow,
  className: string,
  options: StreamGateOptions = {},
): void {
  if (prototype === undefined) return;
  const existing = Object.getOwnPropertyDescriptor(prototype, propertyName);
  if (isAdminMethodGated(existing?.get)) return;
  let fallback: Method | undefined;
  if (typeof existing?.value === 'function') {
    fallback = gateObjectStreamMethod(row, className, propertyName, existing.value as Method, options);
  }
  const perInstance = new WeakMap<object, Method>();
  const getter = markAdminMethodGated(function getGatedStreamMethod(this: unknown): Method | undefined {
    if (isObject(this)) {
      const assigned = perInstance.get(this);
      if (assigned !== undefined) return assigned;
    }
    return fallback;
  });
  Object.defineProperty(prototype, propertyName, {
    configurable: true,
    enumerable: existing?.enumerable ?? false,
    get: getter,
    set(this: unknown, value: unknown) {
      if (!isObject(this) || typeof value !== 'function') return;
      perInstance.set(this, gateObjectStreamMethod(row, className, propertyName, value as Method, options));
    },
  });
}

/** Patches an `async function*` method (such as `CollectionGroup.getPartitions`) to await `row.gate` first. */
export function patchAsyncGeneratorMethod(
  prototype: object | undefined,
  methodName: string,
  row: AdminRow,
  className: string,
  options: StreamGateOptions = {},
): void {
  if (prototype === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (typeof descriptor?.value !== 'function' || isAdminMethodGated(descriptor.value)) return;
  const real = descriptor.value as (this: unknown, ...args: unknown[]) => AsyncIterable<unknown>;
  const callName = `${className}.${methodName}`;
  const wrapped = keepShape(async function* gatedAsyncGenerator(this: unknown, ...args: unknown[]): AsyncGenerator<unknown> {
    if (isObservingAdminCall()) {
      yield* Reflect.apply(real, this, args);
      return;
    }
    const ctx = options.observe === true ? options.context?.(callName, args, this) : undefined;
    await row.gate(row.appOf(this), () => undefined);
    const iterable = runInsideAdminCall(() => Reflect.apply(real, this, args));
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      while (true) {
        const step = await runInsideAdminCall(() => iterator.next());
        if (step.done === true) break;
        yield step.value;
      }
      if (options.observe === true) {
        emitObservedOutcome(row, callName, ctx, 'resolved', options.codeOf);
      }
    } catch (err) {
      if (options.observe === true) {
        emitObservedOutcome(row, callName, ctx, 'rejected', options.codeOf, err);
      }
      throw err;
    } finally {
      if (typeof iterator.return === 'function') {
        await runInsideAdminCall(() => iterator.return!());
      }
    }
  } as unknown as Method, real as unknown as Method);
  Object.defineProperty(prototype, methodName, { ...descriptor, value: markAdminMethodGated(wrapped) });
}

/** Gates `@google-cloud/storage` void duplex-upload starters (`startResumableUpload_`, `startSimpleUpload_`). */
export function patchVoidUploadMethod(
  prototype: object | undefined,
  methodName: string,
  gate: AdminProjectGate,
  appOf: (self: unknown) => AdminApp,
): void {
  if (prototype === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
  if (typeof descriptor?.value !== 'function' || isAdminMethodGated(descriptor.value)) return;
  const real = descriptor.value as Method;
  const wrapped = keepShape(function gatedVoidUpload(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) return Reflect.apply(real, this, args);
    const self = this;
    gate(appOf(self), () => runInsideAdminCall(() => Reflect.apply(real, self, args))).catch((err: unknown) => {
      const dup = args[0];
      const destroy: unknown = isObject(dup) ? Reflect.get(dup, 'destroy') : undefined;
      if (typeof destroy === 'function') Reflect.apply(destroy as Method, dup, [toError(err)]);
    });
    return undefined;
  }, real);
  Object.defineProperty(prototype, methodName, { ...descriptor, value: markAdminMethodGated(wrapped) });
}

export interface GatePrototypeConfig {
  readonly gate: AdminProjectGate;
  readonly appOf: (self: unknown) => AdminApp;
  readonly allowlist: ReadonlySet<string>;
  readonly nodeCallback?: boolean;
  readonly skipWhenObserving?: boolean;
}

/**
 * Sweeps `Object.getOwnPropertyNames(prototype)` and gates every non-allowlisted
 * own function not yet marked with `ADMIN_METHOD_GATED`.
 */
export function gatePrototypeMethods(prototype: object | undefined, config: GatePrototypeConfig): void {
  if (
    prototype === undefined ||
    prototype === Object.prototype ||
    prototype === Function.prototype ||
    prototype === EventEmitter.prototype
  ) {
    return;
  }
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || config.allowlist.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor === undefined || isAdminMethodGated(descriptor.get)) continue;
    const real: unknown = descriptor.value;
    if (typeof real !== 'function' || isAdminMethodGated(real)) continue;
    const wrapped = gatePromiseMethod(config.gate, config.appOf, real as Method, {
      nodeCallback: config.nodeCallback,
      skipWhenObserving: config.skipWhenObserving,
    });
    Object.defineProperty(prototype, name, { ...descriptor, value: wrapped });
  }
}
