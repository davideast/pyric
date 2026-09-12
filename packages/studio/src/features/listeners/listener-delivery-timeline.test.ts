import { describe, expect, it } from 'bun:test';
import {
  deliveriesInInterval,
  deliveryMovement,
  deliveryTimelineEvents,
  intervalFacts,
} from './listener-delivery-timeline.js';
import type { ListenerDelivery } from './listener-delivery-docs.js';

function delivery(fields: Partial<ListenerDelivery> & { at: number }): ListenerDelivery {
  return {
    initial: false,
    addedCount: 0,
    modifiedCount: 0,
    removedCount: 0,
    size: 0,
    docs: [],
    ...fields,
  };
}

const history = [
  delivery({ at: 100, initial: true, size: 37 }),
  delivery({ at: 200, addedCount: 40, modifiedCount: 3, size: 40 }),
  delivery({ at: 300, addedCount: 1, removedCount: 2, size: 41 }),
];

describe('deliveryTimelineEvents', () => {
  it('gives the histogram one allowed event per delivery, keyed by position', () => {
    const events = deliveryTimelineEvents(history, 'conversations');
    expect(events.map((event) => event.at)).toEqual([100, 200, 300]);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
    expect(events.every((event) => event.result === 'allow')).toBe(true);
    expect(events.every((event) => event.path === 'conversations')).toBe(true);
  });
});

describe('deliveriesInInterval', () => {
  it('keeps the deliveries inside the half-open interval', () => {
    expect(deliveriesInInterval(history, { start: 100, end: 300 }).map((d) => d.at))
      .toEqual([100, 200]);
    expect(deliveriesInInterval(history, { start: 300, end: 400 }).map((d) => d.at))
      .toEqual([300]);
    expect(deliveriesInInterval(history, { start: 400, end: 500 })).toEqual([]);
  });
});

describe('intervalFacts', () => {
  it('states the deliveries and every figure that is not zero', () => {
    expect(intervalFacts(history.slice(0, 2))).toEqual(['2 deliveries', '77 added', '3 modified']);
    expect(intervalFacts(history.slice(2))).toEqual(['1 delivery', '1 added', '2 removed']);
  });

  it('counts the initial snapshot as documents added', () => {
    expect(intervalFacts([history[0]!])).toEqual(['1 delivery', '37 added']);
  });

  it('states an empty interval as no deliveries and nothing else', () => {
    expect(intervalFacts([])).toEqual(['0 deliveries']);
  });
});

describe('deliveryMovement', () => {
  it('names the first delivery and the figures of every later one', () => {
    expect(deliveryMovement(history[0]!)).toBe('initial');
    expect(deliveryMovement(history[1]!)).toBe('+40 ~3');
    expect(deliveryMovement(history[2]!)).toBe('+1 −2');
    expect(deliveryMovement(delivery({ at: 400, size: 41 }))).toBe('');
  });
});
