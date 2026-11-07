/**
 * The Admin RTDB row: patches the classes of the real
 * `@firebase/database-compat/standalone` that firebase-admin loads
 * (`patch.ts`), so each Admin call makes a record named `<Class>.<method>`
 * with the instance and path it touched, the project, and production's
 * status as the client database row spells it (`permission_denied`).
 *
 * Observed: `Query` `get`, `once` and `on` (one record per delivery);
 * `Reference` `set`, `update`, `remove`, `transaction`, `setWithPriority` and
 * `push`. `off` makes no record: it removes the recording callback the row
 * handed the SDK for the app's callback, as the client row's `off` does.
 * Calls under `/.info`, which production never answers, and a `push` with no
 * value, which writes nothing, make no record.
 *
 * Every call waits for the project gate, which resolves the project of the
 * call's firebase-admin app through the app's own options and credential.
 * `on` returns the app's callback at once and listens once the gate passes;
 * `push` returns its reference with the new key at once and writes once the
 * gate passes. The connection itself opens at `db.ref()`, before any call.
 *
 * A record never carries a data value: no write data and no returned value.
 */
import { databaseCode, databaseContext, databaseListenerArguments, databaseListenerCallback, offByCallback } from '../database.js';
import { observedCall, observedListener, UNOBSERVED, type CallContext, type LiveObserver } from '../observe.js';
import { keepShape, outsideScope, patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

/** The module an Admin RTDB record names: the load the row patches. */
export const ADMIN_DATABASE_MODULE = '@firebase/database-compat/standalone';

type Method = (this: unknown, ...args: unknown[]) => unknown;

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function fieldOf(subject: unknown, field: string): unknown {
  return isObject(subject) ? Reflect.get(subject, field) : undefined;
}

/** The modular query or reference a compat `Query` or `Reference` wraps. */
function delegateOf(self: unknown): unknown {
  return fieldOf(self, '_delegate');
}

/** Each firebase-admin app's stand-in for the gate, read once: its project and its own credential. */
const apps = new WeakMap<object, AdminApp>();
const NO_APP: AdminApp = { options: {} };

/**
 * The Admin app a call belongs to, for the gate: the firebase-admin app the
 * compat Database was made for (`initStandalone(app, ...)`). Its `options`
 * getter copies the options but keeps the credential object, so the gate
 * resolves the project as firebase-admin does: `options.projectId`, a
 * `cert()` credential's, the project variables, then the credential's own
 * `getProjectId()`.
 */
function appOf(self: unknown): AdminApp {
  const app = fieldOf(fieldOf(self, 'database'), 'app');
  if (!isObject(app)) return NO_APP;
  const known = apps.get(app);
  if (known !== undefined) return known;
  const options = fieldOf(app, 'options');
  const projectId = fieldOf(options, 'projectId');
  const credential = fieldOf(options, 'credential');
  const named = typeof projectId === 'string' && projectId !== '' ? { projectId } : {};
  const adminApp: AdminApp = { options: isObject(credential) ? { ...named, credential } : named };
  apps.set(app, adminApp);
  return adminApp;
}

/** One call's context: the client row's instance and path, read from the delegate, and the app's project. */
function contextOf(_name: string, _args: readonly unknown[], self: unknown): CallContext | typeof UNOBSERVED {
  const context = databaseContext('get', [delegateOf(self)], undefined);
  if (context === UNOBSERVED) return context;
  const { subject: _subject, ...place } = context;
  const projectId = appOf(self).options.projectId;
  return projectId === undefined ? place : { ...place, projectId };
}

const HOOKS = { context: contextOf, codeOf: databaseCode, throwsLocally: true } as const;

function calls(...names: string[]): AdminMethod[] {
  return names.map((name) => ({ name, ...HOOKS }));
}

/** The site a custom wrapper records under, as `patch.ts` builds one. */
function siteOf(row: AdminRow, name: string) {
  return { ...HOOKS, module: row.module, name, observer: row.observer, sdk: 'admin' as const };
}

/** The listener export of the client row each compat event type matches, for `off` by callback. */
const LISTENER_OF_EVENT: Readonly<Record<string, string>> = {
  value: 'onValue',
  child_added: 'onChildAdded',
  child_changed: 'onChildChanged',
  child_removed: 'onChildRemoved',
  child_moved: 'onChildMoved',
};

/** A listen waiting for the gate, which an `off` before it passes stops. */
interface PendingListen {
  readonly delegate: unknown;
  readonly eventType: string;
  readonly callback: unknown;
  stopped: boolean;
}

const pending = new Set<PendingListen>();

function samePlace(a: unknown, b: unknown): boolean {
  const sameRepo = fieldOf(a, '_repo') === fieldOf(b, '_repo');
  return sameRepo && String(fieldOf(a, '_path')) === String(fieldOf(b, '_path'));
}

/** Stops each pending listen `off(eventType, callback)` on `self` names; either may be absent, as `off` takes them. */
function stopPending(self: unknown, eventType: unknown, callback: unknown): void {
  const delegate = delegateOf(self);
  for (const listen of pending) {
    const isNamed = (eventType === undefined || eventType === listen.eventType) && (callback === undefined || callback === listen.callback);
    if (isNamed && samePlace(listen.delegate, delegate)) listen.stopped = true;
  }
}

/** The app's cancel callback, bound to its context, or `console.error` as the SDK warns without one. */
function cancelOf(args: readonly unknown[]): (error: unknown) => void {
  const [, , cancel, context] = args;
  if (typeof cancel !== 'function') return (error) => console.error(error);
  const self = isObject(context) ? context : undefined;
  return (error) => Reflect.apply(cancel, self, [error]);
}

/**
 * `Query.on`: returns the app's callback at once, as the SDK does, and
 * listens once the gate passes, with recording callbacks the client row's
 * `off` lookup can find by the app's callback. A refusal goes to the app's
 * cancel callback.
 */
function gatedOn(row: AdminRow, real: Method): Method {
  return keepShape(function on(this: unknown, ...args: unknown[]): unknown {
    const [eventType, callback] = args;
    const listener = typeof eventType === 'string' ? LISTENER_OF_EVENT[eventType] : undefined;
    const isListen = listener !== undefined && typeof callback === 'function';
    if (!isListen) return Reflect.apply(real, this, args);
    const delegate = delegateOf(this);
    const listen: PendingListen = { delegate, eventType: eventType as string, callback, stopped: false };
    pending.add(listen);
    const site = {
      ...siteOf(row, 'Query.on'),
      listenerArguments: databaseListenerArguments,
      listenerCallback: (_name: string, _args: readonly unknown[], _appCallback: Method, make: () => Method) => databaseListenerCallback(listener, [delegate], callback as Method, make),
    };
    const observed = observedListener(site, real);
    const subscribe = () => {
      pending.delete(listen);
      if (!listen.stopped) Reflect.apply(observed, this, outsideScope(args));
    };
    row.gate(appOf(this), subscribe).catch((error: unknown) => {
      pending.delete(listen);
      if (!listen.stopped) cancelOf(args)(error);
    });
    return callback;
  }, real);
}

/** `Query.off`: stops a listen still waiting for the gate, and removes the recording callback the row handed the SDK. */
function patchedOff(real: Method): Method {
  return keepShape(function off(this: unknown, ...args: unknown[]): unknown {
    const [eventType, callback, context] = args;
    stopPending(this, eventType, callback);
    const remove = (_query: unknown, _eventType: unknown, handed: unknown) => {
      const isHanded = handed !== callback;
      return Reflect.apply(real, this, isHanded ? [eventType, handed, context] : args);
    };
    return offByCallback(remove)(delegateOf(this), eventType, callback);
  }, real);
}

/**
 * `Reference.push`: returns the new reference at once, as the SDK does, with
 * its key picked locally, and writes the value once the gate passes. The
 * returned reference settles as the SDK's does, to a reference with that key.
 */
function gatedPush(row: AdminRow, realPush: Method, realSet: Method): Method {
  const write = observedCall(siteOf(row, 'Reference.push'), function write(this: unknown, child: unknown, value: unknown): unknown {
    return Reflect.apply(realSet, child, [value]);
  });
  return keepShape(function push(this: unknown, ...args: unknown[]): unknown {
    const [value, onComplete] = args;
    const writesNothing = value === undefined || value === null;
    if (writesNothing) return Reflect.apply(realPush, this, args);
    const child = Reflect.apply(realPush, this, []) as Record<string, unknown>;
    const key = child.key;
    const written = row.gate(appOf(this), () => Reflect.apply(write, this, [child, value]));
    const settled = written.then(() => Reflect.apply(fieldOf(this, 'child') as Method, this, [key]));
    if (typeof onComplete === 'function') settled.then(() => onComplete(null), (error: unknown) => onComplete(error));
    child.then = settled.then.bind(settled);
    child.catch = settled.catch.bind(settled);
    return child;
  }, realPush);
}

/** Where the records go and which gate the calls pass. */
export interface AdminDatabaseRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

function prototypeOf(sdk: unknown, className: string): Record<string, unknown> | undefined {
  const prototype = fieldOf(fieldOf(sdk, className), 'prototype');
  return isObject(prototype) ? (prototype as Record<string, unknown>) : undefined;
}

/** Replaces one method on a prototype the row just patched, keeping its descriptor. */
function replace(prototype: Record<string, unknown>, name: string, wrap: (real: Method) => Method): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (typeof descriptor?.value !== 'function') return;
  Object.defineProperty(prototype, name, { ...descriptor, value: wrap(descriptor.value as Method) });
}

/**
 * Patches the real `@firebase/database-compat/standalone` module `sdk` once.
 * Later calls change nothing.
 */
export function observeAdminDatabase(sdk: unknown, row: AdminDatabaseRow): void {
  const adminRow: AdminRow = { module: ADMIN_DATABASE_MODULE, observer: row.observer, gate: row.gate, appOf };
  const query = prototypeOf(sdk, 'Query');
  if (query !== undefined && patchAdminClass(query, 'Query', calls('get', 'once'), adminRow)) {
    replace(query, 'on', (real) => gatedOn(adminRow, real));
    replace(query, 'off', patchedOff);
  }
  const reference = prototypeOf(sdk, 'Reference');
  const realSet = reference?.set;
  if (reference !== undefined && patchAdminClass(reference, 'Reference', calls('set', 'update', 'remove', 'transaction', 'setWithPriority'), adminRow)) {
    replace(reference, 'push', (real) => gatedPush(adminRow, real, realSet as Method));
  }
}
