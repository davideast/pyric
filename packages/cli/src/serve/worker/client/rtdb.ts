/**
 * RTDB shared-worker modular subset — refs, push-id generation, value reads,
 * writes, and `onValue` listeners over the worker port, plus the admin-lens data
 * ops for the Pyric Studio RTDB viewer.
 */

import type { InboundMessage, RtdbQuerySpec } from '../protocol.js';
import {
  isDisconnectedPort,
  closeSubscription,
  openSnapshotSubscription,
  nextId,
  nextSubId,
  dataRpc,
  _snapSubs,
  _defaultLens,
  stampIssuer,
} from './core.js';
import type {
  ClientDb,
  ClientPort,
  ClientRtdb,
  RtdbRefHandle,
  RtdbDataSnapshot,
  Unsubscribe,
} from './handles.js';
import { getFirestore } from './connection.js';

// ─── RTDB shared-worker modular subset ────────────────────────────────────

export function rtdbGetDatabase(source?: ClientDb | string | URL, name?: string): ClientRtdb {
  if (source && typeof source === 'object' && 'port' in source) {
    return { __kind: 'client-rtdb', port: (source as ClientDb).port };
  }
  const firestore = getFirestore(source ?? '/__pyric/sdk/worker.js', name);
  return { __kind: 'client-rtdb', port: firestore.port };
}

function normalizeRtdbPath(path?: string): string {
  const joined = (path ?? '/').split('/').filter(Boolean).join('/');
  return joined ? `/${joined}` : '/';
}

function rtdbKey(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? null;
}

const RTDB_PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

let lastRtdbPushTime = 0;

const lastRtdbRandChars: number[] = new Array(12).fill(0);

function generateRtdbPushId(now: number = Date.now()): string {
  const duplicateTime = now === lastRtdbPushTime;
  lastRtdbPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = RTDB_PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) throw new Error('RTDB push-id: timestamp overflow.');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) lastRtdbRandChars[i] = Math.floor(Math.random() * 64);
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRtdbRandChars[i] === 63; i--) lastRtdbRandChars[i] = 0;
    if (i < 0) {
      for (let j = 0; j < 12; j++) lastRtdbRandChars[j] = Math.floor(Math.random() * 64);
    } else {
      lastRtdbRandChars[i] = (lastRtdbRandChars[i] ?? 0) + 1;
    }
  }

  let id = timeStampChars.join('');
  for (let i = 0; i < 12; i++) id += RTDB_PUSH_CHARS.charAt(lastRtdbRandChars[i]!);
  return id;
}

function makeRtdbRef(port: ClientPort, path: string): RtdbRefHandle {
  const normalized = normalizeRtdbPath(path);
  const parts = normalized.split('/').filter(Boolean);
  const parentPath = parts.length > 0 ? `/${parts.slice(0, -1).join('/')}` : '/';
  const self: RtdbRefHandle = {
    __kind: 'rtdb-ref',
    port,
    path: normalized,
    _path: normalized,
    key: rtdbKey(normalized),
    get parent() {
      return normalized === '/' ? null : makeRtdbRef(port, parentPath);
    },
    get root() {
      return makeRtdbRef(port, '/');
    },
    isEqual(other) {
      return other !== null && other.__kind === 'rtdb-ref' &&
        other.port === port && other.path === normalized;
    },
    toJSON() {
      return `worker://rtdb${normalized}`;
    },
    toString() {
      return `worker://rtdb${normalized}`;
    },
  };
  return self;
}

export function rtdbRef(db: ClientRtdb, path?: string): RtdbRefHandle {
  if (isDisconnectedPort(db.port)) {
    throw new Error('FIREBASE FATAL ERROR: Cannot call ref on a deleted database. ');
  }
  return makeRtdbRef(db.port, path ?? '/');
}

export function rtdbChild(parent: RtdbRefHandle, path: string): RtdbRefHandle {
  return makeRtdbRef(parent.port, `${parent.path}/${path}`);
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

interface RtdbWireEntry {
  key: string;
  value: unknown;
  priority?: string | number | null;
}

interface RtdbWireSnapshot {
  value?: unknown;
  exists?: boolean;
  key?: string | null;
  priority?: string | number | null;
  entries?: RtdbWireEntry[];
}

type RtdbQueryLike = {
  readonly ref: RtdbRefHandle;
  readonly _spec: RtdbQuerySpec;
};

type RtdbTarget = RtdbRefHandle | RtdbQueryLike;

function isRtdbQuery(target: RtdbTarget): target is RtdbQueryLike {
  return 'ref' in target && '_spec' in target;
}

function targetParts(target: RtdbTarget): {
  ref: RtdbRefHandle;
  query?: RtdbQuerySpec;
} {
  return isRtdbQuery(target)
    ? { ref: target.ref, query: target._spec }
    : { ref: target };
}

function makeRtdbSnapshot(
  refHandle: RtdbRefHandle,
  value: unknown,
  exists?: boolean,
  priority: string | number | null = null,
  entries?: RtdbWireEntry[],
): RtdbDataSnapshot {
  const childValue = (path: string) => valueAt(value, path);
  const size = entries?.length ?? (
    value && typeof value === 'object'
      ? Object.keys(value as Record<string, unknown>).filter((key) => valueAt(value, key) !== null).length
      : 0
  );
  const snapshot: RtdbDataSnapshot = {
    key: refHandle.key,
    size,
    priority,
    exists: () => exists ?? (value !== null && value !== undefined),
    val: () => value ?? null,
    child: (path) => {
      const direct = path.split('/').filter(Boolean);
      const entry = direct.length === 1 ? entries?.find((candidate) => candidate.key === direct[0]) : undefined;
      return makeRtdbSnapshot(
        rtdbChild(refHandle, path),
        childValue(path),
        undefined,
        entry?.priority ?? null,
      );
    },
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => value ?? null,
    toJSON: () => value ?? null,
    forEach: (cb) => {
      const orderedEntries: RtdbWireEntry[] = entries ?? (
        !value || typeof value !== 'object' || Array.isArray(value)
          ? []
          : Object.entries(value as Record<string, unknown>).map(([key, childValue]) => ({ key, value: childValue }))
      );
      for (const entry of orderedEntries) {
        if (cb(makeRtdbSnapshot(
          rtdbChild(refHandle, entry.key),
          entry.value,
          undefined,
          entry.priority ?? null,
        )) === true) return true;
      }
      return false;
    },
    ref: refHandle,
  };
  return snapshot;
}

function hydrateRtdbSnapshot(refHandle: RtdbRefHandle, wire: unknown): RtdbDataSnapshot {
  const payload = wire as RtdbWireSnapshot;
  return makeRtdbSnapshot(
    refHandle,
    payload.value ?? null,
    payload.exists,
    payload.priority ?? null,
    payload.entries,
  );
}

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref: r, query } = targetParts(target);
  return hydrateRtdbSnapshot(
    r,
    await dataRpc(r.port, {
      t: 'op', id: nextId(), method: 'rtdb.get', path: r.path, ...(query ? { query } : {}),
    }),
  );
}

export async function rtdbSet(r: RtdbRefHandle, value: unknown): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.set', path: r.path, value });
}

export async function rtdbSetPriority(
  r: RtdbRefHandle,
  priority: string | number | null,
): Promise<void> {
  await dataRpc(r.port, {
    t: 'op', id: nextId(), method: 'rtdb.setPriority', path: r.path, priority,
  });
}

export async function rtdbSetWithPriority(
  r: RtdbRefHandle,
  value: unknown,
  priority: string | number | null,
): Promise<void> {
  await dataRpc(r.port, {
    t: 'op', id: nextId(), method: 'rtdb.setWithPriority', path: r.path, value, priority,
  });
}

export async function rtdbUpdate(r: RtdbRefHandle, values: Record<string, unknown>): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.update', path: r.path, values });
}

export async function rtdbRemove(r: RtdbRefHandle): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.remove', path: r.path });
}

export function rtdbPush(r: RtdbRefHandle, value?: unknown): RtdbRefHandle & PromiseLike<RtdbRefHandle> {
  const key = generateRtdbPushId();
  const pushed = makeRtdbRef(r.port, `${r.path}/${key}`);
  const settledRef = makeRtdbRef(r.port, pushed.path);
  const promise = dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.push', path: r.path, key, value })
    .then(() => settledRef);
  return Object.assign(pushed, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  });
}

export function rtdbOnValue(
  target: RtdbTarget,
  next: (snap: RtdbDataSnapshot) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  const { ref: r, query } = targetParts(target);
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  const subId = nextSubId();
  const msg: InboundMessage = _defaultLens
    ? { t: 'sub', subId, target: { service: 'rtdb', path: r.path, ...(query ? { query } : {}) }, actAs: _defaultLens }
    : { t: 'sub', subId, target: { service: 'rtdb', path: r.path, ...(query ? { query } : {}) } };
  let fired = false;
  const opened = openSnapshotSubscription(r.port, subId, {
    port: r.port,
    next: (wire) => {
      if (listenOptions?.onlyOnce && fired) return;
      fired = true;
      if (listenOptions?.onlyOnce) closeSubscription(r.port, subId);
      next(hydrateRtdbSnapshot(r, wire));
    },
    error,
  }, stampIssuer(msg));
  if (!opened && error) queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  return () => {
    closeSubscription(r.port, subId);
  };
}

type ChildEventKind = 'added' | 'changed' | 'removed' | 'moved';

function directChildren(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((child, index) => child == null ? [] : [[String(index), child]]),
    );
  }
  if (value === null || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function sameRtdbValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameRtdbValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameRtdbValue(leftRecord[key], rightRecord[key]));
}

function rtdbKeyCompare(left: string, right: string): number {
  const integerKey = (key: string): number | null => {
    if (!/^(0|[1-9]\d*)$/.test(key)) return null;
    const value = Number(key);
    return Number.isSafeInteger(value) && value <= 2_147_483_647 ? value : null;
  };
  const leftInteger = integerKey(left);
  const rightInteger = integerKey(right);
  if (leftInteger !== null && rightInteger !== null) return leftInteger - rightInteger;
  if (leftInteger !== null) return -1;
  if (rightInteger !== null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function rtdbOnChildEvent(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const { ref: r, query } = targetParts(target);
  let initialized = false;
  let previous: RtdbWireEntry[] = [];

  return rtdbOnValue(target, (parent) => {
    const current: RtdbWireEntry[] = [];
    parent.forEach((childSnap) => {
      if (childSnap.key !== null) {
        current.push({ key: childSnap.key, value: childSnap.val(), priority: childSnap.priority });
      }
    });
    // Plain snapshots produced by older hosts do not carry ordered entries.
    if (current.length === 0) {
      for (const key of Object.keys(directChildren(parent.val())).sort(rtdbKeyCompare)) {
        current.push({ key, value: directChildren(parent.val())[key] });
      }
    }
    if (!initialized) {
      initialized = true;
      if (kind === 'added') {
        for (let index = 0; index < current.length; index++) {
          const entry = current[index]!;
          next(
            makeRtdbSnapshot(rtdbChild(r, entry.key), entry.value, undefined, entry.priority ?? null),
            current[index - 1]?.key ?? null,
          );
        }
      }
      previous = current;
      return;
    }

    const previousByKey = new Map(previous.map((entry, index) => [entry.key, { entry, index }]));
    const currentByKey = new Map(current.map((entry, index) => [entry.key, { entry, index }]));
    const emit = (entry: RtdbWireEntry, previousChildName: string | null): void => {
      next(
        makeRtdbSnapshot(rtdbChild(r, entry.key), entry.value, undefined, entry.priority ?? null),
        previousChildName,
      );
    };

    if (kind === 'removed') {
      for (const prior of previous) {
        if (!currentByKey.has(prior.key)) {
          const priorIndex = previousByKey.get(prior.key)!.index;
          emit(prior, previous[priorIndex - 1]?.key ?? null);
        }
      }
    } else {
      for (let index = 0; index < current.length; index++) {
        const entry = current[index]!;
        const prior = previousByKey.get(entry.key);
        const previousChildName = current[index - 1]?.key ?? null;
        if (kind === 'added' && !prior) emit(entry, previousChildName);
        if (kind === 'changed' && prior && !sameRtdbValue(prior.entry.value, entry.value)) {
          emit(entry, previousChildName);
        }
        if (kind === 'moved' && prior) {
          const orderBy = query?.orderBy ?? { kind: 'priority' as const };
          const indexed = (candidate: RtdbWireEntry): unknown => {
            if (orderBy.kind === 'key') return candidate.key;
            if (orderBy.kind === 'priority') return candidate.priority ?? null;
            if (orderBy.kind === 'value') return candidate.value;
            return valueAt(candidate.value, orderBy.path);
          };
          // Production emits child_moved when the child's indexed value
          // changes, even when its predecessor remains the same.
          if (!sameRtdbValue(indexed(prior.entry), indexed(entry))) {
            emit(entry, previousChildName);
          }
        }
      }
    }
    previous = current;
  }, error);
}

/** Derives direct-child additions from the existing parent value stream. */
export function rtdbOnChildAdded(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'added', next, cancelCallbackOrOptions, options);
}

/** Derives existing direct-child value changes from the parent value stream. */
export function rtdbOnChildChanged(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'changed', next, cancelCallbackOrOptions, options);
}

export function rtdbOnChildRemoved(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'removed', next, cancelCallbackOrOptions, options);
}

export function rtdbOnChildMoved(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'moved', next, cancelCallbackOrOptions, options);
}

function subscribeRtdbChild(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  if (!listenOptions?.onlyOnce) return rtdbOnChildEvent(target, kind, next, error);
  let stopped = false;
  let unsubscribe: Unsubscribe = () => {};
  unsubscribe = rtdbOnChildEvent(target, kind, (snapshot, previousChildName) => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    next(snapshot, kind === 'removed' ? null : previousChildName);
  }, error);
  return unsubscribe;
}

export interface RtdbTransactionOptions {
  readonly applyLocally?: boolean;
}

export interface RtdbTransactionResult {
  readonly committed: boolean;
  readonly snapshot: RtdbDataSnapshot;
  toJSON(): { committed: boolean; snapshot: unknown };
}

function transactionResult(committed: boolean, snapshot: RtdbDataSnapshot): RtdbTransactionResult {
  return {
    committed,
    snapshot,
    toJSON: () => ({ committed, snapshot: snapshot.toJSON() }),
  };
}

export async function rtdbRunTransaction<T>(
  r: RtdbRefHandle,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: RtdbTransactionOptions,
): Promise<RtdbTransactionResult> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const before = await rtdbGet(r);
    const expected = before.val() as T | null;
    const value = transactionUpdate(expected);
    if (value === undefined) return transactionResult(false, before);
    const wire = await dataRpc(r.port, {
      t: 'op',
      id: nextId(),
      method: 'rtdb.transactionCommit',
      path: r.path,
      expected,
      value,
      applyLocally: options?.applyLocally,
    }) as { retry?: boolean; committed: boolean; snapshot: RtdbWireSnapshot };
    const snapshot = hydrateRtdbSnapshot(r, wire.snapshot);
    if (!wire.retry) return transactionResult(wire.committed, snapshot);
  }
  throw new Error('maxretry');
}

export class RtdbOnDisconnect {
  constructor(
    private readonly _repo: RtdbRefHandle,
    private readonly _path = _repo.path,
  ) {}

  cancel(): Promise<void> {
    return dataRpc(this._repo.port, { t: 'op', id: nextId(), method: 'rtdb.onDisconnectCancel', path: this._path }).then(() => undefined);
  }

  remove(): Promise<void> {
    return dataRpc(this._repo.port, { t: 'op', id: nextId(), method: 'rtdb.onDisconnectRemove', path: this._path }).then(() => undefined);
  }

  set(value: unknown): Promise<void> {
    return dataRpc(this._repo.port, { t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value }).then(() => undefined);
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value, priority,
    }).then(() => undefined);
  }

  update(values: Record<string, unknown>): Promise<void> {
    return dataRpc(this._repo.port, { t: 'op', id: nextId(), method: 'rtdb.onDisconnectUpdate', path: this._path, values }).then(() => undefined);
  }
}

export function rtdbOnDisconnect(r: RtdbRefHandle): RtdbOnDisconnect {
  return new RtdbOnDisconnect(r);
}

export function rtdbGoOffline(db: ClientRtdb): void {
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOffline' }).catch(() => undefined);
}

export function rtdbGoOnline(db: ClientRtdb): void {
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOnline' }).catch(() => undefined);
}

export function rtdbOff(_r: RtdbRefHandle, _eventType?: unknown, _callback?: unknown): void {
  // Firebase's `off` is callback-specific. The worker bridge exposes unsubscribe
  // functions from `onValue`; this no-op preserves common app code that calls it
  // defensively during cleanup.
}

export function rtdbServerTimestamp(): { readonly __rtdbSentinel: 'serverTimestamp' } {
  return { __rtdbSentinel: 'serverTimestamp' };
}

export function rtdbConnectDatabaseEmulator(): void {
  // Shared worker sandbox is already local.
}
