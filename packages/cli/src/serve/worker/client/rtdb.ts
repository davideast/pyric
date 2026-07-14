/**
 * RTDB shared-worker modular subset — refs, push-id generation, value reads,
 * writes, and `onValue` listeners over the worker port, plus the admin-lens data
 * ops for the Pyric Studio RTDB viewer.
 */

import type { InboundMessage } from '../protocol.js';
import {
  isDisconnectedPort,
  closeSubscription,
  openSnapshotSubscription,
  nextId,
  nextSubId,
  rpc,
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
    key: rtdbKey(normalized),
    get parent() {
      return normalized === '/' ? null : makeRtdbRef(port, parentPath);
    },
    get root() {
      return makeRtdbRef(port, '/');
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

function makeRtdbSnapshot(refHandle: RtdbRefHandle, value: unknown, exists?: boolean): RtdbDataSnapshot {
  const childValue = (path: string) => valueAt(value, path);
  const size =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).length
      : 0;
  const snapshot: RtdbDataSnapshot = {
    key: refHandle.key,
    size,
    exists: () => exists ?? (value !== null && value !== undefined),
    val: () => value ?? null,
    child: (path) => makeRtdbSnapshot(rtdbChild(refHandle, path), childValue(path)),
    hasChild: (path) => childValue(path) !== null && childValue(path) !== undefined,
    hasChildren: () => size > 0,
    exportVal: () => value ?? null,
    toJSON: () => value ?? null,
    forEach: (cb) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      for (const [key, childVal] of Object.entries(value as Record<string, unknown>)) {
        if (cb(makeRtdbSnapshot(rtdbChild(refHandle, key), childVal)) === true) return true;
      }
      return false;
    },
    ref: refHandle,
  };
  return snapshot;
}

function hydrateRtdbSnapshot(refHandle: RtdbRefHandle, wire: unknown): RtdbDataSnapshot {
  const payload = wire as { value?: unknown; exists?: boolean; key?: string | null };
  return makeRtdbSnapshot(refHandle, payload.value ?? null, payload.exists);
}

export async function rtdbGet(r: RtdbRefHandle): Promise<RtdbDataSnapshot> {
  return hydrateRtdbSnapshot(
    r,
    await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.get', path: r.path }),
  );
}

export async function adminReadRtdbState(db: ClientDb | ClientRtdb): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.adminSnapshot' });
}

export async function adminSetRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  value: unknown,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.set',
    path,
    value,
    actAs: { mode: 'admin' },
  });
}

export async function adminUpdateRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  values: Record<string, unknown>,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.update',
    path,
    values,
    actAs: { mode: 'admin' },
  });
}

export async function adminDeleteRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'rtdb.remove',
    path,
    actAs: { mode: 'admin' },
  });
}

/**
 * Subscribe to the raw value at an RTDB path with the ADMIN lens (Pyric Studio
 * data viewer). Rides the same `{service:'rtdb'}` value-subscription channel as
 * `rtdbOnValue`, but pins `actAs: {mode:'admin'}` per-sub instead of following
 * the module default lens, so Studio's viewer stays admin (PRINCIPLES M3) while
 * the page's own listeners keep their session semantics.
 *
 * `next` receives the plain JSON value at `path` (`null` when absent) on
 * subscribe and again after every write that changes the subtree.
 */
export function adminSubscribeRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  next: (value: unknown) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  const opened = openSnapshotSubscription(
    db.port,
    subId,
    {
      port: db.port,
      next: (wire) => next((wire as { value?: unknown } | null)?.value ?? null),
      error,
    },
    stampIssuer({
      t: 'sub',
      subId,
      target: { service: 'rtdb', path: normalizeRtdbPath(path) },
      actAs: { mode: 'admin' },
    } satisfies InboundMessage),
  );
  if (!opened && error) {
    queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  }
  return () => {
    closeSubscription(db.port, subId);
  };
}

export async function rtdbSet(r: RtdbRefHandle, value: unknown): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.set', path: r.path, value });
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
  r: RtdbRefHandle,
  next: (snap: RtdbDataSnapshot) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  const msg: InboundMessage = _defaultLens
    ? { t: 'sub', subId, target: { service: 'rtdb', path: r.path }, actAs: _defaultLens }
    : { t: 'sub', subId, target: { service: 'rtdb', path: r.path } };
  const opened = openSnapshotSubscription(r.port, subId, {
    port: r.port,
    next: (wire) => next(hydrateRtdbSnapshot(r, wire)),
    error,
  }, stampIssuer(msg));
  if (!opened && error) queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  return () => {
    closeSubscription(r.port, subId);
  };
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
