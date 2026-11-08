/**
 * RTDB listener callback wrapping, `{ onlyOnce: true }` detection, and `off()`
 * registration tracking for `@pyric/live`.
 *
 * Keys recording wrappers by `(appCallback, repo, listener, path, queryId)` so
 * distinct queries on the same path never share a wrapper, gives `{ onlyOnce: true }`
 * subscriptions dedicated wrappers (`@firebase/database` wraps `onlyOnce`
 * internally so `off(ref, type, cb)` never matches it directly), and attributes
 * synchronous multi-registration `View` dispatches without stateful round-robin.
 */
import { instanceOf, pathOf, queryIdOf, repoOf } from './database.js';
import type { Callback } from './observe.js';

/** The listener export each `off()` event type belongs to. */
const LISTENER_OF_EVENT: Readonly<Record<string, string>> = {
  value: 'onValue',
  child_added: 'onChildAdded',
  child_changed: 'onChildChanged',
  child_removed: 'onChildRemoved',
  child_moved: 'onChildMoved',
};

/**
 * The arguments the row hands a listener export (`onValue` or `onChild*`).
 * Each has a three-argument overload `(query, callback, options)` and a
 * four-argument overload `(query, callback, cancelCallback, options)` whose
 * third argument may be `undefined`.
 */
export function databaseListenerArguments(args: unknown[]): unknown[] {
  const third = args[2];
  const isOptions = typeof third === 'object';
  if (!isOptions) return args;
  return [args[0], args[1], undefined, third];
}

/** Whether RTDB listen options request `{ onlyOnce: true }` (3-arg or 4-arg overload). */
export function databaseListenerOnlyOnce(args: readonly unknown[]): boolean {
  try {
    const third = args[2];
    const hasObjectAtThird = typeof third === 'object' && third !== null;
    const options = hasObjectAtThird ? third : args[3];
    return typeof options === 'object' && options !== null && Reflect.get(options, 'onlyOnce') === true;
  } catch {
    return false;
  }
}

interface HandedCallback {
  readonly locationKey: string;
  readonly queryId: string;
  readonly wrapper: Callback;
  readonly active: Callback[];
  readonly delivered: WeakSet<Callback>;
  pending?: Callback;
  last: Callback;
  turnIndex: number;
  turnResetScheduled: boolean;
}

interface Handed {
  readonly byRepo: WeakMap<object, Map<string, HandedCallback>>;
  readonly unread: Map<string, HandedCallback>;
}

const HANDED = new WeakMap<object, Handed>();

function handedLocationKey(listener: string, instance: string, path: string | undefined): string {
  return JSON.stringify([listener, instance, path ?? null]);
}

function handedKey(
  listener: string,
  instance: string,
  path: string | undefined,
  queryId: string,
): string {
  return JSON.stringify([listener, instance, path ?? null, queryId]);
}

function handedFor(
  appCallback: object,
  query: unknown,
  create: boolean,
): Map<string, HandedCallback> | undefined {
  let handed = HANDED.get(appCallback);
  if (handed === undefined) {
    if (!create) return undefined;
    handed = { byRepo: new WeakMap(), unread: new Map() };
    HANDED.set(appCallback, handed);
  }
  const repo = repoOf(query);
  if (repo === undefined) return handed.unread;
  let byView = handed.byRepo.get(repo);
  if (byView === undefined && create) {
    byView = new Map();
    handed.byRepo.set(repo, byView);
  }
  return byView;
}

function keyPartsFor(listener: string, query: unknown): {
  key: string;
  locationKey: string;
  queryId: string;
} {
  const instance = instanceOf(repoOf(query));
  const path = pathOf(query);
  const queryId = queryIdOf(query);
  return {
    key: handedKey(listener, instance, path, queryId),
    locationKey: handedLocationKey(listener, instance, path),
    queryId,
  };
}

function pickViewHandler(entry: HandedCallback): Callback {
  if (entry.pending !== undefined) {
    entry.delivered.add(entry.pending);
    return entry.pending;
  }
  const count = entry.active.length;
  if (count === 0) return entry.last;
  if (!entry.turnResetScheduled) {
    entry.turnResetScheduled = true;
    queueMicrotask(() => {
      entry.turnIndex = 0;
      entry.turnResetScheduled = false;
    });
  }
  const slot = entry.turnIndex;
  entry.turnIndex += 1;
  if (slot === 0) {
    const undelivered = entry.active.find((candidate) => !entry.delivered.has(candidate));
    if (undelivered !== undefined) {
      entry.delivered.add(undelivered);
      return undelivered;
    }
  }
  const target = entry.active[slot % count]!;
  entry.delivered.add(target);
  return target;
}

export function databaseListenerCallback(
  name: string,
  args: readonly unknown[],
  appCallback: Callback,
  make: () => Callback,
): Callback {
  if (databaseListenerOnlyOnce(args)) {
    return make();
  }
  const handed = handedFor(appCallback, args[0], true)!;
  const { key, locationKey, queryId } = keyPartsFor(name, args[0]);
  const handler = make();
  const clearStalePending = (entry: HandedCallback): void => {
    queueMicrotask(() => {
      if (entry.pending === handler) entry.pending = undefined;
    });
  };
  const known = handed.get(key);
  if (known !== undefined) {
    known.pending = handler;
    known.last = handler;
    clearStalePending(known);
    return known.wrapper;
  }
  const entry: HandedCallback = {
    locationKey,
    queryId,
    active: [],
    delivered: new WeakSet(),
    pending: handler,
    last: handler,
    turnIndex: 0,
    turnResetScheduled: false,
    wrapper(this: unknown, ...values: unknown[]): unknown {
      const chosen = pickViewHandler(entry);
      return Reflect.apply(chosen, this, values);
    },
  };
  clearStalePending(entry);
  handed.set(key, entry);
  return entry.wrapper;
}

function handedWrappersForOff(args: readonly unknown[]): Callback[] {
  const [query, eventType, callback] = args;
  const isOneCallback = typeof eventType === 'string' && typeof callback === 'function';
  if (!isOneCallback) return [];
  const listener = LISTENER_OF_EVENT[eventType];
  if (listener === undefined) return [];
  const map = handedFor(callback, query, false);
  if (map === undefined) return [];
  const { key, locationKey, queryId } = keyPartsFor(listener, query);
  if (queryId !== 'default') {
    const exact = map.get(key);
    return exact === undefined ? [] : [exact.wrapper];
  }
  const wrappers: Callback[] = [];
  for (const entry of map.values()) {
    if (entry.locationKey === locationKey) wrappers.push(entry.wrapper);
  }
  return wrappers;
}

interface AttachedListener {
  readonly listener: string;
  readonly callback: unknown;
  readonly queryId: string;
  readonly detach: () => void;
}

const ATTACHED = new Map<string, Set<AttachedListener>>();

function locationOf(query: unknown): string {
  return JSON.stringify([instanceOf(repoOf(query)), pathOf(query) ?? null]);
}

export function databaseListenerAttached(
  name: string,
  args: readonly unknown[],
  detach: () => void,
): () => void {
  const location = locationOf(args[0]);
  const rawCallback = args[1];
  let removeActive: (() => void) | undefined;
  if (typeof rawCallback === 'function' && !databaseListenerOnlyOnce(args)) {
    const map = handedFor(rawCallback, args[0], false);
    const { key } = keyPartsFor(name, args[0]);
    const entry = map?.get(key);
    const handler = entry?.pending;
    if (map !== undefined && entry !== undefined && handler !== undefined) {
      entry.pending = undefined;
      entry.active.push(handler);
      removeActive = () => {
        const index = entry.active.indexOf(handler);
        if (index >= 0) entry.active.splice(index, 1);
        if (entry.active.length === 0 && entry.pending === undefined && map.get(key) === entry) {
          map.delete(key);
        }
      };
    }
  }
  const attached: AttachedListener = {
    listener: name,
    callback: rawCallback,
    queryId: queryIdOf(args[0]),
    detach,
  };
  let atLocation = ATTACHED.get(location);
  if (atLocation === undefined) {
    atLocation = new Set();
    ATTACHED.set(location, atLocation);
  }
  const listeners = atLocation;
  listeners.add(attached);
  return () => {
    removeActive?.();
    listeners.delete(attached);
    if (listeners.size === 0 && ATTACHED.get(location) === listeners) ATTACHED.delete(location);
  };
}

function namedByOff(
  attached: AttachedListener,
  off: { queryId: string; listener?: string; callback: unknown },
): boolean {
  const isView = off.queryId === 'default' || attached.queryId === off.queryId;
  const isListener = off.listener === undefined || attached.listener === off.listener;
  const isCallback = typeof off.callback !== 'function' || attached.callback === off.callback;
  return isView && isListener && isCallback;
}

function endedByOff(args: readonly unknown[]): AttachedListener[] {
  const [query, eventType, callback] = args;
  const atLocation = ATTACHED.get(locationOf(query));
  if (atLocation === undefined) return [];
  const listener = typeof eventType === 'string' ? LISTENER_OF_EVENT[eventType] : undefined;
  if (typeof eventType === 'string' && listener === undefined) return [];
  const off: { queryId: string; listener?: string; callback: unknown } = {
    queryId: queryIdOf(query),
    callback,
  };
  if (listener !== undefined) off.listener = listener;
  const named = [...atLocation].filter((attached) => namedByOff(attached, off));
  if (typeof callback !== 'function') return named;
  const firstPerView = new Map<string, AttachedListener>();
  for (const attached of named) {
    if (!firstPerView.has(attached.queryId)) firstPerView.set(attached.queryId, attached);
  }
  return [...firstPerView.values()];
}

function readEndedByOff(args: readonly unknown[]): AttachedListener[] {
  try {
    return endedByOff(args);
  } catch {
    return [];
  }
}

export function offByCallback(real: Callback): Callback {
  return function off(this: unknown, ...args: unknown[]): unknown {
    let wrappers: Callback[] = [];
    try {
      wrappers = handedWrappersForOff(args);
    } catch {
      wrappers = [];
    }
    const ended = readEndedByOff(args);
    let returned: unknown;
    if (wrappers.length === 0) {
      returned = Reflect.apply(real, this, args);
    } else {
      for (const wrapper of wrappers) {
        returned = Reflect.apply(real, this, [args[0], args[1], wrapper]);
      }
    }
    for (const attached of ended) attached.detach();
    return returned;
  };
}
