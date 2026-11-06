/**
 * What the live-database row knows about `firebase/database`: where a call's
 * app, instance and path sit on the SDK's own objects, which calls production
 * never answers, how its errors spell production's status, and how its
 * listeners and `off()` take their callbacks.
 *
 * A reference has no path to its app: the SDK's `Repo` keeps none. So the row
 * notes each Database `getDatabase` hands the app, mapping its repo
 * (`db._repoInternal`) to `db.app`, and a record reads the repo from the
 * reference (`ref._repo`, an own field) and finds the app. It never reads
 * `db._repo`: that getter starts the repo, and `connectDatabaseEmulator` then
 * throws.
 *
 * The SDK calls its own functions through its own bindings (`push` calls
 * `set`, `runTransaction` calls `onValue`), so those calls never reach a
 * wrapper here.
 *
 * Reading never calls the app's code and never throws: an object without
 * these shapes gives a record without its project, account, instance or path.
 * This file imports no Firebase SDK.
 */
import { observedCall, UNOBSERVED, type CallContext, type ObservedSite } from './observe.js';

type Callback = (this: unknown, ...values: unknown[]) => unknown;
type Fields = Record<string, unknown>;

/** Each Database's repo, mapped to the app that owns it, as `getDatabase` handed it to the app. */
const APP_BY_REPO = new WeakMap<object, object>();

function isObject(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

/**
 * Notes the Database `getDatabase` returned: its repo belongs to its app.
 * Reads the `_repoInternal` field, never the `_repo` getter. Anything else is
 * ignored.
 */
export function noteDatabase(db: unknown): void {
  try {
    if (!isObject(db)) return;
    const repo = db._repoInternal;
    const app = db.app;
    if (isObject(repo) && isObject(app)) APP_BY_REPO.set(repo, app);
  } catch {
    // A value that throws on read is not a Database; the app's call is unchanged.
  }
}

/**
 * A reference's or query's repo: its own `_repo` field. A Database keeps
 * `_repo` as a getter that starts the repo, so only an own data property is
 * read.
 */
function repoOf(subject: unknown): Fields | undefined {
  if (!isObject(subject)) return undefined;
  const repo: unknown = Object.getOwnPropertyDescriptor(subject, '_repo')?.value;
  return isObject(repo) ? repo : undefined;
}

/** A reference's or query's path as the SDK prints it, `/items/a`, or undefined. */
function pathOf(subject: unknown): string | undefined {
  if (!isObject(subject)) return undefined;
  const path = subject._path;
  return isObject(path) ? String(path) : undefined;
}

/** Whether a path is under `/.info`, which the SDK answers itself and production never does. */
function isInfoPath(path: string | undefined): boolean {
  return path === '/.info' || (path?.startsWith('/.info/') ?? false);
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

/**
 * The instance a record names when the reference's repo does not say: 40
 * characters, longer than any instance name production gives, so it never
 * reads as the default instance or as one the project has. A host requires
 * an instance on every RTDB call, so the call still reaches Traffic.
 */
export const UNREAD_INSTANCE = 'instance-not-read-from-the-sdk-reference';

/**
 * A repo's instance: the SDK's namespace, lowercase. The SDK keeps the
 * namespace a `?ns=` URL parameter spells as written, and production's
 * instance names are lowercase, so `?ns=My-App` is the instance `my-app`.
 */
function instanceOf(repo: Fields | undefined): string {
  const namespace = stringAt(repo, ['repoInfo_', 'namespace']);
  return namespace === undefined ? UNREAD_INSTANCE : namespace.toLowerCase();
}

/** The record fields one repo gives a call: its app (whose Auth names the account), project and instance, which is always named. */
function repoContext(repo: Fields | undefined): CallContext {
  const instance = instanceOf(repo);
  const app = repo === undefined ? undefined : APP_BY_REPO.get(repo);
  const projectId = stringAt(app, ['options', 'projectId']);
  return {
    ...(app === undefined ? {} : { subject: app }),
    ...(projectId === undefined ? {} : { projectId }),
    instance,
  };
}

/** The OnDisconnect methods the row observes, recorded as `onDisconnect.<method>`. */
export const ON_DISCONNECT_METHODS = ['set', 'setWithPriority', 'update', 'remove', 'cancel'] as const;

const ON_DISCONNECT_PREFIX = 'onDisconnect.';

/**
 * The record context of one call: what its reference names, or `UNOBSERVED`
 * for a call production never answers. An OnDisconnect method reads its
 * reference's repo and path from `this`; every other call from its first
 * argument. A call under `/.info`, and a `push` with no value (which writes
 * nothing), make no record.
 */
export function databaseContext(name: string, args: readonly unknown[], self: unknown): CallContext | typeof UNOBSERVED {
  try {
    const source = name.startsWith(ON_DISCONNECT_PREFIX) ? self : args[0];
    const path = pathOf(source);
    const writesNothing = name === 'push' && (args[1] === undefined || args[1] === null);
    if (isInfoPath(path) || writesNothing) return UNOBSERVED;
    const context = repoContext(repoOf(source));
    return path === undefined ? context : { ...context, path };
  } catch {
    // A reference that throws on read is still recorded, without its context.
    return { instance: UNREAD_INSTANCE };
  }
}

/** A status as production spells it on the wire: lowercase letters and underscores, `permission_denied`. */
const WIRE_STATUS = /^[a-z_]+$/;
/** A message that starts with a status, `pyric_replay_no_recording: ...`. */
const STATUS_PREFIX = /^([a-z_]+):/;
/** The text production sends with a denied `get`, which the SDK rejects with as a bare message. */
const GET_DENIED_TEXT = 'Permission denied';

/**
 * Production's wire status for a database error, lowercase. It comes from the
 * error's `code` (`PERMISSION_DENIED` from writes, listener cancels and
 * OnDisconnect), then from a message that is a bare status (`runTransaction`
 * rejects with `new Error('permission_denied')`), then from the text a denied
 * `get` carries, then from a `status:` message prefix. Anything else is
 * `unknown`.
 */
export function databaseCode(error: unknown): string {
  try {
    if (!isObject(error)) return 'unknown';
    const code = error.code;
    if (typeof code === 'string' && code !== '') return code.toLowerCase();
    const message = error.message;
    if (typeof message !== 'string') return 'unknown';
    if (WIRE_STATUS.test(message)) return message;
    if (message === GET_DENIED_TEXT) return 'permission_denied';
    return STATUS_PREFIX.exec(message)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The listener arguments with the cancel callback third. RTDB listeners take
 * `(query, callback, cancelCallbackOrOptions, options)`; when the third is an
 * options object (the SDK reads any object, `null` included, as options), it
 * moves to the fourth, so the recording cancel callback can go third.
 */
export function databaseListenerArguments(args: unknown[]): unknown[] {
  const third = args[2];
  const isOptions = typeof third === 'object';
  if (!isOptions) return args;
  return [args[0], args[1], undefined, third];
}

/** The listener export each `off()` event type belongs to. */
const LISTENER_OF_EVENT: Readonly<Record<string, string>> = {
  value: 'onValue',
  child_added: 'onChildAdded',
  child_changed: 'onChildChanged',
  child_removed: 'onChildRemoved',
  child_moved: 'onChildMoved',
};

/** One app callback's recording callbacks: by repo, and, for a reference whose repo the row cannot read, by instance alone. */
interface Handed {
  readonly byRepo: WeakMap<object, Map<string, Callback>>;
  readonly unread: Map<string, Callback>;
}

/**
 * The callbacks the row handed the SDK for each app callback, by the repo and
 * the listener and path they listen with. One app callback listening twice on
 * the same reference gets the same recording callback twice, so the SDK sees
 * what it would see without live mode, and `off()` removes both. A reference
 * whose `_repo` the row cannot read is keyed by its instance and path
 * instead, so `off()` still finds the callback the SDK holds.
 */
const HANDED = new WeakMap<object, Handed>();

function handedKey(listener: string, instance: string, path: string | undefined): string {
  return JSON.stringify([listener, instance, path ?? null]);
}

/** The map that holds an app callback's recording callbacks for `query`'s repo, creating it when `create` is set. */
function handedFor(appCallback: object, query: unknown, create: boolean): Map<string, Callback> | undefined {
  let handed = HANDED.get(appCallback);
  if (handed === undefined) {
    if (!create) return undefined;
    handed = { byRepo: new WeakMap(), unread: new Map() };
    HANDED.set(appCallback, handed);
  }
  const repo = repoOf(query);
  if (repo === undefined) return handed.unread;
  let byListener = handed.byRepo.get(repo);
  if (byListener === undefined && create) {
    byListener = new Map();
    handed.byRepo.set(repo, byListener);
  }
  return byListener;
}

/** The key a listener's recording callback is kept under in its repo's map. */
function keyFor(listener: string, query: unknown): string {
  return handedKey(listener, instanceOf(repoOf(query)), pathOf(query));
}

/**
 * The recording callback for an app callback on one listener: the one
 * already handed the SDK for the same repo, listener and path, or a new one
 * `make` builds and the map keeps.
 */
export function databaseListenerCallback(name: string, args: readonly unknown[], appCallback: Callback, make: () => Callback): Callback {
  const handed = handedFor(appCallback, args[0], true)!;
  const key = keyFor(name, args[0]);
  const known = handed.get(key);
  if (known !== undefined) return known;
  const made = make();
  handed.set(key, made);
  return made;
}

/** The recording callback the row handed the SDK for `off(query, eventType, callback)`, or undefined. */
function handedForOff(args: readonly unknown[]): Callback | undefined {
  const [query, eventType, callback] = args;
  const isOneCallback = typeof eventType === 'string' && typeof callback === 'function';
  if (!isOneCallback) return undefined;
  const listener = LISTENER_OF_EVENT[eventType];
  if (listener === undefined) return undefined;
  return handedFor(callback, query, false)?.get(keyFor(listener, query));
}

/**
 * The row's `off`: `off(query, eventType, callback)` removes the recording
 * callback the row handed the SDK for that app callback. With no callback, or
 * one the row never wrapped (a `/.info` listener runs unwrapped), `off` runs
 * as the app called it. `off` makes no record.
 */
export function offByCallback(real: Callback): Callback {
  return function off(this: unknown, ...args: unknown[]): unknown {
    let handed: Callback | undefined;
    try {
      handed = handedForOff(args);
    } catch {
      handed = undefined;
    }
    if (handed === undefined) return Reflect.apply(real, this, args);
    return Reflect.apply(real, this, [args[0], args[1], handed]);
  };
}

/**
 * Observes the OnDisconnect `onDisconnect(ref)` returned: each of its five
 * methods becomes an own property that records the call as
 * `onDisconnect.<method>` and calls the SDK's method on it. The object stays
 * the SDK's own, so `instanceof OnDisconnect` holds.
 */
export function observeOnDisconnect(returned: unknown, site: Omit<ObservedSite, 'name'>): void {
  try {
    if (!isObject(returned)) return;
    for (const method of ON_DISCONNECT_METHODS) {
      const real = returned[method];
      if (typeof real !== 'function') continue;
      const observed = observedCall({ ...site, name: `${ON_DISCONNECT_PREFIX}${method}` }, real as Callback);
      Object.defineProperty(returned, method, { value: observed, writable: true, configurable: true, enumerable: false });
    }
  } catch {
    // An OnDisconnect the row cannot observe is still the SDK's own.
  }
}
