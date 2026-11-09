/**
 * What a Realtime Database client-SDK call adds to the live host's session
 * data (`database-session-capture.ts`), read through the
 * `sessionDataOf(record)` sidecar:
 * - `get`/`onValue` (bare `set` vs filtered query `update`), child listeners
 *   (`onChildAdded`/`Changed`/`Removed`), `set`, `setWithPriority`, `update`,
 *   `remove`, and `push`, while skipping `.sv` sentinels, `onDisconnect`, and
 *   failed operations.
 * - Measures each value in UTF-8 bytes of its JSON, as the host does.
 */
import { describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import { sessionDataOf, wrapLiveModule, type LiveCallRecord, type LiveModuleSite } from '../src/index.js';

describe('@pyric/live RTDB sessionData extraction', () => {
  const records: LiveCallRecord[] = [];
  const site: LiveModuleSite = {
    observer: (r) => records.push(r),
    sdkVersion: realApp.SDK_VERSION,
    client: 'node',
  };

  const sharedRepo = { repoInfo_: { namespace: 'demo-session-extract-default-rtdb' } };

  function makeDbRef(path: string, queryIdentifier = 'default') {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const normalizedPath = clean === '' ? '/' : `/${clean}`;
    const key = clean === '' ? null : clean.split('/').pop()!;
    return {
      key,
      _path: { toString: () => normalizedPath },
      _repo: sharedRepo,
      _queryIdentifier: queryIdentifier,
      toString: () =>
        `https://demo-session-extract-default-rtdb.firebaseio.com/${clean}`,
    };
  }

  function makeRtdbSnap(path: string, val: unknown, queryIdentifier = 'default') {
    const ref = makeDbRef(path, queryIdentifier);
    return {
      key: ref.key,
      ref,
      _query: ref,
      exists: () => val !== null,
      val: () => val,
    };
  }

  const callbacks: Record<string, (snap: unknown) => void> = {};

  const fakeRtdbSdk = {
    get: async (queryOrRef: { _queryIdentifier: string }) => {
      if (queryOrRef._queryIdentifier !== 'default') {
        return makeRtdbSnap('scores', { bob: 20 }, queryOrRef._queryIdentifier);
      }
      return makeRtdbSnap('scores', { alice: 10, bob: 20 });
    },
    onValue: (_q: unknown, cb: (snap: unknown) => void) => {
      callbacks.onValue = cb;
      return () => {};
    },
    onChildAdded: (_q: unknown, cb: (snap: unknown) => void) => {
      callbacks.onChildAdded = cb;
      return () => {};
    },
    onChildChanged: (_q: unknown, cb: (snap: unknown) => void) => {
      callbacks.onChildChanged = cb;
      return () => {};
    },
    onChildRemoved: (_q: unknown, cb: (snap: unknown) => void) => {
      callbacks.onChildRemoved = cb;
      return () => {};
    },
    set: async () => undefined,
    setWithPriority: async () => undefined,
    update: async () => undefined,
    remove: async () => undefined,
    push: (_parent: unknown, _value?: unknown) => {
      const resolvedRef = makeDbRef('messages/-Push123');
      return Object.assign(makeDbRef('messages/-Push123'), {
        then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(resolvedRef).then(onFulfilled, onRejected),
      });
    },
    runTransaction: async () => ({
      committed: true,
      snapshot: makeRtdbSnap('scores', { alice: 10 }),
    }),
    onDisconnect: (ref: unknown) => ({
      _ref: ref,
      set: async () => undefined,
      update: async () => undefined,
      remove: async () => undefined,
      cancel: async () => undefined,
    }),
  };

  const rtdb = wrapLiveModule(
    'live-database',
    'firebase/database',
    fakeRtdbSdk as unknown as typeof import('firebase/database'),
    site,
  );

  test('emits set for bare get/onValue and update for filtered RTDB queries so sibling keys are preserved', async () => {
    records.length = 0;
    await rtdb.get(makeDbRef('scores') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
          value: { alice: 10, bob: 20 },
        },
      ],
    });

    records.length = 0;
    await rtdb.get(makeDbRef('scores', '{"l":1}') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
        },
        {
          kind: 'update',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
          value: { bob: 20 },
        },
      ],
    });

    records.length = 0;
    rtdb.onValue(makeDbRef('scores', '{"ep":"20"}') as never, () => {});
    callbacks.onValue?.(makeRtdbSnap('scores', { bob: 20 }, '{"ep":"20"}'));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
        },
        {
          kind: 'update',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
          value: { bob: 20 },
        },
      ],
    });

    // Empty filtered onValue window invalidates departed children under `/scores` (#2540 N1).
    records.length = 0;
    callbacks.onValue?.(makeRtdbSnap('scores', null, '{"ep":"20"}'));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
        },
      ],
    });
  });

  test('captures child listeners, set, setWithPriority, update, remove, push, and skips .sv sentinels and onDisconnect', async () => {
    records.length = 0;
    rtdb.onChildAdded(makeDbRef('users') as never, () => {});
    callbacks.onChildAdded?.(makeRtdbSnap('users/u1', { name: 'Cara' }));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/users/u1',
          value: { name: 'Cara' },
        },
      ],
    });

    records.length = 0;
    rtdb.onChildRemoved(makeDbRef('users') as never, () => {});
    callbacks.onChildRemoved?.(makeRtdbSnap('users/u1', { name: 'Cara' }));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'remove',
          instance: 'demo-session-extract-default-rtdb',
          path: '/users/u1',
        },
      ],
    });

    records.length = 0;
    await rtdb.setWithPriority(makeDbRef('flags/beta') as never, true, 100);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/flags/beta',
          value: true,
        },
      ],
    });

    records.length = 0;
    await rtdb.update(makeDbRef('users') as never, {
      'u1/role': 'admin',
      'u1/serverTs': { '.sv': 'timestamp' },
    });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/users/u1/serverTs',
        },
        {
          kind: 'update',
          instance: 'demo-session-extract-default-rtdb',
          path: '/users',
          value: { 'u1/role': 'admin' },
        },
      ],
    });

    records.length = 0;
    await rtdb.remove(makeDbRef('users/u2') as never);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'remove',
          instance: 'demo-session-extract-default-rtdb',
          path: '/users/u2',
        },
      ],
    });

    records.length = 0;
    await rtdb.push(makeDbRef('messages') as never, { text: 'Hi there' });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/messages/-Push123',
          value: { text: 'Hi there' },
        },
      ],
    });

    records.length = 0;
    const od = rtdb.onDisconnect(makeDbRef('presence/u1') as never);
    await od.set('offline');
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toBeUndefined();
  });

  test('captures 100 KiB RTDB payloads while keeping 64 KiB rule evidence limits and tracking skipped deltas', async () => {
    const mediumPayload = { blob: 'y'.repeat(100 * 1024) };
    records.length = 0;
    await rtdb.set(makeDbRef('rooms/medium') as never, mediumPayload);
    const mediumRecord = records.find((r) => r.outcome === 'resolved')!;
    expect(mediumRecord.writeData).toBeUndefined();
    expect(sessionDataOf(mediumRecord)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/rooms/medium',
          value: mediumPayload,
        },
      ],
    });

    const oversizedPayload = { blob: 'y'.repeat(270 * 1024) };
    records.length = 0;
    await rtdb.set(makeDbRef('rooms/oversized') as never, oversizedPayload);
    const oversizedRecord = records.find((r) => r.outcome === 'resolved')!;
    expect(oversizedRecord.writeData).toBeUndefined();
    expect(sessionDataOf(oversizedRecord)).toEqual({ skipped: { oversized: 1 } });

    records.length = 0;
    await rtdb.update(makeDbRef('presence/u1') as never, {
      lastSeen: { '.sv': 'timestamp' },
    });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/presence/u1/lastSeen',
        },
      ],
      skipped: { unsupported: 1 },
    });

    records.length = 0;
    await rtdb.set(makeDbRef('presence/u1/lastSeen') as never, { '.sv': 'timestamp' });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/presence/u1/lastSeen',
        },
      ],
      skipped: { unsupported: 1 },
    });

    records.length = 0;
    await rtdb.runTransaction(makeDbRef('scores') as never, (curr: unknown) => curr);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      skipped: { unsupported: 1 },
    });
  });
  test('measures a value in UTF-8 bytes: one that fits by UTF-16 length but not by UTF-8 is skipped oversized, never sent', async () => {
    // 70 Ki emoji: 140 KiB of UTF-16 code units, but 280 KiB of UTF-8.
    const widePayload = { text: '\u{1F600}'.repeat(70 * 1024) };
    expect(widePayload.text.length).toBeLessThan(256 * 1024);
    records.length = 0;
    await rtdb.set(makeDbRef('rooms/wide') as never, widePayload);
    const wideRecord = records.find((r) => r.outcome === 'resolved')!;
    const sessionData = sessionDataOf(wideRecord);
    expect(sessionData).toEqual({ skipped: { oversized: 1 } });
    expect(JSON.stringify(sessionData)).not.toContain('\u{1F600}');

    // 60 Ki emoji: 240 KiB of UTF-8, under the 256 KiB item budget.
    const fittingPayload = { text: '\u{1F600}'.repeat(60 * 1024) };
    records.length = 0;
    await rtdb.set(makeDbRef('rooms/fits') as never, fittingPayload);
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/rooms/fits',
          value: fittingPayload,
        },
      ],
    });
  });

  test('emits leaf invalidate ops for nested .sv sentinels in set/push and for filtered onChildRemoved (#2540 F2, F3)', async () => {
    records.length = 0;
    await rtdb.set(makeDbRef('rooms/r1') as never, {
      name: 'Alpha',
      closedAt: { '.sv': 'timestamp' },
    });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/rooms/r1',
          value: { name: 'Alpha' },
        },
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/rooms/r1/closedAt',
        },
      ],
    });

    records.length = 0;
    await rtdb.push(makeDbRef('messages') as never, {
      text: 'Queued',
      createdAt: { '.sv': 'timestamp' },
    });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/messages/-Push123',
          value: { text: 'Queued' },
        },
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/messages/-Push123/createdAt',
        },
      ],
    });

    // Filtered query onChildRemoved means the child left the query window, NOT that it was deleted (#2540 F3).
    records.length = 0;
    rtdb.onChildRemoved(makeDbRef('slots', '{"l":1}') as never, () => {});
    callbacks.onChildRemoved?.(makeRtdbSnap('slots/s1', 'taken'));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/slots/s1',
        },
      ],
    });
  });

  test('emits invalidate instead of optimistic values when a listener fires while an RTDB write is still in flight (#2540 F6)', async () => {
    let settleWrite!: () => void;
    const inflightSdk = {
      ...fakeRtdbSdk,
      set: (_ref: unknown, value: unknown) => {
        // Simulate Firebase RTDB firing local onValue synchronously with the optimistic value before server ack.
        callbacks.onValue?.(makeRtdbSnap('slots/s1', value));
        return new Promise<void>((resolve) => {
          settleWrite = resolve;
        });
      },
    };
    const inflightRtdb = wrapLiveModule(
      'live-database',
      'firebase/database',
      inflightSdk as unknown as typeof import('firebase/database'),
      site,
    );

    records.length = 0;
    inflightRtdb.onValue(makeDbRef('slots/s1') as never, () => {});
    const pendingSet = inflightRtdb.set(makeDbRef('slots/s1') as never, { owner: 'u-1' });

    const optimisticDelivery = records.find((r) => r.outcome === 'delivered')!;
    expect(sessionDataOf(optimisticDelivery)).toEqual({
      rtdb: [
        {
          kind: 'invalidate',
          instance: 'demo-session-extract-default-rtdb',
          path: '/slots/s1',
        },
      ],
    });

    settleWrite();
    await pendingSet;

    // Once settled, subsequent server-confirmed deliveries capture normally again.
    records.length = 0;
    callbacks.onValue?.(makeRtdbSnap('slots/s1', { owner: 'u-9' }));
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual({
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-session-extract-default-rtdb',
          path: '/slots/s1',
          value: { owner: 'u-9' },
        },
      ],
    });
  });

  test('guards one-shot get reads during in-flight set/update/runTransaction and narrows push leases to the child path (#2540 H-A, M7, M8, M26)', async () => {
    const inst = 'demo-session-extract-default-rtdb';
    const setters: Record<string, () => void> = {};
    let pushSettle!: () => void;

    const asyncSdk = {
      ...fakeRtdbSdk,
      get: async (refObj: { _path: { toString(): string } }) =>
        makeRtdbSnap(String(refObj._path).slice(1), { owner: 'optimistic-user' }),
      set: () =>
        new Promise<void>((resolve) => {
          setters.set = resolve;
        }),
      update: () =>
        new Promise<void>((resolve) => {
          setters.update = resolve;
        }),
      runTransaction: () =>
        new Promise<unknown>((resolve) => {
          setters.tx = () => resolve({ committed: true });
        }),
      push: () => {
        const p = new Promise<object>((resolve) => {
          pushSettle = () => resolve(makeDbRef('messages/-PushNarrow'));
        });
        const pushedRef = makeDbRef('messages/-PushNarrow');
        return Object.assign(pushedRef, {
          key: '-PushNarrow',
          then: p.then.bind(p),
          catch: p.catch.bind(p),
        });
      },
    };
    const wrapped = wrapLiveModule(
      'live-database',
      'firebase/database',
      asyncSdk as unknown as typeof import('firebase/database'),
      site,
    );

    // 1. H-A: one-shot `get` while `set` is in flight emits `invalidate`, NOT optimistic `set`.
    records.length = 0;
    const pendingSet = wrapped.set(makeDbRef('notes/n1') as never, { owner: 'u-1' });
    await wrapped.get(makeDbRef('notes/n1') as never);
    const getDuringSet = records.find((r) => r.name === 'get' && r.outcome === 'resolved')!;
    expect(sessionDataOf(getDuringSet)).toEqual({
      rtdb: [{ kind: 'invalidate', instance: inst, path: '/notes/n1' }],
    });
    setters.set!();
    await pendingSet;

    // 2. M7: client `update` holds a patch-scoped lease while pending, leaving unrelated siblings unblocked.
    records.length = 0;
    const pendingUpdate = wrapped.update(makeDbRef('items') as never, { 'a/owner': 'u-1' });
    await wrapped.get(makeDbRef('items/a/owner') as never);
    await wrapped.get(makeDbRef('items/b/owner') as never);
    const updateGets = records.filter((r) => r.name === 'get' && r.outcome === 'resolved');
    expect(sessionDataOf(updateGets[0]!)).toEqual({
      rtdb: [{ kind: 'invalidate', instance: inst, path: '/items/a/owner' }],
    });
    expect(sessionDataOf(updateGets[1]!)).toEqual({
      rtdb: [{ kind: 'set', instance: inst, path: '/items/b/owner', value: { owner: 'optimistic-user' } }],
    });
    setters.update!();
    await pendingUpdate;

    // 3. M8: client `runTransaction` holds a lease while pending.
    records.length = 0;
    const pendingTx = wrapped.runTransaction(makeDbRef('counters/c1') as never, (v: unknown) => v);
    await wrapped.get(makeDbRef('counters/c1') as never);
    const getDuringTx = records.find((r) => r.name === 'get' && r.outcome === 'resolved')!;
    expect(sessionDataOf(getDuringTx)).toEqual({
      rtdb: [{ kind: 'invalidate', instance: inst, path: '/counters/c1' }],
    });
    setters.tx!();
    await pendingTx;

    // 4. M26: `push` narrows its lease on synchronous return from `/messages` to `/messages/-PushNarrow`,
    // so sibling `/messages/m-other` is NOT invalidated while `/messages/-PushNarrow` stays guarded until settlement.
    records.length = 0;
    const pendingPush = wrapped.push(makeDbRef('messages') as never, { text: 'pending' });
    await wrapped.get(makeDbRef('messages/m-other') as never);
    await wrapped.get(makeDbRef('messages/-PushNarrow') as never);
    const pushGets = records.filter((r) => r.name === 'get' && r.outcome === 'resolved');
    expect(sessionDataOf(pushGets[0]!)).toEqual({
      rtdb: [{ kind: 'set', instance: inst, path: '/messages/m-other', value: { owner: 'optimistic-user' } }],
    });
    expect(sessionDataOf(pushGets[1]!)).toEqual({
      rtdb: [{ kind: 'invalidate', instance: inst, path: '/messages/-PushNarrow' }],
    });
    pushSettle();
    await pendingPush;
  });
});
