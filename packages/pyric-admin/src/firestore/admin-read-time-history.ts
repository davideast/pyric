/**
 * Point-in-time document version history and `readTime` execution for
 * `pyric-admin/firestore` read-only transactions (`#1975`).
 */

import {
  initializeSandbox,
  isRemoteSandbox,
  SandboxError,
  type Sandbox,
} from 'pyric/sandbox';
import { getAdminFirestore as baseGetAdminFirestore, type SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  Timestamp as CompatTimestamp,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type SnapshotFieldPath,
  type Transaction,
} from 'pyric/sandbox/admin-compat';
import { adminRawDbSandbox, isPlainMap } from './admin-handle-registry.js';
import { wrapDocSnapshot, wrapQuerySnapshot, type DocRefBuilder } from './admin-snapshot-adapter.js';
import { parseTransactionGetAllArgs, projectDocSnapshotFields } from './admin-transaction-getall.js';
import { assertQueryExecutable, type AdminQueryMetadata } from './admin-query-validation.js';
import { resolveExistingDocTimestamps } from './admin-write-result-preconditions.js';

interface HistoricalDocEntry {
  readonly atNanos: bigint;
  readonly exists: boolean;
  readonly localRawData?: DocumentData;
  readonly remoteAdminData?: DocumentData;
  readonly createTime?: CompatTimestamp;
  readonly updateTime?: CompatTimestamp;
}

interface TimelineStore {
  readonly byPath: Map<string, HistoricalDocEntry[]>;
}

const NANOS_PER_SEC = 1_000_000_000n;
const timelineByKey = new WeakMap<object, TimelineStore>();

function timestampToNanos(ts: CompatTimestamp): bigint {
  return BigInt(ts.seconds) * NANOS_PER_SEC + BigInt(ts.nanoseconds);
}

function resolveLedgerIdentityKey(rawDb: SandboxFirestore): object {
  const sb = adminRawDbSandbox.get(rawDb);
  if (sb !== undefined && !isRemoteSandbox(sb)) {
    return getInternalEnv(sb);
  }
  if (sb !== undefined) {
    return sb;
  }
  return rawDb;
}

function getTimelineStore(rawDb: SandboxFirestore): TimelineStore {
  const key = resolveLedgerIdentityKey(rawDb);
  let store = timelineByKey.get(key);
  if (store === undefined) {
    store = { byPath: new Map() };
    timelineByKey.set(key, store);
    const sb = adminRawDbSandbox.get(rawDb);
    const remote = sb !== undefined && isRemoteSandbox(sb);
    if (!remote && typeof rawDb.snapshot === 'function') {
      const initialSnap = rawDb.snapshot();
      for (const [docPath, rawData] of Object.entries(initialSnap)) {
        const times = resolveExistingDocTimestamps(rawDb, docPath);
        store.byPath.set(docPath, [
          {
            atNanos: 0n,
            exists: true,
            localRawData: clonePlainTree(rawData),
            createTime: times.createTime,
            updateTime: times.updateTime,
          },
        ]);
      }
    }
  }
  return store;
}

function clonePlainTree<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainTree(item)) as unknown as T;
  }
  if (isPlainMap(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: clonePlainTree(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy as T;
  }
  return value;
}

export function resetAdminHistoryOnSeed(
  rawDb: SandboxFirestore,
  seedTime: CompatTimestamp,
): void {
  const sb = adminRawDbSandbox.get(rawDb);
  if (sb !== undefined && isRemoteSandbox(sb)) {
    return;
  }
  const store = getTimelineStore(rawDb);
  store.byPath.clear();
  const snap = rawDb.snapshot();
  const atNanos = timestampToNanos(seedTime);
  for (const [docPath, rawData] of Object.entries(snap)) {
    store.byPath.set(docPath, [
      {
        atNanos,
        exists: true,
        localRawData: clonePlainTree(rawData),
        createTime: seedTime,
        updateTime: seedTime,
      },
    ]);
  }
}

export async function capturePreWriteBaselines(
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: DocRefBuilder,
  docPaths: readonly string[],
): Promise<void> {
  const store = getTimelineStore(rawDb);
  const sb = adminRawDbSandbox.get(rawDb);
  const remote = sb !== undefined && isRemoteSandbox(sb);

  if (!remote) {
    const snap = rawDb.snapshot();
    for (const path of docPaths) {
      if (store.byPath.has(path)) {
        continue;
      }
      const existingRaw = snap[path];
      if (existingRaw !== undefined) {
        const times = resolveExistingDocTimestamps(rawDb, path);
        store.byPath.set(path, [
          {
            atNanos: 0n,
            exists: true,
            localRawData: clonePlainTree(existingRaw),
            createTime: times.createTime,
            updateTime: times.updateTime,
          },
        ]);
      } else {
        store.byPath.set(path, [{ atNanos: 0n, exists: false }]);
      }
    }
    return;
  }

  for (const path of docPaths) {
    if (store.byPath.has(path)) {
      continue;
    }
    const rawSnap = await rawDb.doc(path).get();
    if (rawSnap.exists) {
      const wrapped = wrapDocSnapshot(rawSnap, rootDb, docRefOnRoot);
      const times = resolveExistingDocTimestamps(rawDb, path);
      store.byPath.set(path, [
        {
          atNanos: 0n,
          exists: true,
          remoteAdminData: clonePlainTree(wrapped.data()),
          createTime: times.createTime,
          updateTime: times.updateTime,
        },
      ]);
    } else {
      store.byPath.set(path, [{ atNanos: 0n, exists: false }]);
    }
  }
}

export async function recordPostWriteVersions(
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: DocRefBuilder,
  ops: ReadonlyArray<{ readonly path: string; readonly kind: 'write' | 'delete' }>,
  writeTime: CompatTimestamp,
): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  const store = getTimelineStore(rawDb);
  const sb = adminRawDbSandbox.get(rawDb);
  const remote = sb !== undefined && isRemoteSandbox(sb);
  const atNanos = timestampToNanos(writeTime);

  if (!remote) {
    const snap = rawDb.snapshot();
    for (const op of ops) {
      let list = store.byPath.get(op.path);
      if (list === undefined) {
        list = [];
        store.byPath.set(op.path, list);
      }
      if (op.kind === 'delete' || snap[op.path] === undefined) {
        list.push({ atNanos, exists: false });
      } else {
        const times = resolveExistingDocTimestamps(rawDb, op.path);
        list.push({
          atNanos,
          exists: true,
          localRawData: clonePlainTree(snap[op.path]),
          createTime: times.createTime,
          updateTime: writeTime,
        });
      }
    }
    return;
  }

  for (const op of ops) {
    let list = store.byPath.get(op.path);
    if (list === undefined) {
      list = [];
      store.byPath.set(op.path, list);
    }
    if (op.kind === 'delete') {
      list.push({ atNanos, exists: false });
    } else {
      const rawSnap = await rawDb.doc(op.path).get();
      if (!rawSnap.exists) {
        list.push({ atNanos, exists: false });
      } else {
        const wrapped = wrapDocSnapshot(rawSnap, rootDb, docRefOnRoot);
        const times = resolveExistingDocTimestamps(rawDb, op.path);
        list.push({
          atNanos,
          exists: true,
          remoteAdminData: clonePlainTree(wrapped.data()),
          createTime: times.createTime,
          updateTime: writeTime,
        });
      }
    }
  }
}

function stampHistoricalSnapshotTimestamps<T extends DocumentSnapshot>(
  snap: T,
  readTime: CompatTimestamp,
  entry: HistoricalDocEntry | undefined,
): T {
  return new Proxy(snap, {
    get(t, prop) {
      if (prop === 'readTime') {
        return readTime;
      }
      if (prop === 'createTime') {
        if (!snap.exists) {
          return undefined;
        }
        return entry?.createTime ?? Reflect.get(t, 'createTime', t);
      }
      if (prop === 'updateTime') {
        if (!snap.exists) {
          return undefined;
        }
        return entry?.updateTime ?? Reflect.get(t, 'updateTime', t);
      }
      const val = Reflect.get(t, prop, t);
      if (typeof val === 'function') {
        return val.bind(t);
      }
      return val;
    },
  });
}

function stampHistoricalQuerySnapshot(
  snap: QuerySnapshot,
  readTime: CompatTimestamp,
  resolvedEntries: ReadonlyMap<string, HistoricalDocEntry>,
): QuerySnapshot {
  const stampedDocs = snap.docs.map((doc) =>
    stampHistoricalSnapshotTimestamps(doc, readTime, resolvedEntries.get(doc.ref.path)),
  );
  return new Proxy(snap, {
    get(t, prop) {
      if (prop === 'readTime') {
        return readTime;
      }
      if (prop === 'docs') {
        return stampedDocs;
      }
      if (prop === 'forEach') {
        return (cb: (d: (typeof stampedDocs)[number]) => void, thisArg?: unknown) => {
          for (const d of stampedDocs) {
            cb.call(thisArg, d);
          }
        };
      }
      const val = Reflect.get(t, prop, t);
      if (typeof val === 'function') {
        return val.bind(t);
      }
      return val;
    },
  });
}

export interface ReadTimeExecutionHooks {
  readonly isAdminDocRefTarget: (v: unknown) => v is DocumentReference;
  readonly isAdminQueryTarget: (v: unknown) => v is Query;
  readonly getQueryMeta: (q: object) => AdminQueryMetadata | undefined;
  readonly docRefOnRoot: DocRefBuilder;
  readonly wrapTempAdminDb: (rawTempDb: SandboxFirestore, tempSb: Sandbox) => SandboxFirestore;
}

export async function executeReadOnlyTransactionAtReadTime<R>(
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  readTime: CompatTimestamp,
  callback: (tx: Transaction) => Promise<R>,
  hooks: ReadTimeExecutionHooks,
): Promise<R> {
  const targetNanos = timestampToNanos(readTime);
  const store = getTimelineStore(rawDb);
  const sb = adminRawDbSandbox.get(rawDb);
  const remote = sb !== undefined && isRemoteSandbox(sb);

  const resolvedEntries = new Map<string, HistoricalDocEntry>();
  const localSeedDocs: Record<string, DocumentData> = {};
  const remoteSeedDocs: Array<readonly [string, DocumentData]> = [];

  for (const [docPath, versions] of store.byPath.entries()) {
    let chosen: HistoricalDocEntry | undefined;
    for (const ver of versions) {
      if (ver.atNanos <= targetNanos) {
        chosen = ver;
      } else {
        break;
      }
    }
    if (chosen !== undefined && chosen.exists) {
      resolvedEntries.set(docPath, chosen);
      if (chosen.localRawData !== undefined) {
        localSeedDocs[docPath] = clonePlainTree(chosen.localRawData);
      } else if (chosen.remoteAdminData !== undefined) {
        remoteSeedDocs.push([docPath, clonePlainTree(chosen.remoteAdminData)]);
      }
    }
  }

  if (!remote) {
    const liveSnap = rawDb.snapshot();
    for (const [docPath, liveData] of Object.entries(liveSnap)) {
      if (!store.byPath.has(docPath)) {
        const times = resolveExistingDocTimestamps(rawDb, docPath);
        if (timestampToNanos(times.createTime) <= targetNanos) {
          const fallbackEntry: HistoricalDocEntry = {
            atNanos: 0n,
            exists: true,
            localRawData: clonePlainTree(liveData),
            createTime: times.createTime,
            updateTime: times.updateTime,
          };
          resolvedEntries.set(docPath, fallbackEntry);
          localSeedDocs[docPath] = clonePlainTree(liveData);
        }
      }
    }
  } else if (sb !== undefined) {
    const state = (await sb.channel.op({ method: 'admin.readState' })) as Record<string, unknown>;
    for (const docPath of Object.keys(state)) {
      if (!store.byPath.has(docPath)) {
        const times = resolveExistingDocTimestamps(rawDb, docPath);
        if (timestampToNanos(times.createTime) <= targetNanos) {
          const rawSnap = await rawDb.doc(docPath).get();
          if (rawSnap.exists) {
            const wrapped = wrapDocSnapshot(rawSnap, rootDb, hooks.docRefOnRoot);
            const data = wrapped.data();
            if (data !== undefined) {
              const fallbackEntry: HistoricalDocEntry = {
                atNanos: 0n,
                exists: true,
                remoteAdminData: clonePlainTree(data),
                createTime: times.createTime,
                updateTime: times.updateTime,
              };
              resolvedEntries.set(docPath, fallbackEntry);
              remoteSeedDocs.push([docPath, clonePlainTree(data)]);
            }
          }
        }
      }
    }
  }

  const tempSb = initializeSandbox({ projectId: 'pyric-readtime' });
  try {
    const rawTempDb = baseGetAdminFirestore(tempSb);
    if (Object.keys(localSeedDocs).length > 0) {
      rawTempDb.seed({ documents: localSeedDocs });
    }
    const tempWrappedDb = hooks.wrapTempAdminDb(rawTempDb, tempSb);
    for (const [docPath, adminData] of remoteSeedDocs) {
      await tempWrappedDb.doc(docPath).set(adminData);
    }

    const rejectReadOnlyWrite = (): never => {
      throw new SandboxError(
        'invalid-argument',
        'Firestore read-only transactions cannot execute writes.',
      );
    };

    const historicalTx: Transaction = {
      async get(refOrQuery: DocumentReference | Query): Promise<any> {
        if (hooks.isAdminQueryTarget(refOrQuery)) {
          const meta = hooks.getQueryMeta(refOrQuery);
          assertQueryExecutable(meta);
          if (meta?.replayOnRoot !== undefined) {
            const replayedQuery = meta.replayOnRoot(tempWrappedDb);
            const tempSnap = await replayedQuery.get();
            const rebound = wrapQuerySnapshot(tempSnap, rootDb, hooks.docRefOnRoot, {
              queryHandle: refOrQuery,
              selectedFields: meta.selectedFields,
            });
            return stampHistoricalQuerySnapshot(rebound, readTime, resolvedEntries);
          }
        }
        if (hooks.isAdminDocRefTarget(refOrQuery)) {
          const rawSnap = await rawTempDb.doc(refOrQuery.path).get();
          const wrapped = wrapDocSnapshot(rawSnap, rootDb, hooks.docRefOnRoot);
          return stampHistoricalSnapshotTimestamps(
            wrapped,
            readTime,
            resolvedEntries.get(refOrQuery.path),
          );
        }
        throw new SandboxError(
          'invalid-argument',
          'Value for argument "refOrQuery" must be a DocumentReference, Query, or AggregateQuery.',
        );
      },
      create: rejectReadOnlyWrite,
      set: rejectReadOnlyWrite,
      update: rejectReadOnlyWrite,
      delete: rejectReadOnlyWrite,
    };

    Object.defineProperty(historicalTx, 'getAll', {
      value: async (...args: unknown[]): Promise<DocumentSnapshot[]> => {
        const parsed = parseTransactionGetAllArgs(args);
        const results: DocumentSnapshot[] = [];
        for (const ref of parsed.refs) {
          const rawSnap = await rawTempDb.doc(ref.path).get();
          const wrapped = stampHistoricalSnapshotTimestamps(
            wrapDocSnapshot(rawSnap, rootDb, hooks.docRefOnRoot),
            readTime,
            resolvedEntries.get(ref.path),
          );
          if (parsed.fieldMask !== undefined) {
            results.push(projectDocSnapshotFields(wrapped, parsed.fieldMask));
          } else {
            results.push(wrapped);
          }
        }
        return results;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const returned = callback(historicalTx);
    if (
      returned === null ||
      (typeof returned !== 'object' && typeof returned !== 'function') ||
      typeof (returned as { then?: unknown }).then !== 'function'
    ) {
      throw new SandboxError(
        'invalid-argument',
        'You must return a Promise in your transaction()-callback.',
      );
    }
    return await returned;
  } finally {
    tempSb.dispose();
  }
}
