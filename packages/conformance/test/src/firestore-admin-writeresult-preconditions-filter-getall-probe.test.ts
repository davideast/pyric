import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import {
  type AdminCollectionRefLike,
  type AdminDocRefLike,
  type AdminDocSnapshotLike,
  type AdminQueryLike,
  type AdminTimestampLike,
  type AdminWriteResultLike,
  type FirestoreAdminWriteResultFilterGetAllSubject,
  classifyAdminParityError,
  observeFirestoreAdminWriteResultFilterGetAll,
  probe as adminParityProbe,
} from '../../probes/firestore-admin/firestore-admin-writeresult-preconditions-filter-getall.ts';

const PROBE_ID = 'firestore-admin-writeresult-preconditions-filter-getall';

function makeTimestamp(ms: number): AdminTimestampLike {
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return {
    seconds,
    nanoseconds,
    toMillis() {
      return ms;
    },
  };
}

function makeWriteResult(ms: number): AdminWriteResultLike {
  const writeTime = makeTimestamp(ms);
  return {
    writeTime,
    isEqual(other) {
      return (
        other.writeTime.seconds === writeTime.seconds &&
        other.writeTime.nanoseconds === writeTime.nanoseconds
      );
    },
  };
}

function createSyntheticAdminSubject(): FirestoreAdminWriteResultFilterGetAllSubject {
  let clockMs = 1_700_000_000_000;
  const store = new Map<string, { data: Record<string, unknown>; updatedMs: number }>();

  const nextWriteResult = (): { res: AdminWriteResultLike; ms: number } => {
    clockMs += 5;
    return { res: makeWriteResult(clockMs), ms: clockMs };
  };

  const checkPrecondition = (path: string, precondition?: Record<string, unknown>): void => {
    if (!precondition) return;
    const entry = store.get(path);
    if ('exists' in precondition && precondition.exists !== undefined) {
      if (precondition.exists === true && !entry) {
        throw { code: 5 };
      }
      if (precondition.exists === false && entry) {
        throw { code: 6 };
      }
    }
    if ('lastUpdateTime' in precondition && precondition.lastUpdateTime !== undefined) {
      const expected = (precondition.lastUpdateTime as AdminTimestampLike).toMillis();
      if (!entry || entry.updatedMs !== expected) {
        throw { code: 9 };
      }
    }
  };

  const docSnap = (path: string): AdminDocSnapshotLike => {
    const segs = path.split('/');
    const id = segs[segs.length - 1] ?? '';
    const entry = store.get(path);
    return {
      id,
      exists: entry !== undefined,
      data() {
        if (!entry) return undefined;
        return { ...entry.data };
      },
    };
  };

  const makeDoc = (path: string): AdminDocRefLike => ({
    async get() {
      return docSnap(path);
    },
    async create(data) {
      if (store.has(path)) throw { code: 6 };
      const { res, ms } = nextWriteResult();
      store.set(path, { data: { ...data }, updatedMs: ms });
      return res;
    },
    async set(data) {
      const { res, ms } = nextWriteResult();
      store.set(path, { data: { ...data }, updatedMs: ms });
      return res;
    },
    async update(data, precondition) {
      if (!store.has(path)) throw { code: 5 };
      checkPrecondition(path, precondition);
      const prev = store.get(path);
      let prevData: Record<string, unknown> = {};
      if (prev) {
        prevData = prev.data;
      }
      const { res, ms } = nextWriteResult();
      store.set(path, { data: { ...prevData, ...data }, updatedMs: ms });
      return res;
    },
    async delete(precondition) {
      checkPrecondition(path, precondition);
      store.delete(path);
      return nextWriteResult().res;
    },
  });

  type FilterSpec =
    | { kind: 'where'; field: string; op: string; value: unknown }
    | { kind: 'or' | 'and'; filters: FilterSpec[] };

  const evalFilter = (docData: Record<string, unknown>, f: FilterSpec): boolean => {
    if (f.kind === 'where') {
      const actual = docData[f.field];
      if (f.op === '==') return actual === f.value;
      if (f.op === '>=') return (actual as number) >= (f.value as number);
      return false;
    }
    if (f.kind === 'or') return f.filters.some((c) => evalFilter(docData, c));
    return f.filters.every((c) => evalFilter(docData, c));
  };

  const buildQuery = (
    collectionPath: string,
    filters: FilterSpec[],
    orderField?: string,
    orderDir: 'asc' | 'desc' = 'asc',
    startBound?: { val: unknown; inclusive: boolean },
    endBound?: { val: unknown; inclusive: boolean },
  ): AdminQueryLike => {
    const extractBoundVal = (arg: unknown): unknown => {
      if (arg !== null && typeof arg === 'object' && 'data' in arg && typeof (arg as AdminDocSnapshotLike).data === 'function') {
        const d = (arg as AdminDocSnapshotLike).data();
        if (d && orderField) return d[orderField];
      }
      return arg;
    };

    const runDocs = (): AdminDocSnapshotLike[] => {
      const prefix = `${collectionPath}/`;
      const matching: Array<{ id: string; data: Record<string, unknown>; snap: AdminDocSnapshotLike }> = [];
      for (const [key, val] of store.entries()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue;
        if (filters.every((f) => evalFilter(val.data, f))) {
          matching.push({ id: rest, data: val.data, snap: docSnap(key) });
        }
      }
      if (orderField) {
        matching.sort((a, b) => {
          const av = a.data[orderField] as number;
          const bv = b.data[orderField] as number;
          if (orderDir === 'desc') return bv - av;
          return av - bv;
        });
      } else {
        matching.sort((a, b) => a.id.localeCompare(b.id));
      }
      return matching
        .filter((item) => {
          if (!orderField) return true;
          const v = item.data[orderField] as number;
          if (startBound) {
            const b = startBound.val as number;
            if (startBound.inclusive && v < b) return false;
            if (!startBound.inclusive && v <= b) return false;
          }
          if (endBound) {
            const b = endBound.val as number;
            if (endBound.inclusive && v > b) return false;
            if (!endBound.inclusive && v >= b) return false;
          }
          return true;
        })
        .map((item) => item.snap);
    };

    return {
      where(fieldOrFilter, opStr, value) {
        if (typeof fieldOrFilter === 'string') {
          return buildQuery(
            collectionPath,
            [...filters, { kind: 'where', field: fieldOrFilter, op: opStr ?? '==', value }],
            orderField,
            orderDir,
            startBound,
            endBound,
          );
        }
        return buildQuery(
          collectionPath,
          [...filters, fieldOrFilter as FilterSpec],
          orderField,
          orderDir,
          startBound,
          endBound,
        );
      },
      orderBy(field, dir = 'asc') {
        return buildQuery(collectionPath, filters, field, dir, startBound, endBound);
      },
      startAt(arg) {
        return buildQuery(collectionPath, filters, orderField, orderDir, { val: extractBoundVal(arg), inclusive: true }, endBound);
      },
      startAfter(arg) {
        return buildQuery(collectionPath, filters, orderField, orderDir, { val: extractBoundVal(arg), inclusive: false }, endBound);
      },
      endAt(arg) {
        return buildQuery(collectionPath, filters, orderField, orderDir, startBound, { val: extractBoundVal(arg), inclusive: true });
      },
      endBefore(arg) {
        return buildQuery(collectionPath, filters, orderField, orderDir, startBound, { val: extractBoundVal(arg), inclusive: false });
      },
      aggregate(spec) {
        return {
          async get() {
            const docs = runDocs();
            const out: Record<string, unknown> = {};
            for (const [alias, agg] of Object.entries(spec)) {
              const kind = (agg as { kind: string; field?: string }).kind;
              const field = (agg as { field?: string }).field ?? '';
              if (kind === 'count') {
                out[alias] = docs.length;
              } else if (kind === 'sum') {
                out[alias] = docs.reduce((acc, d) => acc + Number(d.data()?.[field] ?? 0), 0);
              } else if (kind === 'avg') {
                const total = docs.reduce((acc, d) => acc + Number(d.data()?.[field] ?? 0), 0);
                out[alias] = total / docs.length;
              }
            }
            return { data: () => out };
          },
        };
      },
      async get() {
        return { docs: runDocs() };
      },
    };
  };

  const pathForRef = new WeakMap<AdminDocRefLike, string>();
  const wrapTrackedDoc = (path: string): AdminDocRefLike => {
    const ref = makeDoc(path);
    pathForRef.set(ref, path);
    return ref;
  };

  return {
    doc: wrapTrackedDoc,
    collection(collectionPath): AdminCollectionRefLike {
      const base = buildQuery(collectionPath, []);
      return {
        ...base,
        doc(childPath) {
          return wrapTrackedDoc(`${collectionPath}/${childPath}`);
        },
      };
    },
    batch() {
      const ops: Array<() => Promise<AdminWriteResultLike>> = [];
      const b = {
        create(ref: AdminDocRefLike, data: Record<string, unknown>) {
          ops.push(() => ref.create(data));
          return b;
        },
        set(ref: AdminDocRefLike, data: Record<string, unknown>, options?: Record<string, unknown>) {
          ops.push(() => ref.set(data, options));
          return b;
        },
        update(ref: AdminDocRefLike, data: Record<string, unknown>, precondition?: Record<string, unknown>) {
          ops.push(() => ref.update(data, precondition));
          return b;
        },
        delete(ref: AdminDocRefLike, precondition?: Record<string, unknown>) {
          ops.push(() => ref.delete(precondition));
          return b;
        },
        async commit() {
          const backup = new Map(store);
          try {
            const results: AdminWriteResultLike[] = [];
            for (const op of ops) {
              results.push(await op());
            }
            return results;
          } catch (err) {
            store.clear();
            for (const [k, v] of backup.entries()) {
              store.set(k, v);
            }
            throw err;
          }
        },
      };
      return b;
    },
    async runTransaction(fn) {
      const backup = new Map(store);
      let wrote = false;
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        async get(ref: AdminDocRefLike) {
          if (wrote) throw { code: 9 };
          return ref.get();
        },
        async getAll(...refs: AdminDocRefLike[]) {
          if (wrote) throw { code: 9 };
          return Promise.all(refs.map((r) => r.get()));
        },
        set(ref: AdminDocRefLike, data: Record<string, unknown>) {
          wrote = true;
          queued.push(() => ref.set(data));
          return tx;
        },
        update(ref: AdminDocRefLike, data: Record<string, unknown>, precondition?: Record<string, unknown>) {
          wrote = true;
          queued.push(() => ref.update(data, precondition));
          return tx;
        },
        delete(ref: AdminDocRefLike, precondition?: Record<string, unknown>) {
          wrote = true;
          queued.push(() => ref.delete(precondition));
          return tx;
        },
      };
      try {
        const out = await fn(tx);
        for (const op of queued) {
          await op();
        }
        return out;
      } catch (err) {
        store.clear();
        for (const [k, v] of backup.entries()) {
          store.set(k, v);
        }
        throw err;
      }
    },
    filterWhere: (field, op, value) => ({ kind: 'where', field, op, value }),
    filterOr: (...filters) => ({ kind: 'or', filters }),
    filterAnd: (...filters) => ({ kind: 'and', filters }),
    aggregateCount: () => ({ kind: 'count' }),
    aggregateSum: (field) => ({ kind: 'sum', field }),
    aggregateAverage: (field) => ({ kind: 'avg', field }),
    epochZeroTimestamp: () => makeTimestamp(0),
    classifyError: classifyAdminParityError,
  };
}

describe('staged firestore-admin WriteResult, Precondition, Filter, AggregateQuery, cursor, and getAll probe', () => {
  test('registers under sdk-probes with linked firestore-admin#4/#7/#8 rows', async () => {
    expect(auditProbeSessionAuthModes()).toEqual([]);
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(adminParityProbe.rig).toBe('sdk-probes');
    expect(adminParityProbe.requires).toEqual(['admin-firestore']);
    expect(adminParityProbe.pendingRowLink).toBeUndefined();
    expect(adminParityProbe.matrixRow).toBe('firestore-admin#4');
    expect(adminParityProbe.rowIds).toEqual([
      'firestore-admin#4',
      'firestore-admin#7',
      'firestore-admin#8',
    ]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded.filter((entry) => entry.id === PROBE_ID),
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.join('\n')).toContain(PROBE_ID);
  });

  test('produces deterministic two-run observations across WriteResult, Precondition, Filter, AggregateQuery, cursors, and Transaction.getAll', async () => {
    const first = await observeFirestoreAdminWriteResultFilterGetAll(
      createSyntheticAdminSubject(),
      'pyric_oracle/run1',
    );
    const second = await observeFirestoreAdminWriteResultFilterGetAll(
      createSyntheticAdminSubject(),
      'pyric_oracle/run2',
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.writeResultAndPreconditions).toMatchObject({
      createHasWriteTime: true,
      setHasWriteTime: true,
      createEqualsSelf: true,
      writeTimeMonotonicCreateToSet: true,
      epochZeroNotEqualCreateTime: true,
      updateExistsTrueOnExisting: { ok: true, hasWriteTime: true },
      updateExactLastUpdateTime: { ok: true, hasWriteTime: true },
      updateStaleLastUpdateTime: { ok: false, category: 'failed-precondition' },
      deleteExistsTrueOnExisting: { ok: true, hasWriteTime: true },
      deleteExistsTrueOnMissing: { ok: false, category: 'not-found' },
      deleteExistsFalseOnMissing: { ok: true, hasWriteTime: true },
      updateExistsTrueOnMissing: { ok: false, category: 'not-found' },
    });
    expect(first.filterAggregateAndCursors).toEqual({
      orIdsSorted: ['p1', 'p3', 'p4'],
      andIdsSorted: ['p3'],
      nestedFilterOrderedIds: ['p3', 'p4'],
      aggregateHasGetMethod: true,
      aggregateData: { total: 4, sumScore: 100, avgScore: 25 },
      startAt20Ids: ['p2', 'p3', 'p4'],
      startAfter20Ids: ['p3', 'p4'],
      endAt30Ids: ['p1', 'p2', 'p3'],
      endBefore30Ids: ['p1', 'p2'],
      window20To30Ids: ['p2', 'p3'],
      startAtSnapP2Ids: ['p2', 'p3', 'p4'],
      startAfterSnapP2Ids: ['p3', 'p4'],
      endAtSnapP3Ids: ['p1', 'p2', 'p3'],
      endBeforeSnapP3Ids: ['p1', 'p2'],
    });
  });
});
