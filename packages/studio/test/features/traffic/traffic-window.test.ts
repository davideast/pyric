import { describe, expect, it } from 'bun:test';
import { bucketTraffic, type TrafficEvent } from '@pyric/ui/traffic';
import { shouldShowCapNotice } from '../../../src/features/traffic/TrafficNotices.js';
import { computeTrafficWindow } from '../../../src/features/traffic/traffic-window.js';

describe('computeTrafficWindow', () => {
  it('preserves Sandbox Mode window bounds unchanged', () => {
    expect(computeTrafficWindow([], false, 100_000)).toEqual({
      start: 100_000 - 15 * 60_000,
      end: 100_000,
    });
    expect(computeTrafficWindow([{ at: 105_000 }], false, 100_000)).toEqual({
      start: 40_000,
      end: 101_000,
    });
  });

  it('extends Live Mode window end past now and leading client event timestamps', () => {
    expect(computeTrafficWindow([], true, 100_000)).toEqual({
      start: 100_000 - 15 * 60_000,
      end: 101_000,
    });
    expect(computeTrafficWindow([{ at: 105_000 }], true, 100_000)).toEqual({
      start: 40_000,
      end: 106_000,
    });
  });

  it('aligns 36-bucket live intervals with shouldShowCapNotice across the retention horizon', () => {
    const now = 1_760_000_000_000;
    const events: TrafficEvent[] = [
      { id: 'admin-old', at: now - 39_900, service: 'firestore', method: 'get', path: 'a', auth: null, result: 'allow' },
      { id: 'client-horizon', at: now - 20_000, service: 'firestore', method: 'getDoc', path: 'a', auth: null, result: 'allow' },
      { id: 'client-latest', at: now - 40, service: 'firestore', method: 'getDoc', path: 'b', auth: null, result: 'allow' },
    ];
    const window = computeTrafficWindow(events, true, now);
    const { buckets } = bucketTraffic(events, window, 36);
    const populated = buckets.filter((bucket) => bucket.count > 0);
    const earliestBucket = populated[0];
    const newestBucket = populated[populated.length - 1];
    if (!earliestBucket || !newestBucket) {
      throw new Error('Expected populated timeline buckets');
    }

    const rulesUncoveredBeforeAt = now - 20_000;
    expect(shouldShowCapNotice(true, rulesUncoveredBeforeAt, earliestBucket)).toBe(true);
    expect(shouldShowCapNotice(true, rulesUncoveredBeforeAt, newestBucket)).toBe(false);
  });
});
