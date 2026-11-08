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
          kind: 'update',
          instance: 'demo-session-extract-default-rtdb',
          path: '/scores',
          value: { bob: 20 },
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
      skipped: { unsupported: 1 },
    });

    records.length = 0;
    await rtdb.set(makeDbRef('presence/u1/lastSeen') as never, { '.sv': 'timestamp' });
    expect(sessionDataOf(records.find((r) => r.outcome === 'resolved')!)).toEqual({
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
});
