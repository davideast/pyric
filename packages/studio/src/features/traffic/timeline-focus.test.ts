import { describe, expect, it } from 'bun:test';
import type { TrafficEvent } from '@pyric/ui/traffic';
import { trafficTimeFocus, toggleTimeFocus } from './timeline-focus.js';

const event = (id: string, at: number, result: TrafficEvent['result'] = 'allow') =>
  ({ id, at, result }) as TrafficEvent;

describe('trafficTimeFocus', () => {
  it("selects the bucket's half-open interval", () => {
    const focus = trafficTimeFocus(
      [event('before', 99), event('start', 100), event('inside', 199, 'deny'), event('end', 200)],
      { start: 100, end: 200 },
    );

    expect(focus.events.map(({ id }) => id)).toEqual(['start', 'inside']);
    expect(focus.total).toBe(2);
    expect(focus.denies).toBe(1);
    expect(focus.finding).toBe('2 requests occurred in this interval; 1 was denied.');
  });

  it('describes empty, clear, and all-denied intervals honestly', () => {
    expect(trafficTimeFocus([], { start: 0, end: 100 }).finding).toBe('No requests occurred in this interval.');
    expect(trafficTimeFocus([event('one', 10)], { start: 0, end: 100 }).finding).toBe(
      'One request occurred in this interval; it was not denied.',
    );
    expect(
      trafficTimeFocus([event('one', 10, 'deny'), event('two', 20, 'deny')], {
        start: 0,
        end: 100,
      }).finding,
    ).toBe('All 2 requests in this interval were denied.');
  });
});

describe('toggleTimeFocus', () => {
  it('pins a new interval and clears an already-pinned interval', () => {
    const interval = { start: 100, end: 200 };

    expect(toggleTimeFocus(null, interval)).toEqual(interval);
    expect(toggleTimeFocus(interval, { ...interval })).toBeNull();
    expect(toggleTimeFocus(interval, { start: 200, end: 300 })).toEqual({
      start: 200,
      end: 300,
    });
  });
});
