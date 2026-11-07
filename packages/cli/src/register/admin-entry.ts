/**
 * Where the passed-through Admin SDK's call enters the network, for the live
 * guard (`./live-net-guard.ts`). An app may wrap `http.request`,
 * `https.request`, `tls.connect` or `fetch` (OpenTelemetry's HTTP
 * instrumentation, an APM agent, a request logger), and then the wrapper's
 * file, not the Admin SDK's, is the nearest caller of the runtime's function
 * (#2445). So the guard decides the Admin SDK's call at two points:
 *
 * - the entry: each property is an accessor that hands out its function
 *   marked. When a file of the Admin SDK's tree calls the mark, the mark
 *   records one pending Admin call and the target it names (host and path).
 *   A wrapper installed later, by assignment or by `Object.defineProperty`
 *   or `Reflect.defineProperty` with a data descriptor (shimmer, which
 *   OpenTelemetry uses), is kept and marked the same way.
 * - the base: the function the guard found there at install, wrapped. The
 *   first call that reaches any base while an Admin call is pending spends
 *   it. That call is the Admin SDK's only when it is to the same entry point
 *   and names the same target; then it, and the checks the runtime makes
 *   before it returns, read as the Admin SDK's ({@link isAdminCallRunning}).
 *
 * Every other call is decided by its nearest caller. A wrapper that sends its
 * own request before it forwards the Admin SDK's gets that request refused,
 * and the Admin SDK's too, since the first call spent the pending one: the
 * guard fails closed. So does a wrapper that defers the real call past the
 * entry (an `await` before it forwards), and one installed as an accessor.
 *
 * Imports node built-ins and side-effect-free modules only.
 */
import { normalizeHostname } from '../google-endpoints.js';

/** One property holding a network entry point: `https.request`, `http.request`, `tls.connect` or `globalThis.fetch`. */
export interface AdminEntryPoint {
  readonly object: object;
  readonly key: string;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** An Admin call recorded at the entry and not yet spent at a base. */
interface PendingAdminCall {
  readonly key: string;
  readonly target: string;
}

let pending: PendingAdminCall | null = null;

/** How many authorized Admin calls into a base are running; each is synchronous. */
let runningAdminCalls = 0;

/** Whether an Admin call the entry recorded and its base let through is running now. */
export function isAdminCallRunning(): boolean {
  return runningAdminCalls > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `path` without its query or fragment. */
function barePath(path: string): string {
  return path.replace(/[?#].*$/, '');
}

function urlTarget(value: unknown): string | null {
  const text = value instanceof URL ? value.href : typeof value === 'string' ? value : null;
  if (text === null) return null;
  try {
    const url = new URL(text);
    return `${normalizeHostname(url.hostname)}${url.pathname}`;
  } catch {
    return null;
  }
}

/** The host an options object names, without a port. */
function optionsHost(options: Record<string, unknown>): string | null {
  const host = options.hostname ?? options.host ?? options.servername;
  if (typeof host !== 'string' || host === '') return null;
  const withoutPort = host.startsWith('[') ? host : host.replace(/:\d+$/, '');
  return normalizeHostname(withoutPort);
}

/** `http.request(url?, options?, callback?)`'s host and path, as Node merges them. */
function requestTarget(args: readonly unknown[]): string | null {
  const [first, second] = args;
  const fromUrl = urlTarget(first);
  const options = isObject(first) && !(first instanceof URL) ? first : isObject(second) ? second : null;
  if (options === null) return fromUrl;
  const host = optionsHost(options);
  const path = typeof options.path === 'string' ? barePath(options.path) : null;
  if (fromUrl !== null && host === null && path === null) return fromUrl;
  if (host === null) return null;
  return `${host}${path ?? '/'}`;
}

/** `tls.connect(options)` or `tls.connect(port, host?, options?)`'s host. */
function connectTarget(args: readonly unknown[]): string | null {
  const [first, second, third] = args;
  if (isObject(first)) return optionsHost(first);
  if (typeof second === 'string') return normalizeHostname(second);
  return isObject(third) ? optionsHost(third) : null;
}

/** `fetch(input)`'s host and path. */
function fetchTarget(args: readonly unknown[]): string | null {
  const [input] = args;
  const isRequest = isObject(input) && typeof input.url === 'string';
  return urlTarget(isRequest ? input.url : input);
}

/** What one call to the entry point at `key` is for, or null when it cannot be read. */
function targetOf(key: string, args: readonly unknown[]): string | null {
  if (key === 'fetch') return fetchTarget(args);
  if (key === 'connect') return connectTarget(args);
  return requestTarget(args);
}

const MARKED = Symbol('pyric.live.adminEntry');

/** Keeps `real`'s `name`, `length`, and anything a caller reads off it (`fetch.preconnect`, shimmer's `__original`). */
function keepShape(wrapper: AnyFunction, real: AnyFunction): AnyFunction {
  Object.setPrototypeOf(wrapper, real);
  defineOwn(wrapper, 'name', { value: real.name });
  defineOwn(wrapper, 'length', { value: real.length });
  defineOwn(wrapper, MARKED, { value: true });
  return wrapper;
}

/**
 * `entry`, marked: when `isAdminCaller` says a file of the Admin SDK's tree
 * called it and no Admin call is pending, it records one for the target the
 * call names until the call returns.
 */
function markEntry(key: string, entry: unknown, isAdminCaller: () => boolean): unknown {
  const isFunction = typeof entry === 'function';
  if (!isFunction || Reflect.get(entry, MARKED) === true) return entry;
  const fn = entry as AnyFunction;
  const marked = function (this: unknown, ...args: unknown[]): unknown {
    const canRecord = pending === null && runningAdminCalls === 0;
    const target = canRecord && isAdminCaller() ? targetOf(key, args) : null;
    if (target === null) return Reflect.apply(fn, this, args);
    pending = { key, target };
    try {
      return Reflect.apply(fn, this, args);
    } finally {
      pending = null;
    }
  };
  return keepShape(marked, fn);
}

/** The function the guard found at `key`, wrapped so the first call to reach it spends the pending Admin call. */
function baseEntry(key: string, real: unknown): unknown {
  if (typeof real !== 'function') return real;
  const fn = real as AnyFunction;
  const base = function (this: unknown, ...args: unknown[]): unknown {
    const spent = pending;
    pending = null;
    const isAdminCall = spent !== null && spent.key === key && spent.target === targetOf(key, args);
    if (!isAdminCall) return Reflect.apply(fn, this, args);
    runningAdminCalls += 1;
    try {
      return Reflect.apply(fn, this, args);
    } finally {
      runningAdminCalls -= 1;
    }
  };
  return keepShape(base, fn);
}

/** One guarded property: the function there now, and how to take a new one. */
interface EntrySlot {
  take(next: unknown): void;
}

/** The guarded properties, by object and key, so a data descriptor for one goes to its slot. */
const slots = new WeakMap<object, Map<PropertyKey, EntrySlot>>();

const realDefineProperty = Object.defineProperty;
const realDefineProperties = Object.defineProperties;
const realReflectDefine = Reflect.defineProperty;

function defineOwn(object: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  realDefineProperty(object, key, { configurable: true, ...descriptor });
}

function slotOf(object: unknown, key: PropertyKey): EntrySlot | undefined {
  return isObject(object) || typeof object === 'function' ? slots.get(object as object)?.get(key) : undefined;
}

/**
 * Whether a descriptor only sets a value, as shimmer's does. An accessor, or
 * a descriptor that makes the property non-configurable, goes through as
 * written and drops the slot: the guard then fails closed for that entry.
 */
function isValueOnly(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
  if (descriptor === undefined || !('value' in descriptor)) return false;
  return descriptor.configurable !== false && descriptor.get === undefined && descriptor.set === undefined;
}

/** Takes a data descriptor for a guarded property into its slot; false for any other define. */
function tookDefine(object: unknown, key: PropertyKey, descriptor: PropertyDescriptor | undefined): boolean {
  const slot = slotOf(object, key);
  if (slot === undefined) return false;
  if (isValueOnly(descriptor)) {
    slot.take(descriptor.value);
    return true;
  }
  slots.get(object as object)?.delete(key);
  return false;
}

let defineHooks = 0;

/** Routes `Object.defineProperty`, `Object.defineProperties` and `Reflect.defineProperty` on a guarded property to its slot. */
function hookDefines(): () => void {
  defineHooks += 1;
  if (defineHooks === 1) {
    Object.defineProperty = function defineProperty<T>(object: T, key: PropertyKey, descriptor: PropertyDescriptor & ThisType<unknown>): T {
      if (tookDefine(object, key, descriptor)) return object;
      return realDefineProperty(object, key, descriptor);
    };
    Object.defineProperties = function defineProperties<T>(object: T, descriptors: PropertyDescriptorMap & ThisType<unknown>): T {
      const rest: PropertyDescriptorMap = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
        if (!tookDefine(object, key, descriptor)) Reflect.set(rest, key, descriptor);
      }
      return realDefineProperties(object, rest);
    };
    Reflect.defineProperty = function defineProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
      if (tookDefine(object, key, descriptor)) return true;
      return realReflectDefine(object, key, descriptor);
    };
  }
  return () => {
    defineHooks -= 1;
    if (defineHooks > 0) return;
    Object.defineProperty = realDefineProperty;
    Object.defineProperties = realDefineProperties;
    Reflect.defineProperty = realReflectDefine;
  };
}

/**
 * Guards each entry point: its base is wrapped ({@link baseEntry}), and the
 * property becomes an accessor that hands out the function there now,
 * marked ({@link markEntry}), whether the app assigns it or defines it.
 * `isAdminCaller` reads the nearest caller. Returns a function that puts
 * each property back as a plain value holding the function there then.
 */
export function guardAdminEntryPoints(entryPoints: readonly AdminEntryPoint[], isAdminCaller: () => boolean): () => void {
  const restores: Array<() => void> = [];
  for (const { object, key } of entryPoints) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const isPlainValue = descriptor !== undefined && 'value' in descriptor && descriptor.configurable === true;
    if (!isPlainValue) continue;
    let current = baseEntry(key, descriptor.value);
    let marked = markEntry(key, current, isAdminCaller);
    const slot: EntrySlot = {
      take(next) {
        current = next;
        marked = markEntry(key, next, isAdminCaller);
      },
    };
    const byKey = slots.get(object) ?? new Map<PropertyKey, EntrySlot>();
    byKey.set(key, slot);
    slots.set(object, byKey);
    realDefineProperty(object, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get: () => marked,
      set: (next: unknown) => slot.take(next),
    });
    restores.push(() => {
      slots.get(object)?.delete(key);
      realDefineProperty(object, key, { ...descriptor, value: current });
    });
  }
  const unhook = hookDefines();
  return () => {
    for (const restore of restores) restore();
    unhook();
  };
}
