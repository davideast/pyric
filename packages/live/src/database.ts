/**
 * What the live-database row knows about `firebase/database`: where a call's
 * app, instance and path sit on the SDK's own objects, which calls production
 * never answers, how its errors spell production's status, and how its
 * listeners and `off()` take their callbacks.
 *
 * `getDatabase` on an app whose config names another project, or on a URL
 * naming another project's default instance, is refused before the SDK's
 * factory runs (`guardedGetDatabase`).
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
 * A listener names its path and the SDK's journal key (instance, path, query
 * identifier) so its attach and detach reach the host. `off()` ends the SDK's
 * registrations without calling an unsubscribe, so the row holds each
 * attached listener by instance and path and detaches the ones `off()` ends,
 * matching the SDK's rule: a callback ends the first match in each view, and
 * the default query reaches every view at its path.
 *
 * Reading never calls the app's code and never throws: an object without
 * these shapes gives a record without its project, account, instance or path.
 * This file imports no Firebase SDK.
 */
import { isPlainObject, jsonValue } from './json-copy.js';
import { observedCall, refusedFactory, UNOBSERVED, type CallContext, type ListenerIdentity, type LiveWriteValue, type ObservedSite } from './observe.js';
import { databaseWriteSession } from './database-session-capture.js';

type Callback = (this: unknown, ...values: unknown[]) => unknown;
type Fields = Record<string, unknown>;

/** Each Database's repo, mapped to the app that owns it, as `getDatabase` handed it to the app. */
const APP_BY_REPO = new WeakMap<object, object>();

export function isObject(value: unknown): value is Fields {
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

/** The value of the last `ns` parameter in a query, decoded as the SDK's `decodeQuery` decodes it. A bad escape throws. */
function namespaceParameter(query: string): string | undefined {
  let namespace: string | undefined;
  for (const segment of query.split('&')) {
    const pair = segment.split('=');
    const isNamespace = pair.length === 2 && decodeURIComponent(pair[0]!) === 'ns';
    if (isNamespace) namespace = decodeURIComponent(pair[1]!);
  }
  return namespace;
}

/** The namespace a host names: the first label of a host with three or more, never `localhost`. */
function hostNamespace(host: string): string | undefined {
  const hostname = host.split(':')[0]!;
  const labels = hostname.split('.');
  const namesNone = hostname.toLowerCase() === 'localhost' || labels.length <= 2;
  return namesNone ? undefined : labels[0];
}

/**
 * The instance a database URL reaches, as the SDK's `parseDatabaseURL`
 * reads its namespace: the `ns` query parameter when there is one, else the
 * first label of the host, lowercase as `instanceOf` reads a repo's. A value
 * that is no string, or names no namespace, gives undefined; so does a
 * query the SDK cannot decode, which `getDatabase` then throws on itself.
 */
export function urlInstance(url: unknown): string | undefined {
  try {
    if (typeof url !== 'string') return undefined;
    const schemeEnd = url.indexOf('//');
    const rest = schemeEnd === -1 ? url : url.slice(schemeEnd + 2);
    const queryStart = rest.indexOf('?');
    const slash = rest.indexOf('/');
    const hostEnd = Math.min(slash === -1 ? rest.length : slash, queryStart === -1 ? rest.length : queryStart);
    const fromQuery = queryStart === -1 ? undefined : namespaceParameter(rest.slice(queryStart + 1));
    const namespace = fromQuery ?? hostNamespace(rest.slice(0, hostEnd));
    return namespace === undefined || namespace === '' ? undefined : namespace.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The row's `getDatabase`. When the app's config names another project (its
 * projectId, or the default form of its databaseURL, storageBucket or
 * authDomain), or the URL names another project's default instance, it
 * throws the project refusal naming that field before the SDK's factory
 * runs, so the SDK never opens a connection, which would carry the
 * account's ID token and the App Check token. A config field is judged
 * ahead of the URL. `getDatabase()` with no app judges the default app.
 * When there is none yet, the SDK's factory either throws its own error or
 * makes the default app from the environment's default config, as
 * `getApp()` does, and that app is judged before the Database is returned:
 * the factory opens no connection, which starts only at `ref()`. Otherwise
 * it calls the SDK's factory, and the Database it returns is noted.
 */
export function guardedGetDatabase(real: Callback, site: Omit<ObservedSite, 'name'>): Callback {
  return function getDatabase(this: unknown, ...args: unknown[]): unknown {
    const instance = urlInstance(args[1]);
    const target = instance === undefined ? {} : { instance };
    const isAppNamed = args[0] !== undefined;
    const app = isAppNamed ? args[0] : defaultApp(site);
    throwRefusal(refusedFactory(site, 'getDatabase', app, target));
    const db = Reflect.apply(real, this, args);
    const isAppMade = app === undefined;
    if (isAppMade) throwRefusal(refusedFactory(site, 'getDatabase', appOfDatabase(db), target));
    noteDatabase(db);
    return db;
  };
}

function throwRefusal(refusal: Error | null): void {
  if (refusal !== null) throw refusal;
}

/** The name `getApp()` looks the default app up by. */
const DEFAULT_APP_NAME = '[DEFAULT]';

/**
 * The app `getDatabase()` with no app opens, as the SDK's `getApp()` finds
 * it: the initialized app named `[DEFAULT]`, read from `getApps()` so no
 * call is recorded. Undefined when there is none yet.
 */
function defaultApp(site: Omit<ObservedSite, 'name'>): unknown {
  try {
    return site.apps?.().find((app) => isObject(app) && app.name === DEFAULT_APP_NAME);
  } catch {
    return undefined;
  }
}

/** The app a Database belongs to, read without calling anything of the app's. */
function appOfDatabase(db: unknown): unknown {
  try {
    return isObject(db) ? db.app : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A reference's or query's repo: its own `_repo` field. A Database keeps
 * `_repo` as a getter that starts the repo, so only an own data property is
 * read.
 */
export function repoOf(subject: unknown): Fields | undefined {
  if (!isObject(subject)) return undefined;
  const repo: unknown = Object.getOwnPropertyDescriptor(subject, '_repo')?.value;
  return isObject(repo) ? repo : undefined;
}

/** A reference's or query's path as the SDK prints it, `/items/a`, or undefined. */
export function pathOf(subject: unknown): string | undefined {
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
 * The instance a record names when the reference's repo does not say. A
 * default instance is the project id, at most 30 characters, or ends in
 * `-default-rtdb`; this name is 40 characters and doesn't, so it can't be a
 * default instance. A host requires an instance on every RTDB call, so the
 * call still reaches Traffic.
 */
export const UNREAD_INSTANCE = 'instance-not-read-from-the-sdk-reference';

/**
 * A repo's instance: the SDK's namespace, lowercase. The SDK keeps the
 * namespace a `?ns=` URL parameter spells as written, and production's
 * instance names are lowercase, so `?ns=My-App` is the instance `my-app`.
 */
export function instanceOf(repo: Fields | undefined): string {
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

/** The exports whose second argument is the value they write. */
const RTDB_WRITE_EXPORTS = new Set(['set', 'setWithPriority', 'update', 'push']);

/** The value a write sent, as the host takes it: a bounded JSON copy, an update's only when it is a map of locations. */
function writeDataOf(name: string, args: readonly unknown[]): LiveWriteValue | undefined {
  if (!RTDB_WRITE_EXPORTS.has(name)) return undefined;
  const raw = args[1];
  if (raw === undefined) return undefined;
  if (name === 'update' && !isPlainObject(raw)) return undefined;
  return jsonValue(raw);
}

/**
 * The record context of one call: what its reference names, or `UNOBSERVED`
 * for a call production never answers. An OnDisconnect method reads its
 * reference's repo and path from `this`; every other call from its first
 * argument. A call under `/.info`, and a `push` with no value (which writes
 * nothing), make no record.
 */
export function databaseContext(name: string, args: readonly unknown[], self: unknown): CallContext | typeof UNOBSERVED {
  try {
    const isOnDisconnect = name.startsWith(ON_DISCONNECT_PREFIX);
    const source = isOnDisconnect ? self : args[0];
    const path = pathOf(source);
    const writesNothing = name === 'push' && (args[1] === undefined || args[1] === null);
    if (isInfoPath(path) || writesNothing) return UNOBSERVED;
    const context = repoContext(repoOf(source));
    const located = path === undefined ? context : { ...context, path };
    // An OnDisconnect write runs when the client leaves, against rules the host cannot time.
    if (isOnDisconnect) return located;
    let full: CallContext = { ...located, ...databaseWriteSession(name, args, context.instance ?? UNREAD_INSTANCE, path) };
    const writeData = writeDataOf(name, args);
    if (writeData !== undefined) full = { ...full, writeData };
    const isFilteredQuery = queryIdOf(source) !== 'default';
    if (isFilteredQuery) full = { ...full, rtdbFilteredQuery: true };
    return full;
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
 * A query's identifier as the SDK keys its views: `default` for a whole
 * location, else a key of its parameters, which may hold values. Read through
 * the SDK's own `_queryIdentifier` getter, which runs no code of the app's;
 * `default` when it can't be read.
 */
export function queryIdOf(query: unknown): string {
  try {
    const id = isObject(query) ? query._queryIdentifier : undefined;
    return typeof id === 'string' ? id : 'default';
  } catch {
    return 'default';
  }
}

/**
 * What one RTDB listener listens to: its reference's path, and the key the
 * sandbox's own RTDB listeners use, its instance, path and query identifier,
 * which may hold the query's values and never leaves the realm. A reference
 * whose path can't be read gets no lifecycle.
 */
export function databaseListener(_name: string, args: readonly unknown[]): ListenerIdentity | undefined {
  const query = args[0];
  const path = pathOf(query);
  if (path === undefined) return undefined;
  return { target: path, key: JSON.stringify([instanceOf(repoOf(query)), path, queryIdOf(query)]) };
}

/** Where a database listener sits in the page's activity journal (`listener-journal.ts`). */
export interface DatabaseJournalPlace {
  readonly database: object;
  readonly target: string;
  readonly isQuery: boolean;
  readonly key: string;
}

/**
 * A database listener's place in the page journal: its repo, which names the
 * app and instance, its path, whether it runs a query, and the key the
 * sandbox's own RTDB listeners use. Undefined for a subject without a repo or
 * path, or under `/.info`.
 */
export function databaseJournalPlace(subject: unknown): DatabaseJournalPlace | undefined {
  const repo = repoOf(subject);
  const path = pathOf(subject);
  if (repo === undefined || path === undefined || isInfoPath(path)) return undefined;
  const queryId = queryIdOf(subject);
  return { database: repo, target: path, isQuery: queryId !== 'default', key: JSON.stringify([instanceOf(repo), path, queryId]) };
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
