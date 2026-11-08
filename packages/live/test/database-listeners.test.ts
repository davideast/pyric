import { describe, expect, test } from 'bun:test';
import { databaseListenerOnlyOnce } from '../src/database-listeners.js';
import { wrapLiveModule } from '../src/modules.js';
import type { Callback, LiveCallRecord } from '../src/observe.js';

const STAND_IN_REPOS = new Map<string, object>();

function standInRef(namespace: string, path: string, queryId = 'default'): object {
  let repo = STAND_IN_REPOS.get(namespace);
  if (repo === undefined) {
    repo = { repoInfo_: { namespace } };
    STAND_IN_REPOS.set(namespace, repo);
  }
  return { _repo: repo, _path: { toString: () => path }, _queryIdentifier: queryId };
}

describe('databaseListenerOnlyOnce', () => {
  test('reads { onlyOnce: true } from 3-arg and 4-arg RTDB listen overloads without throwing on hostile getters', () => {
    expect(databaseListenerOnlyOnce(['ref', () => undefined, { onlyOnce: true }])).toBe(true);
    expect(databaseListenerOnlyOnce(['ref', () => undefined, () => undefined, { onlyOnce: true }])).toBe(true);
    expect(databaseListenerOnlyOnce(['ref', () => undefined, { onlyOnce: false }])).toBe(false);
    expect(databaseListenerOnlyOnce(['ref', () => undefined])).toBe(false);
    const hostile = Object.defineProperty({}, 'onlyOnce', {
      get() {
        throw new Error('boom');
      },
    });
    expect(databaseListenerOnlyOnce(['ref', () => undefined, hostile])).toBe(false);
  });
});

describe('RTDB listener callback wrapping and onlyOnce lifecycle', () => {
  test('auto-detaches onValue and onChildAdded with { onlyOnce: true } after first delivery, and rebinds reused callbacks to fresh listenerIds', async () => {
    const handed: unknown[][] = [];
    const ownRecords: LiveCallRecord[] = [];
    const standIn = {
      onValue: (...args: unknown[]) => {
        handed.push(args);
        return () => undefined;
      },
      onChildAdded: (...args: unknown[]) => {
        handed.push(args);
        return () => undefined;
      },
    };
    const row = wrapLiveModule('live-database', 'firebase/database', standIn, {
      observer: (record) => {
        ownRecords.push(record);
      },
      sdkVersion: '12.0.0',
      client: 'page',
    });
    const roomRef = standInRef('demo-default-rtdb', '/rooms/r1');
    const seen: unknown[] = [];
    const sharedCallback = (snap: unknown) => {
      seen.push(snap);
    };

    row.onValue(roomRef, sharedCallback, { onlyOnce: true });
    (handed[0]![1] as Callback)('snap-1');
    await Promise.resolve();

    expect(ownRecords.map((r) => r.outcome)).toEqual(['attached', 'delivered', 'detached']);
    const firstId = ownRecords[0]!.listener!.id;
    expect(ownRecords[1]!.listenerId).toBe(firstId);
    expect(ownRecords[2]!.listener!.id).toBe(firstId);

    ownRecords.length = 0;
    row.onValue(roomRef, sharedCallback, () => undefined, { onlyOnce: true });
    (handed[1]![1] as Callback)('snap-2');
    await Promise.resolve();

    expect(ownRecords.map((r) => r.outcome)).toEqual(['attached', 'delivered', 'detached']);
    const secondId = ownRecords[0]!.listener!.id;
    expect(secondId).not.toBe(firstId);
    expect(ownRecords[1]!.listenerId).toBe(secondId);
    expect(ownRecords[2]!.listener!.id).toBe(secondId);
    expect(seen).toEqual(['snap-1', 'snap-2']);
  });

  test('isolates two different queries on one path sharing a callback, including an onlyOnce variant and default-ref off()', async () => {
    const handed: Array<{ cb: Callback; queryId: string }> = [];
    const offWrappers: Callback[] = [];
    const ownRecords: LiveCallRecord[] = [];
    const standIn = {
      onValue: (...args: unknown[]) => {
        const query = args[0] as { _queryIdentifier: string };
        handed.push({ cb: args[1] as Callback, queryId: query._queryIdentifier });
        return () => undefined;
      },
      off: (...args: unknown[]) => {
        if (typeof args[2] === 'function') offWrappers.push(args[2] as Callback);
      },
    };
    const row = wrapLiveModule('live-database', 'firebase/database', standIn, {
      observer: (record) => {
        ownRecords.push(record);
      },
      sdkVersion: '12.0.0',
      client: 'page',
    });
    const shared = () => undefined;

    // Query A (onlyOnce) and Query B (persistent) on `/rooms` with different query identifiers:
    row.onValue(standInRef('demo', '/rooms', 'default'), shared, { onlyOnce: true });
    row.onValue(standInRef('demo', '/rooms', '{"l":5}'), shared);
    // Query C (persistent) on `/rooms` default view sharing the same callback:
    row.onValue(standInRef('demo', '/rooms', 'default'), shared);
    await Promise.resolve();

    const [idOnceA, idLimitedB, idDefaultC] = ownRecords
      .filter((r) => r.outcome === 'attached')
      .map((r) => r.listener!.id);
    expect(handed[0]!.cb).not.toBe(handed[1]!.cb);
    expect(handed[1]!.cb).not.toBe(handed[2]!.cb);
    expect(handed[0]!.cb).not.toBe(handed[2]!.cb);

    // Firing ONLY Query B attributes solely to B and does NOT detach onlyOnce A!
    ownRecords.length = 0;
    handed[1]!.cb('only-B');
    await Promise.resolve();
    expect(ownRecords.filter((r) => r.outcome === 'delivered').map((r) => r.listenerId)).toEqual([
      idLimitedB,
    ]);
    expect(ownRecords.filter((r) => r.outcome === 'detached')).toEqual([]);

    // Firing Query A (onlyOnce) attributes to A and detaches ONLY A!
    ownRecords.length = 0;
    handed[0]!.cb('only-A');
    await Promise.resolve();
    expect(ownRecords.filter((r) => r.outcome === 'delivered').map((r) => r.listenerId)).toEqual([
      idOnceA,
    ]);
    expect(ownRecords.filter((r) => r.outcome === 'detached').map((r) => r.listener!.id)).toEqual([
      idOnceA,
    ]);

    // Default-ref `off('/rooms', 'value', shared)` unwraps and detaches both remaining views (B and C):
    ownRecords.length = 0;
    row.off(standInRef('demo', '/rooms', 'default'), 'value', shared);
    expect(offWrappers).toEqual([handed[1]!.cb, handed[2]!.cb]);
    expect(ownRecords.filter((r) => r.outcome === 'detached').map((r) => r.listener!.id)).toEqual([
      idLimitedB,
      idDefaultC,
    ]);
  });

  test('attributes concurrent subscriptions sharing one callback on the same view (including late initial delivery) without stateful round-robin', async () => {
    const handedWrappers: Callback[] = [];
    const ownRecords: LiveCallRecord[] = [];
    const standIn = {
      onValue: (...args: unknown[]) => {
        const cb = args[1] as Callback;
        handedWrappers.push(cb);
        return () => {
          const idx = handedWrappers.indexOf(cb);
          if (idx >= 0) handedWrappers.splice(idx, 1);
        };
      },
    };
    const row = wrapLiveModule('live-database', 'firebase/database', standIn, {
      observer: (record) => {
        ownRecords.push(record);
      },
      sdkVersion: '12.0.0',
      client: 'page',
    });
    const roomRef = standInRef('demo-default-rtdb', '/rooms/r1');
    const shared = () => undefined;

    const unsubA = row.onValue(roomRef, shared) as () => void;
    await Promise.resolve();
    // Sub A delivers its initial snapshot first:
    handedWrappers[0]!('snap-initial-A');
    await Promise.resolve();

    // Sub B subscribes later on the exact same view and receives its single cached initial snapshot:
    const unsubB = row.onValue(roomRef, shared) as () => void;
    await Promise.resolve();
    expect(handedWrappers[0]).toBe(handedWrappers[1]);

    const [idA, idB] = ownRecords.filter((r) => r.outcome === 'attached').map((r) => r.listener!.id);
    ownRecords.length = 0;
    handedWrappers[1]!('snap-initial-B');
    await Promise.resolve();
    expect(ownRecords.filter((r) => r.outcome === 'delivered').map((r) => r.listenerId)).toEqual([idB]);

    // Subsequent synchronous View update fires both registrations in one turn -> [idA, idB]:
    ownRecords.length = 0;
    for (const cb of [...handedWrappers]) cb('snap-concurrent-update');
    await Promise.resolve();
    expect(ownRecords.filter((r) => r.outcome === 'delivered').map((r) => r.listenerId)).toEqual([
      idA,
      idB,
    ]);

    unsubA();
    ownRecords.length = 0;
    for (const cb of [...handedWrappers]) cb('snap-after-unsubA');
    await Promise.resolve();
    expect(ownRecords.filter((r) => r.outcome === 'delivered').map((r) => r.listenerId)).toEqual([idB]);
    unsubB();
  });
});
