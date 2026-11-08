import { describe, expect, it } from 'bun:test';
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
});
