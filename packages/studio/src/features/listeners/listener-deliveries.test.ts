/** Delivery history and the sparkline it draws, pure. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { deliverySparkline, deliveryTimestamps } from './listener-deliveries.js';

function delivery(id: string, listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at,
    listenerId,
    target: { kind: 'doc', path: 'notes/one' },
    auth: null,
  } as unknown as SandboxEvent;
}

describe('deliveryTimestamps', () => {
  it('keeps only the named listener, in order', () => {
    const events = [
      delivery('e1', 'a', 10),
      delivery('e2', 'b', 20),
      delivery('e3', 'a', 30),
    ];
    expect(deliveryTimestamps(events, 'a')).toEqual([10, 30]);
  });

  it('is empty for a listener that has never delivered', () => {
    expect(deliveryTimestamps([delivery('e1', 'a', 10)], 'b')).toEqual([]);
  });
});

describe('deliverySparkline', () => {
  it('has no shape without deliveries', () => {
    expect(deliverySparkline([])).toEqual({ buckets: [], peak: 0, points: '' });
  });

  it('buckets a run of deliveries across the session', () => {
    const shape = deliverySparkline([0, 0, 100], { buckets: 2, width: 10, height: 10 });
    expect(shape.buckets).toEqual([2, 1]);
    expect(shape.peak).toBe(2);
    expect(shape.points).toBe('0.00,0.00 10.00,5.00');
  });

  it('puts a single delivery in the last bucket', () => {
    const shape = deliverySparkline([500], { buckets: 3 });
    expect(shape.buckets).toEqual([0, 0, 1]);
  });
});
