/**
 * 1:1 unit tests for `database-inflight-writes.ts` (#2540 F6):
 * tracks active in-flight Realtime Database writes and converts overlapping
 * optimistic listener deliveries and one-shot reads into `invalidate`
 * operations until settlement, folding expired or cap-evicted unsettled leases
 * into bounded fail-closed taint until `release()`.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyInFlightRtdbDeliveryGuard,
  createInFlightRtdbWriteStarter,
  createInFlightRtdbWriteTracker,
  inFlightRtdbOverlapOf,
  MAX_ACTIVE_INFLIGHT_WRITES,
} from '../src/database-inflight-writes.js';
import { UNREAD_INSTANCE } from '../src/rtdb-write-plan.js';

const INSTANCE = 'demo-project-default-rtdb';
const OTHER_INSTANCE = 'other-project-default-rtdb';

describe('database-inflight-writes (#2540 F6)', () => {
  test('converts covered deliveries to invalidate while preserving sibling keys on parent deliveries', () => {
    expect(createInFlightRtdbWriteStarter(INSTANCE, [])).toBeUndefined();

    const startWrite = createInFlightRtdbWriteStarter(INSTANCE, ['/slots/s1'])!;
    expect(inFlightRtdbOverlapOf(INSTANCE, '/slots/s1')).toEqual({ kind: 'none' });

    const lease = startWrite();
    try {
      expect(inFlightRtdbOverlapOf(INSTANCE, '/slots/s1')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/slots/s1/owner')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(OTHER_INSTANCE, '/slots/s1')).toEqual({ kind: 'none' });
      expect(inFlightRtdbOverlapOf(UNREAD_INSTANCE, '/slots/s1')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/slots')).toEqual({
        kind: 'descendants',
        paths: ['/slots/s1'],
      });

      let baseComputed = false;
      expect(
        applyInFlightRtdbDeliveryGuard(INSTANCE, '/slots/s1', () => {
          baseComputed = true;
          return { rtdb: [{ kind: 'set', instance: INSTANCE, path: '/slots/s1', value: { owner: 'u-1' } }] };
        }),
      ).toEqual({
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/slots/s1' }],
      });
      expect(baseComputed).toBe(false);

      expect(
        applyInFlightRtdbDeliveryGuard(INSTANCE, '/slots', () => ({
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

    expect(inFlightRtdbOverlapOf(INSTANCE, '/slots/s1')).toEqual({ kind: 'none' });
  });

  test('narrows push in-flight scope from parent path to the allocated child path on synchronous return', () => {
    const startPush = createInFlightRtdbWriteStarter(INSTANCE, ['/messages'], (returned) =>
      typeof returned === 'object' && returned !== null && 'childPath' in returned
        ? String((returned as { childPath: string }).childPath)
        : undefined,
    )!;

    const lease = startPush();
    try {
      expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/m-existing')).toEqual({ kind: 'covered' });

      lease.onReturn({ childPath: '/messages/-Push1' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/m-existing')).toEqual({ kind: 'none' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/-Push1')).toEqual({ kind: 'covered' });
    } finally {
      lease.release();
    }

    expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/-Push1')).toEqual({ kind: 'none' });
  });

  test('fails closed on TTL expiry and cap eviction by tainting the instance until release()', () => {
    let clock = 1_000;
    const startExpiring = createInFlightRtdbWriteStarter(INSTANCE, ['/offline/item'], undefined, {
      ttlMs: 5_000,
      now: () => clock,
    })!;
    const expiringLease = startExpiring();
    try {
      expect(inFlightRtdbOverlapOf(INSTANCE, '/offline/item', () => clock)).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/offline/sibling', () => clock)).toEqual({ kind: 'none' });

      // Past TTL while still unsettled: active path entry folds into per-instance fail-closed taint (`covered`).
      clock = 6_000;
      expect(inFlightRtdbOverlapOf(INSTANCE, '/offline/item', () => clock)).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/offline/sibling', () => clock)).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(OTHER_INSTANCE, '/offline/item', () => clock)).toEqual({ kind: 'none' });
      expect(
        applyInFlightRtdbDeliveryGuard(INSTANCE, '/offline/item', () => ({
          rtdb: [{ kind: 'set', instance: INSTANCE, path: '/offline/item', value: { owner: 'u-1' } }],
        })),
      ).toEqual({
        rtdb: [{ kind: 'invalidate', instance: INSTANCE, path: '/offline/item' }],
      });
    } finally {
      expiringLease.release();
      // Idempotent double release does not underflow counters.
      expiringLease.release();
    }
    expect(inFlightRtdbOverlapOf(INSTANCE, '/offline/item', () => clock)).toEqual({ kind: 'none' });

    // Exceeding MAX_ACTIVE_INFLIGHT_WRITES evicts the oldest leases into fail-closed taint until released.
    const capLeases = [];
    try {
      for (let i = 0; i < MAX_ACTIVE_INFLIGHT_WRITES + 2; i += 1) {
        capLeases.push(createInFlightRtdbWriteStarter(INSTANCE, [`/cap/item-${i}`])!());
      }
      expect(inFlightRtdbOverlapOf(INSTANCE, '/cap/item-0')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/cap/item-1')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(OTHER_INSTANCE, '/cap/item-0')).toEqual({ kind: 'none' });
    } finally {
      for (const lease of capLeases) lease.release();
    }
    expect(inFlightRtdbOverlapOf(INSTANCE, '/cap/item-0')).toEqual({ kind: 'none' });
    expect(inFlightRtdbOverlapOf(INSTANCE, `/cap/item-${MAX_ACTIVE_INFLIGHT_WRITES + 1}`)).toEqual({
      kind: 'none',
    });
  });

  test('falls back to scalar global fail-closed taint when overflowed distinct instances exceed cap', () => {
    const tracker = createInFlightRtdbWriteTracker({ maxActiveWrites: 1, maxTaintedInstances: 2 });
    const l1 = tracker.createWriteStarter('inst-1', ['/a'])!();
    const l2 = tracker.createWriteStarter('inst-2', ['/a'])!();
    const l3 = tracker.createWriteStarter('inst-3', ['/a'])!();
    const l4 = tracker.createWriteStarter('inst-4', ['/a'])!();
    try {
      // `l1` and `l2` filled per-instance taint; `l3` spilled to scalar global taint, guarding every instance.
      expect(tracker.overlapOf('untouched-instance', '/other')).toEqual({ kind: 'covered' });
      l3.release();
      expect(tracker.overlapOf('untouched-instance', '/other')).toEqual({ kind: 'none' });
      expect(tracker.overlapOf('inst-1', '/other')).toEqual({ kind: 'covered' });
      expect(tracker.overlapOf('inst-2', '/other')).toEqual({ kind: 'covered' });
    } finally {
      l1.release();
      l2.release();
      l3.release();
      l4.release();
    }
    expect(tracker.overlapOf('inst-1', '/a')).toEqual({ kind: 'none' });
    expect(tracker.overlapOf('inst-4', '/a')).toEqual({ kind: 'none' });
  });
});
