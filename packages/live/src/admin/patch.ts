/**
 * The prototype patcher every Admin row shares (A-4 to A-7 in the #2304
 * plan). firebase-admin reaches its services through package-internal
 * `require`s, so a row patches the classes the real module defines rather
 * than wrap exports, and `admin.firestore()` and `getFirestore()` reach the
 * same wrappers.
 *
 * Each prototype is patched once and marked. A wrapper keeps the real
 * method's `name`, `length` and `this`. It awaits the project gate for the
 * call's Admin app, then calls the real method through `observedCall` (or
 * `observedListener`), so the record names `<Class>.<method>` and carries
 * `sdk: 'admin'`. The SDK's results come back untouched: a promise comes
 * back as one that settles the same way. A call the gate refuses rejects
 * with `PYRIC_LIVE_REFUSED` before the real method runs, and makes no record.
 *
 * A wrapped method that calls another wrapped method, as
 * `DocumentReference.get` calls `Firestore.getAll`, makes one record: calls
 * made while an observed call runs go to the real method. The app's own
 * callbacks run outside that scope: a listener's deliveries, and the update
 * function `runTransaction` calls. So the app's calls from them are gated and
 * recorded, while the SDK's internal calls stay nested. A listener returns
 * its unsubscribe at once and subscribes once the gate passes; a refusal goes
 * to the app's error callback, or to `console.error` as the SDK does without one.
 *
 * Node only: the Admin SDK runs in a Node process.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { observedCall, observedListener, type LiveObserver, type ObservedHooks } from '../observe.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** Where one Admin row's records go, and how its calls reach the gate. */
export interface AdminRow {
  /** The module a record names, the load the row patches, such as `@google-cloud/firestore`. */
  readonly module: string;
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
  /** The Admin app a call's `this` belongs to, as the gate reads it. */
  readonly appOf: (self: unknown) => AdminApp;
}

/** One method a row observes: its name on the prototype, whether it is a listener, and the hooks its records need. */
export interface AdminMethod extends ObservedHooks {
  readonly name: string;
  readonly listener?: boolean;
}

const PATCHED = Symbol.for('pyric.live.admin.patched');

/** Set while an observed Admin call runs, so the SDK's own nested calls make no record. */
const observing = new AsyncLocalStorage<true>();

/** Gives `wrapper` the real method's `name` and `length`. */
export function keepShape(wrapper: Method, real: Method): Method {
  Object.defineProperty(wrapper, 'name', { value: real.name, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: real.length, configurable: true });
  return wrapper;
}

function siteOf(row: AdminRow, className: string, method: AdminMethod) {
  const { name, listener: _listener, ...hooks } = method;
  return { ...hooks, module: row.module, name: `${className}.${name}`, observer: row.observer, sdk: 'admin' as const };
}

/** A one-shot call: gated, observed, and the only record for the SDK calls it makes. */
function gatedCall(row: AdminRow, className: string, method: AdminMethod, real: Method): Method {
  const observed = observedCall(siteOf(row, className, method), real);
  return keepShape(function adminCall(this: unknown, ...args: unknown[]): unknown {
    const isNested = observing.getStore() === true;
    if (isNested) return Reflect.apply(real, this, args);
    const appArgs = outsideScope(args);
    return observing.run(true, () => row.gate(row.appOf(this), () => Reflect.apply(observed, this, appArgs)));
  }, real);
}

/** The app's error callback: the first function after the first one. */
function errorCallbackOf(args: readonly unknown[]): Method | undefined {
  const first = args.findIndex((arg) => typeof arg === 'function');
  const after = first === -1 ? [] : args.slice(first + 1);
  return after.find((arg): arg is Method => typeof arg === 'function');
}

/**
 * The app's callbacks, each run outside the observed-call scope. The SDK's
 * streams can carry the scope of the call that opened its connection, so a
 * delivery would otherwise look nested and the app's calls from it would
 * make no record.
 */
export function outsideScope(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg !== 'function') return arg;
    return function appCallback(this: unknown, ...values: unknown[]): unknown {
      return observing.exit(() => Reflect.apply(arg, this, values));
    };
  });
}

/** A listener: subscribes once the gate passes, and returns an unsubscribe that works before and after. */
function gatedListener(row: AdminRow, className: string, method: AdminMethod, real: Method): Method {
  const observed = observedListener(siteOf(row, className, method), real);
  return keepShape(function adminListener(this: unknown, ...args: unknown[]): unknown {
    const isNested = observing.getStore() === true;
    if (isNested) return Reflect.apply(real, this, args);
    let stopped = false;
    let unsubscribe: unknown;
    const subscribe = () => {
      if (!stopped) unsubscribe = Reflect.apply(observed, this, outsideScope(args));
    };
    row.gate(row.appOf(this), subscribe).catch((error: unknown) => {
      // With no error callback, the SDK itself logs a listener error with console.error.
      if (!stopped) (errorCallbackOf(args) ?? console.error)(error);
    });
    return () => {
      stopped = true;
      if (typeof unsubscribe === 'function') Reflect.apply(unsubscribe, undefined, []);
    };
  }, real);
}

/**
 * Patches `methods` on `prototype` once, naming records `<className>.<method>`.
 * Returns false when the prototype is missing or already patched. A method
 * the prototype does not define itself is left alone.
 */
export function patchAdminClass(prototype: object | undefined, className: string, methods: readonly AdminMethod[], row: AdminRow): boolean {
  const isPatchable = prototype !== undefined && !Object.hasOwn(prototype, PATCHED);
  if (!isPatchable) return false;
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method.name);
    const real = descriptor?.value as unknown;
    if (typeof real !== 'function') continue;
    const wrap = method.listener === true ? gatedListener : gatedCall;
    Object.defineProperty(prototype, method.name, { ...descriptor, value: wrap(row, className, method, real as Method) });
  }
  Object.defineProperty(prototype, PATCHED, { value: true });
  return true;
}
