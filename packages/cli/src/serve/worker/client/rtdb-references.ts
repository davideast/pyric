/** RTDB database handles, references, path validation, and query target routing. */
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

/** The protocol's `instance` field for a reference: present only for a named instance. */
export function instanceField(ref: { readonly instance?: ClientRtdbInstance }): { instance?: string } {
  const name = ref.instance?.name;
  return name === undefined ? {} : { instance: name };
}

/** An RTDB operation on the reference's instance. */
export function rtdbRpc(
  ref: { readonly port: ClientPort; readonly instance?: ClientRtdbInstance },
  msg: InboundMessage & { t: 'op' },
): Promise<unknown> {
  return dataRpc(ref.port, { ...msg, ...instanceField(ref) } as InboundMessage & { t: 'op' });
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
    key: rtdbKey(normalized),
    get parent() { return normalized === '/' ? null : makeRtdbRef(port, parentPath, instance); },
    get root() { return makeRtdbRef(port, '/', instance); },
    isEqual(other) {
      return other !== null && other.__kind === 'rtdb-ref'
        && other.port === port && sameRtdbInstance(other, self) && other.path === normalized;
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
  return 'ref' in target && '_spec' in target;
}

export function targetParts(target: RtdbTarget): {
  ref: RtdbRefHandle;
  query?: RtdbQuerySpec;
} {
  return isRtdbQuery(target)
    ? { ref: target.ref, query: target._spec }
    : { ref: target };
}
