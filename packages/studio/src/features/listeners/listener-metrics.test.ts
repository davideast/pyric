/** The Listeners journal's card series and delivery buckets. */
import { describe, expect, it } from 'bun:test';
import type { ActiveListener, SandboxEvent } from 'pyric/sandbox';
import {
  deliveryCountsInWindow,
  deliveryMetrics,
  listenerCardSeries,
} from './listener-metrics.js';

const WINDOW = { start: 0, end: 1000 };

function listener(id: string, service: ActiveListener['service']): ActiveListener {
  return {
    id,
    service,
    target: `notes/${id}`,
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    attachedAt: 0,
    deliveryCount: 0,
    suppressedCount: 0,
  };
}

function delivery(listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id: `${listenerId}-${at}`,
    at,
    listenerId,
    target: { kind: 'doc', path: 'notes/one' },
  } as unknown as SandboxEvent;
}

describe('the card series', () => {
  it('renders one card per state, in reading order, with counts as totals', () => {
    const series = listenerCardSeries({ delivering: 5, idle: 3, incidents: 1 });
    expect(series.map((s) => s.key)).toEqual(['delivering', 'idle', 'incidents']);
    expect(series.map((s) => s.total)).toEqual([5, 3, 1]);
  });
});

describe('deliveries in the window', () => {
  it('counts each listener inside the half-open window only', () => {
    const counts = deliveryCountsInWindow(
      [delivery('a', -1), delivery('a', 0), delivery('a', 999), delivery('a', 1000), delivery('b', 5)],
      WINDOW,
    );
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });
});

describe('the delivery chart', () => {
  it('buckets deliveries per service over the window', () => {
    const metrics = deliveryMetrics(
      [delivery('a', 10), delivery('a', 20), delivery('b', 600)],
      [listener('a', 'firestore'), listener('b', 'database')],
      WINDOW,
      10,
    );
    expect(metrics.points).toHaveLength(10);
    expect(metrics.total).toBe(3);
    const firestore = metrics.series.find((s) => s.key === 'firestore')!;
    const database = metrics.series.find((s) => s.key === 'database')!;
    expect(firestore.total).toBe(2);
    expect(firestore.values[0]).toBe(2);
    expect(database.values[6]).toBe(1);
  });

  it('ignores a delivery whose listener is no longer attached', () => {
    const metrics = deliveryMetrics([delivery('gone', 10)], [listener('a', 'firestore')], WINDOW, 4);
    expect(metrics.total).toBe(0);
  });

  it('reports nothing to draw for an empty window', () => {
    const metrics = deliveryMetrics([delivery('a', 10)], [listener('a', 'firestore')], {
      start: 0,
      end: 0,
    });
    expect(metrics.points).toEqual([]);
    expect(metrics.total).toBe(0);
  });
});
