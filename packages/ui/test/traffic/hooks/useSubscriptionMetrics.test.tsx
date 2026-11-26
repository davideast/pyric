import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { retainSubscriptionGauge } from '../../../src/traffic/hooks/subscription-gauge.js';
import { useSubscriptionMetrics } from '../../../src/traffic/hooks/useSubscriptionMetrics.js';
import { renderHook } from '../../helpers/render-hook.js';

describe('useSubscriptionMetrics (#284)', () => {
  it('computes reactive peak and instantaneous subscription series over the supplied window', () => {
    const snapshot = retainSubscriptionGauge([
      {
        kind: 'connection',
        id: 'c-1',
        at: 100,
        service: 'firestore',
        phase: 'attach',
        connectionId: 'web-1',
        clientKind: 'web',
      },
      {
        kind: 'listener_attach',
        id: 'l-1',
        at: 200,
        listenerId: 'orders-1',
        target: { kind: 'query', collection: 'orders' },
        auth: null,
        connectionId: 'web-1',
      } as unknown as SandboxEvent,
    ]);

    const { result } = renderHook(() =>
      useSubscriptionMetrics({
        snapshot,
        window: { start: 0, end: 1_000 },
        bucketCount: 4,
      }),
    );

    expect(result.current.connectionsObserved).toBe(true);
    expect(result.current.currentListeners).toBe(1);
    expect(result.current.currentConnections).toBe(1);
    expect(result.current.peakListeners).toBe(1);
    expect(result.current.peakConnections).toBe(1);
    expect(result.current.points).toHaveLength(4);
  });
});
