import { describe, it, expect } from 'bun:test';
import {
  useTrafficBuckets,
  bucketTraffic,
} from '../../../src/traffic/hooks/useTrafficBuckets.js';
import type { TimeWindow } from '../../../src/traffic/hooks/useTrafficBuckets.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

// A clean 0..1000ms window so bucket boundaries land on round numbers.
const WINDOW: TimeWindow = { start: 0, end: 1000 };

describe('bucketTraffic', () => {
  it('returns an empty result for a zero-width window', () => {
    const r = bucketTraffic([evt({ at: 5 })], { start: 100, end: 100 }, 10);
    expect(r.buckets).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('returns an empty result for a non-positive bucketCount', () => {
    const r = bucketTraffic([evt({ at: 5 })], WINDOW, 0);
    expect(r.buckets).toEqual([]);
  });

  it('divides the window into N equal buckets', () => {
    const r = bucketTraffic([], WINDOW, 10);
    expect(r.buckets.length).toBe(10);
    expect(r.buckets[0]).toMatchObject({ start: 0, end: 100 });
    expect(r.buckets[9]).toMatchObject({ start: 900, end: 1000 });
  });

  it('drops events into the right bucket by their timestamp', () => {
    // width = 100 over 10 buckets. 50 -> b0, 150 -> b1, 950 -> b9.
    const r = bucketTraffic(
      [evt({ at: 50 }), evt({ at: 150 }), evt({ at: 150 }), evt({ at: 950 })],
      WINDOW,
      10,
    );
    expect(r.buckets[0].count).toBe(1);
    expect(r.buckets[1].count).toBe(2);
    expect(r.buckets[9].count).toBe(1);
    expect(r.total).toBe(4);
  });

  it('counts denies per bucket separately from the total', () => {
    const r = bucketTraffic(
      [
        evt({ at: 150, result: 'allow' }),
        evt({ at: 160, result: 'deny' }),
        evt({ at: 170, result: 'deny' }),
        evt({ at: 950, result: 'deny' }),
      ],
      WINDOW,
      10,
    );
    expect(r.buckets[1].count).toBe(3);
    expect(r.buckets[1].denies).toBe(2);
    expect(r.buckets[1].allows).toBe(1);
    expect(r.buckets[9].denies).toBe(1);
    expect(r.denies).toBe(3);
  });

  it('clamps an event at the window end into the last bucket', () => {
    // `end` is exclusive, so 1000 is out-of-window; 999.999 lands in b9.
    const r = bucketTraffic(
      [evt({ at: 1000 }), evt({ at: 999 })],
      WINDOW,
      10,
    );
    expect(r.buckets[9].count).toBe(1);
    expect(r.outOfWindow).toBe(1);
  });

  it('counts events outside the window as outOfWindow', () => {
    const r = bucketTraffic(
      [evt({ at: -5 }), evt({ at: 500 }), evt({ at: 5000 })],
      WINDOW,
      10,
    );
    expect(r.total).toBe(1);
    expect(r.outOfWindow).toBe(2);
  });

  it('scales height ratios against the tallest bucket', () => {
    // b1 gets 4 (tallest), b9 gets 1, of which 1 deny.
    const r = bucketTraffic(
      [
        evt({ at: 150 }),
        evt({ at: 150 }),
        evt({ at: 150 }),
        evt({ at: 150 }),
        evt({ at: 950, result: 'deny' }),
      ],
      WINDOW,
      10,
    );
    expect(r.maxCount).toBe(4);
    expect(r.buckets[1].heightRatio).toBe(1);
    expect(r.buckets[9].heightRatio).toBe(0.25);
    expect(r.buckets[9].denyHeightRatio).toBe(0.25);
    expect(r.buckets[0].heightRatio).toBe(0);
  });
});

describe('useTrafficBuckets', () => {
  it('returns bucketed counts for events in the window', async () => {
    const events = [evt({ at: 150 }), evt({ at: 160, result: 'deny' })];
    const { result } = renderHook(() =>
      useTrafficBuckets({ events, window: WINDOW, bucketCount: 10 }),
    );
    await waitFor(() => expect(result.current.total).toBe(2));
    expect(result.current.buckets[1].count).toBe(2);
    expect(result.current.buckets[1].denies).toBe(1);
  });

  it('defaults to 30 buckets', async () => {
    const { result } = renderHook(() =>
      useTrafficBuckets({ events: [], window: WINDOW }),
    );
    await waitFor(() => expect(result.current.buckets.length).toBe(30));
  });
});
