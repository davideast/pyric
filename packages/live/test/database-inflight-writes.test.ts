/**
 * 1:1 unit tests for `database-inflight-writes.ts` (#2540 F6):
 * tracks active in-flight Realtime Database writes and converts overlapping
 * optimistic listener deliveries and one-shot reads into `invalidate`
 * operations until settlement, folding expired or cap-evicted unsettled leases
 * into bounded fail-closed taint until `release()`.
 */
import { describe, expect, test } from 'bun:test';
import { UNREAD_INSTANCE } from '../src/database.js';
import {
  createInFlightRtdbWriteTracker,
  MAX_ACTIVE_INFLIGHT_WRITES,
} from '../src/database-inflight-writes.js';

const INSTANCE = 'demo-project-default-rtdb';
const OTHER_INSTANCE = 'other-project-default-rtdb';
const COVERED = { kind: 'covered' } as const;
const NONE = { kind: 'none' } as const;

function createClockedTracker(limits?: { maxActiveWrites?: number; maxTaintedInstances?: number }) {
  let clock = 1_000;
  const tracker = createInFlightRtdbWriteTracker({
    unreadInstance: UNREAD_INSTANCE,
    ...limits,
  });
  const start = (instance: string, path: string, ttlMs = 10) =>
    tracker.createWriteStarter(instance, [path], undefined, { ttlMs, now: () => clock })!();
  const overlapOf = (instance: string, path: string) => tracker.overlapOf(instance, path, () => clock);
  return {
    tracker,
    start,
    overlapOf,
    tick(ms: number) {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('database-inflight-writes (#2540 F6)', () => {
  test('converts covered deliveries to invalidate while preserving sibling keys on parent deliveries', () => {
    const tracker = createInFlightRtdbWriteTracker({ unreadInstance: UNREAD_INSTANCE });
    expect(tracker.createWriteStarter(INSTANCE, [])).toBeUndefined();
    expect(tracker.writeLeaseStarter({ name: 'get', instance: INSTANCE, path: '/slots' })).toBeUndefined();

    const startWrite = tracker.writeLeaseStarter({
      name: 'update',
      instance: INSTANCE,
      path: '/slots',
      patchArg: { s1: { owner: 'u-1' } },
    })!;
    expect(tracker.overlapOf(INSTANCE, '/slots/s1')).toEqual(NONE);

    const lease = startWrite();
    try {
      expect(tracker.overlapOf(INSTANCE, '/slots/s1')).toEqual(COVERED);
      expect(tracker.overlapOf(INSTANCE, '/slots/s1/owner')).toEqual(COVERED);
      expect(tracker.overlapOf(OTHER_INSTANCE, '/slots/s1')).toEqual(NONE);
      expect(tracker.overlapOf(UNREAD_INSTANCE, '/slots/s1')).toEqual(COVERED);
      expect(tracker.overlapOf(INSTANCE, '/slots')).toEqual({
        kind: 'descendants',
        paths: ['/slots/s1'],
      });

      let baseComputed = false;
      expect(
        tracker.applyDeliveryGuard(INSTANCE, '/slots/s1', () => {
          baseComputed = true;
          return { rtdb: [{ kind: 'set', instance: INSTANCE, path: '/slots/s1', value: { owner: 'u-1' } }] };
        }),
      ).toEqual({
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/slots/s1' }],
      });
      expect(baseComputed).toBe(false);

      expect(
        tracker.applyDeliveryGuard(INSTANCE, '/slots', () => ({
          rtdb: [
            {
              kind: 'set',
              instance: INSTANCE,
              path: '/slots',
              value: { s1: { owner: 'u-1' }, s2: { owner: 'u-2' } },
            },
          ],
        })),
      ).toEqual({
        rtdb: [
          {
            kind: 'set',
            instance: INSTANCE,
            path: '/slots',
            value: { s1: { owner: 'u-1' }, s2: { owner: 'u-2' } },
          },
          { kind: 'invalidate', instance: INSTANCE, path: '/slots/s1' },
        ],
      });
    } finally {
      lease.release();
    }

    expect(tracker.overlapOf(INSTANCE, '/slots/s1')).toEqual(NONE);
  });

  test('narrows push in-flight scope from parent path to the allocated child path on synchronous return', () => {
    const tracker = createInFlightRtdbWriteTracker({ unreadInstance: UNREAD_INSTANCE });
    const startPush = tracker.createWriteStarter(INSTANCE, ['/messages'], (returned) =>
      typeof returned === 'object' && returned !== null && 'childPath' in returned
        ? String((returned as { childPath: string }).childPath)
        : undefined,
    )!;

    const lease = startPush();
    try {
      expect(tracker.overlapOf(INSTANCE, '/messages/m-existing')).toEqual(COVERED);

      lease.onReturn({ childPath: '/messages/-Push1' });
      expect(tracker.overlapOf(INSTANCE, '/messages/m-existing')).toEqual(NONE);
      expect(tracker.overlapOf(INSTANCE, '/messages/-Push1')).toEqual(COVERED);
    } finally {
      lease.release();
    }

    expect(tracker.overlapOf(INSTANCE, '/messages/-Push1')).toEqual(NONE);
  });

  test('fails closed on TTL expiry and cap eviction by tainting the instance until release()', () => {
    const { tracker, start, overlapOf, tick, now } = createClockedTracker();
    const expiringLease = start(INSTANCE, '/offline/item', 5_000);
    try {
      expect(overlapOf(INSTANCE, '/offline/item')).toEqual(COVERED);
      expect(overlapOf(INSTANCE, '/offline/sibling')).toEqual(NONE);

      // Exact boundary (`expiresAt === nowMs`) and beyond fold into per-instance fail-closed taint.
      tick(5_000);
      expect(overlapOf(INSTANCE, '/offline/item')).toEqual(COVERED);
      expect(overlapOf(INSTANCE, '/offline/sibling')).toEqual(COVERED);
      expect(overlapOf(OTHER_INSTANCE, '/offline/item')).toEqual(NONE);
      expect(
        tracker.applyDeliveryGuard(
          INSTANCE,
          '/',
          () => ({ rtdb: [{ kind: 'set', instance: INSTANCE, path: '/', value: { offline: true } }] }),
          now,
        ),
      ).toEqual({
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/' }],
      });
    } finally {
      expiringLease.release();
    }
    expect(overlapOf(INSTANCE, '/offline/item')).toEqual(NONE);

    // Exceeding MAX_ACTIVE_INFLIGHT_WRITES evicts the oldest leases into fail-closed taint until released.
    const capLeases = [];
    try {
      for (let i = 0; i < MAX_ACTIVE_INFLIGHT_WRITES + 2; i += 1) {
        capLeases.push(start(INSTANCE, `/cap/item-${i}`, 60_000));
      }
      expect(overlapOf(INSTANCE, '/cap/item-0')).toEqual(COVERED);
      expect(overlapOf(INSTANCE, '/cap/item-1')).toEqual(COVERED);
      expect(overlapOf(OTHER_INSTANCE, '/cap/item-0')).toEqual(NONE);
    } finally {
      for (const lease of capLeases) lease.release();
    }
    expect(overlapOf(INSTANCE, '/cap/item-0')).toEqual(NONE);
    expect(overlapOf(INSTANCE, `/cap/item-${MAX_ACTIVE_INFLIGHT_WRITES + 1}`)).toEqual(NONE);
  });

  test('clears taint only on the original lease release, counts multiple tainted leases accurately, and keeps release idempotent', () => {
    const { tracker, start, overlapOf, tick, now } = createClockedTracker();

    // T1: settling a later active write on the same instance never clears an earlier expired lease's taint.
    const first = start(INSTANCE, '/a', 10);
    tick(10);
    expect(overlapOf(INSTANCE, '/unrelated')).toEqual(COVERED);
    const activeLater = start(INSTANCE, '/b', 100_000);
    activeLater.release();
    activeLater.release();
    expect(overlapOf(INSTANCE, '/unrelated')).toEqual(COVERED);
    first.release();
    expect(overlapOf(INSTANCE, '/unrelated')).toEqual(NONE);

    // T2: three expired leases on the same instance require all three distinct releases; repeated release() is inert.
    const tA = start(INSTANCE, '/a', 10);
    const tB = start(INSTANCE, '/b', 10);
    const tC = start(INSTANCE, '/c', 10);
    tick(11);
    expect(overlapOf(INSTANCE, '/x')).toEqual(COVERED);
    tA.release();
    tA.release();
    tA.release();
    expect(overlapOf(INSTANCE, '/x')).toEqual(COVERED);
    tB.release();
    tB.release();
    // Exactly 1 tainted lease (`tC`) remains (`current === 1`); taint must still hold!
    expect(overlapOf(INSTANCE, '/x')).toEqual(COVERED);
    tC.release();
    expect(overlapOf(INSTANCE, '/x')).toEqual(NONE);

    // T3: releasing before expiry leaves zero taint after time advances, and onReturn after demotion is inert.
    const pushStarter = tracker.createWriteStarter(
      INSTANCE,
      ['/p'],
      () => '/p/child',
      { ttlMs: 10, now },
    )!;
    const settledEarly = pushStarter();
    settledEarly.release();
    tick(100_000);
    expect(overlapOf(INSTANCE, '/p')).toEqual(NONE);

    const demotedPush = pushStarter();
    tick(11);
    expect(overlapOf(INSTANCE, '/q')).toEqual(COVERED);
    demotedPush.onReturn({});
    expect(overlapOf(INSTANCE, '/q')).toEqual(COVERED);
    demotedPush.release();
    expect(overlapOf(INSTANCE, '/q')).toEqual(NONE);
  });

  test('guards UNREAD_INSTANCE symmetrically under overflow taint without tainting unrelated named instances', () => {
    const { start, overlapOf, tick } = createClockedTracker();

    // Taint on UNREAD_INSTANCE guards every named instance until released.
    const unreadWrite = start(UNREAD_INSTANCE, '/a', 10);
    tick(11);
    expect(overlapOf(OTHER_INSTANCE, '/q')).toEqual(COVERED);
    expect(overlapOf(UNREAD_INSTANCE, '/q')).toEqual(COVERED);
    unreadWrite.release();
    expect(overlapOf(OTHER_INSTANCE, '/q')).toEqual(NONE);

    // Taint on a named instance guards UNREAD_INSTANCE reads while leaving OTHER_INSTANCE unguarded.
    const namedWrite = start(INSTANCE, '/a', 10);
    tick(11);
    expect(overlapOf(UNREAD_INSTANCE, '/q')).toEqual(COVERED);
    expect(overlapOf(INSTANCE, '/q')).toEqual(COVERED);
    expect(overlapOf(OTHER_INSTANCE, '/q')).toEqual(NONE);
    namedWrite.release();
    expect(overlapOf(UNREAD_INSTANCE, '/q')).toEqual(NONE);
  });

  test('falls back to scalar global fail-closed taint above maxTaintedInstances and preserves exact counts on re-entry', () => {
    const { start, overlapOf, tick } = createClockedTracker({
      maxActiveWrites: 1,
      maxTaintedInstances: 2,
    });
    const l1 = start('inst-1', '/a', 100_000);
    const l2 = start('inst-2', '/a', 100_000);
    const l3 = start('inst-3', '/a', 100_000);
    const l4 = start('inst-4', '/a', 100_000);
    try {
      // `l1` and `l2` filled per-instance taint; `l3` spilled to scalar global taint, guarding every instance.
      expect(overlapOf('untouched-instance', '/other')).toEqual(COVERED);
      expect(overlapOf(UNREAD_INSTANCE, '/other')).toEqual(COVERED);
      l3.release();
      expect(overlapOf('untouched-instance', '/other')).toEqual(NONE);
      expect(overlapOf('inst-1', '/other')).toEqual(COVERED);
      expect(overlapOf('inst-2', '/other')).toEqual(COVERED);

      // Re-entry: settling active `l4` and tainted `l1` frees a per-instance slot for a new `inst-3` overflow while keeping counts exact.
      l4.release();
      l1.release();
      const l3Again = start('inst-3', '/b', 10);
      tick(11);
      expect(overlapOf('inst-3', '/other')).toEqual(COVERED);
      expect(overlapOf('untouched-instance', '/other')).toEqual(NONE);
      l3Again.release();
      expect(overlapOf('inst-3', '/other')).toEqual(NONE);
    } finally {
      l1.release();
      l2.release();
      l3.release();
      l4.release();
    }
    expect(overlapOf('inst-1', '/a')).toEqual(NONE);
    expect(overlapOf('inst-2', '/a')).toEqual(NONE);
    expect(overlapOf('inst-4', '/a')).toEqual(NONE);
  });
});
