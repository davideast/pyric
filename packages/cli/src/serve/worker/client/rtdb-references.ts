/** RTDB database handles, references, and query target routing. */
import type { RtdbQuerySpec } from "../protocol.js";
import { isDisconnectedPort } from "./core.js";
import type { ClientDb, ClientPort, ClientRtdb, RtdbRefHandle } from "./handles.js";
import { getFirestore } from "./connection.js";

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

export function makeRtdbRef(port: ClientPort, path: string): RtdbRefHandle {
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

export type RtdbQueryLike = {
  readonly ref: RtdbRefHandle;
  readonly _spec: RtdbQuerySpec;
};

export type RtdbTarget = RtdbRefHandle | RtdbQueryLike;

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
