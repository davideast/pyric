/** RTDB database handles, references, path validation, and query target routing. */
import { queryIdentifier } from 'pyric/database/internal';
import type { InboundMessage, RtdbQuerySpec } from '../protocol.js';
import { dataRpc, isDisconnectedPort } from './core.js';
import { getFirestore } from './connection.js';
import type { ClientDb, ClientPort, ClientRtdb, ClientRtdbInstance, RtdbRefHandle } from './handles.js';

export type RtdbQueryLike = {
  readonly ref: RtdbRefHandle;
  readonly _spec: RtdbQuerySpec;
};

export type RtdbTarget = RtdbRefHandle | RtdbQueryLike;

export function rtdbGetDatabase(source?: ClientDb | string | URL, name?: string): ClientRtdb {
  if (source && typeof source === 'object' && 'port' in source) {
    return { __kind: 'client-rtdb', port: (source as ClientDb).port };
  }
  const firestore = getFirestore(source ?? '/__pyric/sdk/worker.js', name);
  return { __kind: 'client-rtdb', port: firestore.port };
}

/** A handle on `db`'s port that reads and writes `instance`. */
export function rtdbInstanceDatabase(db: ClientRtdb, instance: ClientRtdbInstance): ClientRtdb {
  return { __kind: 'client-rtdb', port: db.port, instance };
}

/** The protocol's `instance` field for a reference: the instance name, or `undefined` for the default instance. */
export function instanceField(ref: { readonly instance?: ClientRtdbInstance }): { instance: string | undefined } {
  return { instance: ref.instance?.name };
}

/** An RTDB op message without its `instance`, which {@link rtdbRpc} takes from the reference. */
type RtdbOpOnReference<M = Extract<InboundMessage, { t: 'op'; method: `rtdb.${string}` }>> =
  M extends unknown ? Omit<M, 'instance'> : never;

/** An RTDB operation on the reference's instance. */
export function rtdbRpc(
  ref: { readonly port: ClientPort; readonly instance?: ClientRtdbInstance },
  msg: RtdbOpOnReference,
): Promise<unknown> {
  return dataRpc(ref.port, { ...msg, ...instanceField(ref) } as InboundMessage & { t: 'op' });
}

interface ActiveRtdbTransaction {
  readonly path: string;
  readonly done: Promise<void>;
}

let activeTransactionUpdateDepth = 0;
const activeRtdbTransactions = new WeakMap<ClientPort, Map<string, Set<ActiveRtdbTransaction>>>();

function rtdbPathsOverlap(a: string, b: string): boolean {
  if (a === '/' || b === '/' || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function transactionSetFor(
  ref: { readonly port: ClientPort; readonly instance?: ClientRtdbInstance },
): Set<ActiveRtdbTransaction> {
  let byInstance = activeRtdbTransactions.get(ref.port);
  if (!byInstance) {
    byInstance = new Map();
    activeRtdbTransactions.set(ref.port, byInstance);
  }
  const key = ref.instance?.name ?? '';
  let set = byInstance.get(key);
  if (!set) {
    set = new Set();
    byInstance.set(key, set);
  }
  return set;
}

function overlappingTransactionPromises(
  set: ReadonlySet<ActiveRtdbTransaction>,
  paths: readonly string[],
): Promise<void>[] {
  const promises: Promise<void>[] = [];
  for (const active of set) {
    if (paths.some((path) => rtdbPathsOverlap(active.path, path))) {
      promises.push(active.done);
    }
  }
  return promises;
}

/** Marks synchronous execution of a `runTransaction` update callback so re-entrant writes do not deadlock. */
export function withRtdbTransactionUpdate<T>(fn: () => T): T {
  activeTransactionUpdateDepth += 1;
  try {
    return fn();
  } finally {
    activeTransactionUpdateDepth -= 1;
  }
}

/**
 * Registers an active client transaction barrier for `ref.path` on `(port, instance)`
 * so subsequent overlapping writes initiated while the transaction's read-modify-commit
 * cycle is in flight wait for the transaction to settle before sending their RPC.
 */
export function withRtdbTransactionBarrier<T>(
  ref: { readonly port: ClientPort; readonly instance?: ClientRtdbInstance; readonly path: string },
  fn: () => Promise<T>,
): Promise<T> {
  const set = transactionSetFor(ref);
  const prior = overlappingTransactionPromises(set, [ref.path]);
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry: ActiveRtdbTransaction = { path: ref.path, done };
  set.add(entry);
  const execute = (): Promise<T> =>
    fn().finally(() => {
      set.delete(entry);
      release();
    });
  if (prior.length === 0) return execute();
  return Promise.all(prior).then(execute);
}

/**
 * Runs `fn` immediately when no overlapping transaction is active on `(port, instance)`,
 * or waits for any already-started overlapping transaction to settle first.
 */
export function afterActiveRtdbTransactions<T>(
  ref: { readonly port: ClientPort; readonly instance?: ClientRtdbInstance },
  paths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (activeTransactionUpdateDepth > 0) return fn();
  const set = transactionSetFor(ref);
  const prior = overlappingTransactionPromises(set, paths);
  if (prior.length === 0) return fn();
  return Promise.all(prior).then(fn);
}

/** Whether two references belong to the same database instance. */
export function sameRtdbInstance(left: { readonly instance?: ClientRtdbInstance }, right: { readonly instance?: ClientRtdbInstance }): boolean {
  return left.instance?.name === right.instance?.name;
}

export function normalizeRtdbPath(path?: string): string {
  const joined = (path ?? '/').split('/').filter(Boolean).join('/');
  return joined ? `/${joined}` : '/';
}

function rtdbKey(path: string): string | null {
  return path.split('/').filter(Boolean).at(-1) ?? null;
}

/**
 * A reference's string form. With a known instance it is production's:
 * `Repo.toString()`, the scheme and host, followed by each path segment
 * URL-encoded (`pathToUrlEncodedString`). A handle that names no URL keeps
 * the worker form.
 */
function referenceString(instance: ClientRtdbInstance | undefined, path: string): string {
  if (instance === undefined) return `worker://rtdb${path}`;
  const hostEnd = instance.url.indexOf('/', instance.url.indexOf('//') + 2);
  const repo = instance.url.slice(0, hostEnd);
  const segments = path.split('/').filter(Boolean);
  const encoded = segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
  return repo + (encoded || '/');
}

export function makeRtdbRef(port: ClientPort, path: string, instance?: ClientRtdbInstance): RtdbRefHandle {
  const normalized = normalizeRtdbPath(path);
  const parts = normalized.split('/').filter(Boolean);
  const parentPath = parts.length > 0 ? `/${parts.slice(0, -1).join('/')}` : '/';
  const self: RtdbRefHandle = {
    __kind: 'rtdb-ref',
    port,
    ...(instance === undefined ? {} : { instance }),
    path: normalized,
    _path: normalized,
    _spec: { orderBy: null, bounds: [], limit: null },
    key: rtdbKey(normalized),
    get ref() { return self; },
    get parent() { return normalized === '/' ? null : makeRtdbRef(port, parentPath, instance); },
    get root() { return makeRtdbRef(port, '/', instance); },
    isEqual(other) {
      if (!other || typeof other !== 'object' || !('ref' in other) || !('_spec' in other)) return false;
      const otherRef = other.ref;
      return Boolean(otherRef && typeof otherRef === 'object' && 'port' in otherRef)
        && otherRef.port === port
        && sameRtdbInstance(otherRef, self)
        && otherRef._path === normalized
        && queryIdentifier(other._spec) === 'default';
    },
    toJSON() { return referenceString(instance, normalized); },
    toString() { return referenceString(instance, normalized); },
  };
  return self;
}

function validateRtdbPath(path: string, allowEmpty: boolean): void {
  const normalized = path.replace(/^\/*\.info(\/|$)/, '/');
  const isInvalidLength = !allowEmpty && path.length === 0;
  const containsForbiddenChars = /[.#$[\]]/.test(normalized);
  if (isInvalidLength || containsForbiddenChars) {
    throw new Error(
      `child failed: path argument was an invalid path = "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`,
    );
  }
}

export function rtdbRef(db: ClientRtdb, path?: string): RtdbRefHandle {
  if (isDisconnectedPort(db.port)) {
    throw new Error('FIREBASE FATAL ERROR: Cannot call ref on a deleted database. ');
  }
  if (path !== undefined) validateRtdbPath(path, true);
  return makeRtdbRef(db.port, path ?? '/', db.instance);
}

export function rtdbChild(parent: RtdbRefHandle, path: string): RtdbRefHandle {
  validateRtdbPath(path, false);
  return makeRtdbRef(parent.port, `${parent.path}/${path}`, parent.instance);
}

export function isRtdbQuery(target: RtdbTarget): target is RtdbQueryLike {
  return 'ref' in target && '_spec' in target && target.ref !== target;
}

export function targetParts(target: RtdbTarget): {
  ref: RtdbRefHandle;
  query?: RtdbQuerySpec;
} {
  if (!isRtdbQuery(target)) return { ref: target };
  if (queryIdentifier(target._spec) === 'default') return { ref: target.ref };
  return { ref: target.ref, query: target._spec };
}
