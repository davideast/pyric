/**
 * What a Firestore client-SDK call adds to the live host's session data
 * (`firestore-session-capture.ts`), read through the `sessionDataOf(record)`
 * sidecar: only on settled successes (`resolved` / `delivered`), while
 * `LiveCallRecord` itself stays free of user values.
 * - Preserves Firestore scalar/reference types (`Timestamp`, `GeoPoint`, `Bytes`,
 *   `VectorValue`, `DocumentReference`), `setDoc` merge/mergeFields, `updateDoc`
 *   object + variadic `FieldPath` + `deleteField()`, `addDoc`, `deleteDoc`, and
 *   `writeBatch`.
 * - Never invokes custom `withConverter` functions and never treats query
 *   filter-removal (`docChanges()` `'removed'`) as a document deletion.
 * - Measures each document and each delta in UTF-8 bytes of its JSON, as the
 *   host does.
 */
import { describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import {
  Bytes,
  FieldPath,
  GeoPoint,
  Timestamp,
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
  vector,
} from 'firebase/firestore';
import {
  liveModuleFor,
  sessionDataOf,
  type LiveCallRecord,
  type LiveModuleSite,
} from '../src/index.js';

const PROJECT = 'demo-session-extract';
const SECRET = 'secret-payload-value-7712';

function makeFirestoreRef(path: string, converter: unknown = null) {
  const segments = path.split('/');
  return {
    type: 'document' as const,
    path,
    id: segments[segments.length - 1] ?? '',
    converter,
    firestore: { app: { options: { projectId: PROJECT } } },
  };
}

function makeCollectionRef(path: string, converter: unknown = null) {
  const segments = path.split('/');
  return {
    type: 'collection' as const,
    path,
    id: segments[segments.length - 1] ?? '',
    converter,
    firestore: { app: { options: { projectId: PROJECT } } },
  };
}

function makeDocSnapshot(
  path: string,
  data: Record<string, unknown> | undefined,
  opts: { fromCache?: boolean; hasPendingWrites?: boolean } = {},
) {
  const ref = makeCollectionOrDocRef(path);
  return {
    id: ref.id,
    ref,
    metadata: {
      fromCache: opts.fromCache ?? false,
      hasPendingWrites: opts.hasPendingWrites ?? false,
    },
    exists: () => data !== undefined,
    data: () => data,
  };
}

function makeCollectionOrDocRef(path: string) {
  return makeFirestoreRef(path);
}

describe('@pyric/live Firestore sessionData extraction', () => {
  const records: LiveCallRecord[] = [];
  const site: LiveModuleSite = {
    observer: (r) => records.push(r),
    sdkVersion: realApp.SDK_VERSION,
    client: 'node',
  };

  let onSnapshotHandler: ((snap: unknown) => void) | undefined;

  const fakeFirestoreSdk = {
    getDoc: async (ref: { path: string }) => {
      if (ref.path === 'users/missing') {
        return makeDocSnapshot('users/missing', undefined);
      }
      if (ref.path === 'users/denied') {
        const err = Object.assign(new Error('Permission denied'), { code: 'permission-denied' });
        throw err;
      }
      if (ref.path === 'users/huge') {
        return makeDocSnapshot('users/huge', { blob: 'x'.repeat(80 * 1024) });
      }
      if (ref.path === 'users/wide-fits') {
        return makeDocSnapshot('users/wide-fits', { blob: '\u6f22'.repeat(80 * 1024) });
      }
      if (ref.path === 'users/wide-over') {
        return makeDocSnapshot('users/wide-over', { blob: '\u6f22'.repeat(100 * 1024) });
      }
      if (ref.path === 'users/too-big') {
        return makeDocSnapshot('users/too-big', { blob: 'x'.repeat(270 * 1024) });
      }
      return makeDocSnapshot(ref.path, {
        name: 'Ada',
        createdAt: new Timestamp(1700000000, 500),
        location: new GeoPoint(37.7749, -122.4194),
        raw: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
        embedding: vector([0.25, 0.75]),
        teamRef: makeFirestoreRef('teams/core'),
      });
    },
    getDocs: async (query?: { path?: string }) => {
      if (query?.path === 'heavy') {
        const heavy = [1, 2, 3].map((i) =>
          makeDocSnapshot(`heavy/d${i}`, { blob: 'x'.repeat(180 * 1024) }),
        );
        return {
          docs: heavy,
          size: heavy.length,
          empty: false,
          metadata: { fromCache: false, hasPendingWrites: false },
          docChanges: () => heavy.map((doc) => ({ type: 'added', doc })),
        };
      }
      const d1 = makeDocSnapshot('tasks/t1', { title: 'Write tests', done: false });
      const d2 = makeDocSnapshot('tasks/t2', { title: 'Ship feature', done: true });
      return {
        docs: [d1, d2],
        size: 2,
        empty: false,
        metadata: { fromCache: false, hasPendingWrites: false },
        docChanges: () => [
          { type: 'added', doc: d1 },
          { type: 'added', doc: d2 },
        ],
      };
    },
    getDocFromCache: async (ref: { path: string }) =>
      ref.path === 'users/cache-unmarked'
        ? makeDocSnapshot(ref.path, { cached: true }, { fromCache: false, hasPendingWrites: false })
        : makeDocSnapshot(ref.path, { cached: true }, { fromCache: true }),
    getDocsFromCache: async (query?: { path?: string }) => {
      const fromCache = query?.path !== 'tasks-unmarked';
      const cachedDoc = makeDocSnapshot('tasks/cached', { title: 'Offline' }, { fromCache });
      return {
        docs: [cachedDoc],
        size: 1,
        empty: false,
        metadata: { fromCache, hasPendingWrites: false },
        docChanges: () => [{ type: 'added', doc: cachedDoc }],
      };
    },
    runTransaction: async (_db: unknown, _updateFn: unknown) => undefined,
    onSnapshot: (_target: unknown, next: (snap: unknown) => void) => {
      onSnapshotHandler = next;
      return () => {
        onSnapshotHandler = undefined;
      };
    },
    setDoc: async (_ref: unknown, _data: unknown, _options?: unknown) => undefined,
    updateDoc: async (..._args: unknown[]) => undefined,
    addDoc: async (coll: { path: string }, _data: unknown) =>
      makeFirestoreRef(`${coll.path}/generated-id`),
    deleteDoc: async (_ref: unknown) => undefined,
    writeBatch: () => {
      const batch = {
        set(_ref: unknown, _data: unknown, _opts?: unknown) {
          return batch;
        },
        update(..._args: unknown[]) {
          return batch;
        },
        delete(_ref: unknown) {
          return batch;
        },
        async commit() {},
      };
      return batch;
    },
  };

  const fs = liveModuleFor(
    'firebase/firestore',
    fakeFirestoreSdk as unknown as typeof import('firebase/firestore'),
    site,
  );

  test('captures getDoc hits with special Firestore types and emits delete on exists() === false', async () => {
    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/ada') as never);
    const hit = records.find((r) => r.outcome === 'resolved')!;
    expect(sessionDataOf(hit)).toEqual({
      firestore: [
        {
          kind: 'set',
          path: 'users/ada',
          data: {
            name: 'Ada',
            createdAt: { seconds: 1700000000, nanoseconds: 500 },
            location: { latitude: 37.7749, longitude: -122.4194 },
            raw: { type: 'firestore/bytes/1.0', bytes: 'AQID' },
            embedding: { __type__: '__vector__', value: [0.25, 0.75] },
            teamRef: { type: 'document', path: 'teams/core', id: 'core' },
          },
        },
      ],
    });

    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/missing') as never);
    const miss = records.find((r) => r.outcome === 'resolved')!;
    expect(sessionDataOf(miss)).toEqual({
      firestore: [{ kind: 'delete', path: 'users/missing' }],
    });
  });

  test('captures 80 KiB Firestore docs in sessionData while preserving 64 KiB rule evidence limits and tracking skipped deltas', async () => {
    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/huge') as never);
    const huge = records.find((r) => r.outcome === 'resolved')!;
    // Rule-evidence document capture remains capped at 64 KiB, while sessionData captures up to 256 KiB.
    expect(huge.document).toBeUndefined();
    expect(sessionDataOf(huge)).toEqual({
      firestore: [{ kind: 'set', path: 'users/huge', data: { blob: 'x'.repeat(80 * 1024) } }],
    });

    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/too-big') as never);
    const tooBig = records.find((r) => r.outcome === 'resolved')!;
    expect(tooBig.document).toBeUndefined();
    expect(sessionDataOf(tooBig)).toEqual({ skipped: { oversized: 1 } });

    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/denied') as never).catch(() => {});
    const denied = records.find((r) => r.outcome === 'rejected')!;
    expect(sessionDataOf(denied)).toBeUndefined();

    let converterCalled = false;
    const converter = {
      toFirestore: () => {
        converterCalled = true;
        return {};
      },
      fromFirestore: () => {
        converterCalled = true;
        return {};
      },
    };
    records.length = 0;
    await fs.setDoc(makeFirestoreRef('users/conv', converter) as never, { a: 1 } as never);
    const converted = records.find((r) => r.outcome === 'resolved')!;
    expect(converterCalled).toBe(false);
    expect(sessionDataOf(converted)).toEqual({ skipped: { unsupported: 1 } });

    records.length = 0;
    await fs.runTransaction({} as never, async () => 'ok');
    const tx = records.find((r) => r.name === 'runTransaction' && r.outcome === 'resolved')!;
    expect(sessionDataOf(tx)).toEqual({ skipped: { unsupported: 1 } });

    records.length = 0;
    await fs.getDocs(makeCollectionRef('heavy') as never);
    const heavyList = records.find((r) => r.name === 'getDocs' && r.outcome === 'resolved')!;
    expect(sessionDataOf(heavyList)).toEqual({
      firestore: [
        { kind: 'set', path: 'heavy/d1', data: { blob: 'x'.repeat(180 * 1024) } },
        { kind: 'set', path: 'heavy/d2', data: { blob: 'x'.repeat(180 * 1024) } },
      ],
      skipped: { truncated: 1 },
    });
  });

  test('captures query snapshots and never turns query filter-exit (removed) into document delete', async () => {
    records.length = 0;
    await fs.getDocs(makeCollectionRef('tasks') as never);
    const listRecord = records.find((r) => r.outcome === 'resolved')!;
    expect(sessionDataOf(listRecord)).toEqual({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { title: 'Write tests', done: false } },
        { kind: 'set', path: 'tasks/t2', data: { title: 'Ship feature', done: true } },
      ],
    });

    records.length = 0;
    const unsub = fs.onSnapshot(makeCollectionRef('tasks') as never, () => {});
    const modifiedDoc = makeDocSnapshot('tasks/t1', { title: 'Updated', done: false });
    const filteredOutDoc = makeDocSnapshot('tasks/t2', { title: 'Ship feature', done: true });
    onSnapshotHandler?.({
      docs: [modifiedDoc],
      size: 1,
      empty: false,
      metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => [
        { type: 'modified', doc: modifiedDoc },
        { type: 'removed', doc: filteredOutDoc },
      ],
    });
    unsub();

    const delivery = records.find((r) => r.outcome === 'delivered')!;
    expect(sessionDataOf(delivery)).toEqual({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { title: 'Updated', done: false } },
        { kind: 'invalidate', path: 'tasks/t2' },
      ],
    });
  });

  test('captures setDoc (overwrite, merge, mergeFields), updateDoc (object + variadic FieldPath + deleteField), addDoc, deleteDoc, and writeBatch without leaking into LiveCallRecord', async () => {
    records.length = 0;
    await fs.setDoc(makeFirestoreRef('rooms/r1') as never, { title: 'Lobby', count: 1 } as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [{ kind: 'set', path: 'rooms/r1', data: { title: 'Lobby', count: 1 } }],
    });

    records.length = 0;
    await fs.setDoc(
      makeFirestoreRef('rooms/r1') as never,
      { count: 2, obsolete: deleteField(), updatedAt: serverTimestamp() } as never,
      { merge: true },
    );
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        {
          kind: 'set',
          path: 'rooms/r1',
          data: { count: 2 },
          merge: true,
          deleteFields: ['obsolete', 'updatedAt'],
          partial: true,
        },
      ],
    });

    records.length = 0;
    await fs.setDoc(
      makeFirestoreRef('rooms/r1') as never,
      { profile: { name: 'Lobby 2', ignored: 'skip' }, keep: true } as never,
      { mergeFields: ['profile.name', new FieldPath('keep')] },
    );
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        {
          kind: 'update',
          path: 'rooms/r1',
          data: { 'profile.name': 'Lobby 2', keep: true },
          merge: true,
        },
      ],
    });

    records.length = 0;
    await fs.updateDoc(
      makeFirestoreRef('rooms/r1') as never,
      new FieldPath('meta', 'owner'),
      'alice',
      'temp',
      deleteField(),
    );
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        {
          kind: 'update',
          path: 'rooms/r1',
          data: { 'meta.owner': 'alice' },
          deleteFields: ['temp'],
        },
      ],
    });

    records.length = 0;
    await fs.addDoc(makeCollectionRef('rooms') as never, { title: 'New Room' } as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        { kind: 'set', path: 'rooms/generated-id', data: { title: 'New Room' } },
      ],
    });

    records.length = 0;
    await fs.deleteDoc(makeFirestoreRef('rooms/old') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [{ kind: 'delete', path: 'rooms/old' }],
    });

    records.length = 0;
    const batch = fs.writeBatch({ app: { options: { projectId: PROJECT } } } as never);
    batch.set(makeFirestoreRef('rooms/b1') as never, { secret: SECRET } as never);
    batch.update(makeFirestoreRef('rooms/b2') as never, { 'nested.flag': true } as never);
    batch.delete(makeFirestoreRef('rooms/b3') as never);
    await batch.commit();

    const commitRecord = records.find((r) => r.name === 'writeBatch' && r.outcome === 'resolved')!;
    // Privacy invariant: LiveCallRecord itself never embeds batch payload values.
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(sessionDataOf(commitRecord)).toEqual({
      firestore: [
        { kind: 'set', path: 'rooms/b1', data: { secret: SECRET } },
        { kind: 'update', path: 'rooms/b2', data: { 'nested.flag': true } },
        { kind: 'delete', path: 'rooms/b3' },
      ],
    });
  });
  test('measures a document in UTF-8 bytes: one that fits by UTF-16 length but not by UTF-8 is skipped oversized, never sent', async () => {
    // 80 Ki CJK characters: 240 KiB of UTF-8, under the 256 KiB item budget.
    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/wide-fits') as never);
    const fits = records.find((r) => r.outcome === 'resolved')!;
    expect(sessionDataOf(fits)).toEqual({
      firestore: [{ kind: 'set', path: 'users/wide-fits', data: { blob: '\u6f22'.repeat(80 * 1024) } }],
    });

    // 100 Ki CJK characters: 100 KiB of UTF-16 code units, but 300 KiB of UTF-8.
    records.length = 0;
    await fs.getDoc(makeFirestoreRef('users/wide-over') as never);
    const over = records.find((r) => r.outcome === 'resolved')!;
    const sessionData = sessionDataOf(over);
    expect(sessionData).toEqual({ skipped: { oversized: 1 } });
    expect(JSON.stringify(sessionData)).not.toContain('\u6f22');
  });

  test('a writeBatch commit spends one 512 KiB delta budget: the op it cuts off and every op after count truncated', async () => {
    records.length = 0;
    const blob = 'x'.repeat(200 * 1024);
    const batch = fs.writeBatch({ app: { options: { projectId: PROJECT } } } as never);
    batch.set(makeFirestoreRef('items/a') as never, { blob } as never);
    batch.set(makeFirestoreRef('items/b') as never, { blob } as never);
    batch.set(makeFirestoreRef('items/c') as never, { blob } as never);
    batch.delete(makeFirestoreRef('items/d') as never);
    await batch.commit();

    const commitRecord = records.find((r) => r.name === 'writeBatch' && r.outcome === 'resolved')!;
    expect(sessionDataOf(commitRecord)).toEqual({
      firestore: [
        { kind: 'set', path: 'items/a', data: { blob } },
        { kind: 'set', path: 'items/b', data: { blob } },
      ],
      skipped: { truncated: 2 },
    });
  });

  test('marks omitted write sentinels partial and drops stale sentinel fields across updateDoc, setDoc, and addDoc (#2540 F4)', async () => {
    records.length = 0;
    await fs.updateDoc(makeFirestoreRef('spaces/s1') as never, {
      members: arrayRemove('u-2'),
      admins: arrayUnion('u-1'),
      edits: increment(1),
      updatedBy: 'u-1',
    } as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        {
          kind: 'update',
          path: 'spaces/s1',
          data: { updatedBy: 'u-1' },
          deleteFields: ['members', 'admins', 'edits'],
          partial: true,
        },
      ],
    });

    records.length = 0;
    await fs.addDoc(makeCollectionRef('spaces') as never, {
      title: 'Team',
      createdAt: serverTimestamp(),
    } as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      firestore: [
        {
          kind: 'set',
          path: 'spaces/generated-id',
          data: { title: 'Team' },
          partial: true,
        },
      ],
    });
  });

  test('ignores cache-sourced and pending-write snapshots so unconfirmed reads never become authoritative (#2540 F5)', async () => {
    records.length = 0;
    await fs.getDocFromCache(makeFirestoreRef('users/cached') as never);
    const cachedDoc = records.find((r) => r.outcome === 'resolved')!;
    expect(cachedDoc.document).toBeUndefined();
    expect(sessionDataOf(cachedDoc)).toBeUndefined();

    records.length = 0;
    await fs.getDocsFromCache(makeCollectionRef('tasks') as never);
    const cachedQuery = records.find((r) => r.outcome === 'resolved')!;
    expect(sessionDataOf(cachedQuery)).toBeUndefined();

    records.length = 0;
    await fs.getDocFromCache(makeFirestoreRef('users/cache-unmarked') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toBeUndefined();

    records.length = 0;
    await fs.getDocsFromCache(makeCollectionRef('tasks-unmarked') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toBeUndefined();

    records.length = 0;
    const unsub = fs.onSnapshot(makeFirestoreRef('users/ada') as never, () => {});
    onSnapshotHandler?.(makeDocSnapshot('users/ada', { name: 'Local' }, { hasPendingWrites: true }));
    onSnapshotHandler?.(makeDocSnapshot('users/ada', undefined, { fromCache: true }));
    unsub();
    const deliveries = records.filter((r) => r.outcome === 'delivered');
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      expect(delivery.document).toBeUndefined();
      expect(sessionDataOf(delivery)).toBeUndefined();
    }

    // N4: A QuerySnapshot with top-level hasPendingWrites still captures server-confirmed sibling docs
    // while invalidating only the pending-write doc.
    records.length = 0;
    const unsubQuery = fs.onSnapshot(makeCollectionRef('tasks') as never, () => {});
    const confirmedSibling = makeDocSnapshot('tasks/t1', { status: 'closed' }, { fromCache: false, hasPendingWrites: false });
    const pendingSibling = makeDocSnapshot('tasks/t2', { status: 'draft' }, { fromCache: false, hasPendingWrites: true });
    onSnapshotHandler?.({
      docs: [confirmedSibling, pendingSibling],
      size: 2,
      empty: false,
      metadata: { fromCache: false, hasPendingWrites: true },
      docChanges: () => [
        { type: 'modified', doc: confirmedSibling },
        { type: 'added', doc: pendingSibling },
      ],
    });
    unsubQuery();
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { status: 'closed' } },
        { kind: 'invalidate', path: 'tasks/t2' },
      ],
    });
  });

  test('escapes colliding plain user maps while preserving document string fields verbatim', async () => {
    records.length = 0;
    await fs.setDoc(
      makeFirestoreRef('docs/d1') as never,
      {
        email: 'ada@example.test',
        note: 'verbatim-value',
        coordsMap: { latitude: 12.5, longitude: 42.25 },
        spanMap: { seconds: 30, nanoseconds: 0 },
        linkMap: { type: 'document', path: 'orgs/o1', id: 'o1' },
        escapedMap: { type: 'pyric/map/1.0', fields: { nested: 1 } },
      } as never,
    );
    const setRec = records.find((r) => r.name === 'setDoc' && r.outcome === 'resolved')!;
    expect(sessionDataOf(setRec)).toEqual({
      firestore: [
        {
          kind: 'set',
          path: 'docs/d1',
          data: {
            email: 'ada@example.test',
            note: 'verbatim-value',
            coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
            spanMap: { type: 'pyric/map/1.0', fields: { seconds: 30, nanoseconds: 0 } },
            linkMap: { type: 'pyric/map/1.0', fields: { type: 'document', path: 'orgs/o1', id: 'o1' } },
            escapedMap: { type: 'pyric/map/1.0', fields: { type: 'pyric/map/1.0', fields: { nested: 1 } } },
          },
        },
      ],
    });
  });
});
