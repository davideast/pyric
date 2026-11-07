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
 * gate passes. The connection itself opens at `db.ref()`, before any call,
 * so `Database.ref`, `refFromURL` and `goOnline` gate it too: an app that
 * names another project is refused there, and an app whose credential works
 * out its project stays offline until the gate passes, or longer if it went
 * offline itself meanwhile. No frame reaches another project's instance,
 * `setPriority` and `onDisconnect()` included.
 *
 * A record never carries a data value: no write data and no returned value.
 */
import { databaseCode, databaseContext, databaseListenerArguments, databaseListenerCallback, offByCallback } from '../database.js';
import { observedCall, observedListener, UNOBSERVED, type CallContext, type LiveObserver } from '../observe.js';
import { keepShape, outsideScope, patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import { liveAdminProjectRefusal, type AdminProjectSource } from '../refusal.js';
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
  return adminAppOf(fieldOf(fieldOf(self, 'database'), 'app'));
}

/** The gate's stand-in for one firebase-admin app, made once. */
function adminAppOf(app: unknown): AdminApp {
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

/** Where the records go, which gate the calls pass, and the live host's project the connection gate compares. */
export interface AdminDatabaseRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
  readonly hostProjectId: string;
}

/** The row with the real, unpatched `goOnline` and `goOffline`, which the connection gate calls itself. */
interface ConnectionRow extends AdminDatabaseRow {
  readonly goOnline: Method;
  readonly goOffline: Method;
}

/** What the connection gate knows of each compat Database: passed, waiting for the gate, or its refusal. */
const connections = new WeakMap<object, 'passed' | 'waiting' | Error>();

/** Databases the app took offline itself before the gate passed: the gate leaves them offline. */
const offlineByApp = new WeakSet<object>();

/** The project an app names without waiting, as the gate reads it first: `options.projectId`, then a `cert()` credential's. */
function namedProject(app: AdminApp): { source: AdminProjectSource; projectId: string } | undefined {
  const { projectId, credential } = app.options;
  if (typeof projectId === 'string' && projectId !== '') return { source: 'options.projectId', projectId };
  const certProject = fieldOf(credential, 'projectId');
  return typeof certProject === 'string' && certProject !== '' ? { source: 'credential', projectId: certProject } : undefined;
}

/**
 * Holds the connection of a Database whose project is not named until its
 * credential's `getProjectId()` answers: it goes offline before the SDK's
 * connect timer runs, and online once the gate passes, unless the app took
 * it offline itself meanwhile.
 */
function holdConnection(row: ConnectionRow, db: object, app: AdminApp): void {
  connections.set(db, 'waiting');
  Reflect.apply(row.goOffline, db, []);
  const goOnline = () => {
    connections.set(db, 'passed');
    if (!offlineByApp.has(db)) Reflect.apply(row.goOnline, db, []);
  };
  row.gate(app, goOnline).catch((error: unknown) => {
    connections.set(db, error instanceof Error ? error : new Error(String(error)));
  });
}

/**
 * The connection gate, run by `ref()`, `refFromURL()` and `goOnline()`
 * before the SDK opens the connection there and sends the credential. An
 * app that names another project is refused at once, and the gate writes
 * its one line; an app whose project its credential works out stays offline
 * until the gate passes, and its later calls here are refused once it refuses.
 */
function gateConnection(row: ConnectionRow, db: object): void {
  const known = connections.get(db);
  if (known instanceof Error) throw known;
  if (known !== undefined) return;
  const app = adminAppOf(fieldOf(db, 'app'));
  const named = namedProject(app);
  if (named === undefined) {
    holdConnection(row, db, app);
    return;
  }
  if (named.projectId === row.hostProjectId) {
    connections.set(db, 'passed');
    return;
  }
  const refusal = liveAdminProjectRefusal({ source: named.source, appProjectId: named.projectId, hostProjectId: row.hostProjectId });
  connections.set(db, refusal);
  row.gate(app, () => undefined).catch(() => undefined);
  throw refusal;
}

function gatedRef(row: ConnectionRow, real: Method): Method {
  return keepShape(function ref(this: unknown, ...args: unknown[]): unknown {
    if (isObject(this)) gateConnection(row, this);
    return Reflect.apply(real, this, args);
  }, real);
}

/**
 * `Database.goOnline`, which starts the repo and resumes the connection
 * without `ref()`: it passes the connection gate first, and while the gate
 * is still working out the project it only undoes the app's own `goOffline`,
 * so the hold resumes the connection when the gate passes.
 */
function gatedGoOnline(row: ConnectionRow): Method {
  return keepShape(function goOnline(this: unknown, ...args: unknown[]): unknown {
    if (!isObject(this)) return Reflect.apply(row.goOnline, this, args);
    offlineByApp.delete(this);
    gateConnection(row, this);
    const hasPassed = connections.get(this) === 'passed';
    return hasPassed ? Reflect.apply(row.goOnline, this, args) : undefined;
  }, row.goOnline);
}

/** `Database.goOffline`: before the gate passes, it marks the Database so the gate leaves it offline. */
function trackedGoOffline(row: ConnectionRow): Method {
  return keepShape(function goOffline(this: unknown, ...args: unknown[]): unknown {
    const isGateOpen = isObject(this) && connections.get(this) === 'passed';
    if (isObject(this) && !isGateOpen) offlineByApp.add(this);
    return Reflect.apply(row.goOffline, this, args);
  }, row.goOffline);
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
  const database = prototypeOf(sdk, 'Database');
  const goOnline = database?.goOnline;
  const goOffline = database?.goOffline;
  const hasConnection = typeof goOnline === 'function' && typeof goOffline === 'function';
  if (database !== undefined && hasConnection && patchAdminClass(database, 'Database', [], adminRow)) {
    const connectionRow: ConnectionRow = { ...row, goOnline: goOnline as Method, goOffline: goOffline as Method };
    replace(database, 'ref', (real) => gatedRef(connectionRow, real));
    replace(database, 'refFromURL', (real) => gatedRef(connectionRow, real));
    replace(database, 'goOnline', () => gatedGoOnline(connectionRow));
    replace(database, 'goOffline', () => trackedGoOffline(connectionRow));
  }
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
