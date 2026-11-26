import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import type {
  SubscriptionConnectionEvent,
  SubscriptionLifecycleInput,
} from '../../../src/traffic/hooks/subscription-lifecycle.js';
import {
  foldSubscriptionGauge,
  retainSubscriptionGauge,
} from '../../../src/traffic/hooks/subscription-gauge.js';
import { bucketSubscriptionMetrics } from '../../../src/traffic/hooks/subscription-buckets.js';

function firestoreAttach(
  id: string,
  listenerId: string,
  at: number,
  connectionId?: string,
): SandboxEvent {
  const base: Record<string, unknown> = {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'rooms' },
    auth: { uid: 'u-1', token: {} },
  };
  if (connectionId !== undefined) base.connectionId = connectionId;
  return base as unknown as SandboxEvent;
}

function firestoreDetach(id: string, listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'listener_detach',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'rooms' },
    auth: null,
  } as unknown as SandboxEvent;
}

function webConnection(
  id: string,
  connectionId: string,
  phase: 'attach' | 'detach',
  at: number,
): SubscriptionConnectionEvent {
  return {
    kind: 'connection',
    id,
    at,
    service: 'firestore',
    phase,
    connectionId,
    clientKind: 'web',
  };
}

describe('bucketSubscriptionMetrics (#284)', () => {
  it('reports 10 listeners and 1 connection on one web connection, and 0 listeners / 1 connection when idle', () => {
    const events: SubscriptionLifecycleInput[] = [
      webConnection('c-web', 'web-tab-1', 'attach', 1_000),
    ];
    for (let i = 1; i <= 10; i += 1) {
      events.push(firestoreAttach(`att-${i}`, `listener-${i}`, 1_100 + i * 10, 'web-tab-1'));
    }
    events.push({
      kind: 'listener',
      id: 'rtdb-1',
      at: 1_150,
      service: 'rtdb',
      phase: 'attach',
      listenerId: 'rtdb-l1',
      target: { kind: 'path', path: '/rooms' },
      auth: null,
    } as unknown as SandboxEvent);

    let snapshot = retainSubscriptionGauge(events);
    const activeWindow = bucketSubscriptionMetrics(
      snapshot,
      { start: 1_000, end: 3_000 },
      { service: 'firestore', bucketCount: 4 },
    );
    expect(activeWindow.connectionsObserved).toBe(true);
    expect(activeWindow.currentListeners).toBe(10);
    expect(activeWindow.currentConnections).toBe(1);
    expect(activeWindow.peakListeners).toBe(10);
    expect(activeWindow.peakConnections).toBe(1);

    for (let i = 1; i <= 10; i += 1) {
      snapshot = foldSubscriptionGauge(
        snapshot,
        firestoreDetach(`det-${i}`, `listener-${i}`, 2_200 + i),
      );
    }
    const idleWindow = bucketSubscriptionMetrics(
      snapshot,
      { start: 2_500, end: 3_500 },
      { service: 'firestore', bucketCount: 4 },
    );
    expect(idleWindow.currentListeners).toBe(0);
    expect(idleWindow.currentConnections).toBe(1);
    expect(idleWindow.peakListeners).toBe(0);
    expect(idleWindow.peakConnections).toBe(1);
  });

  it('keeps connectionsObserved false without explicit connection state and preserves exact rolling baselines past >500 unrelated ops', () => {
    const stream: SubscriptionLifecycleInput[] = [
      firestoreAttach('a-1', 'l-keep', 100),
      firestoreAttach('a-2', 'l-temp', 150),
      firestoreDetach('d-2', 'l-temp', 200),
    ];
    for (let i = 0; i < 650; i += 1) {
      stream.push({
        kind: 'request',
        id: `req-${i}`,
        at: 300 + i,
        evalMs: 1,
        method: 'get',
        path: 'rooms/alpha',
        auth: null,
        result: 'allow',
        reasons: [],
        origin: 'user',
      } as unknown as SandboxEvent);
    }

    const uninstrumented = retainSubscriptionGauge(stream);
    const metrics = bucketSubscriptionMetrics(uninstrumented, { start: 0, end: 1_200 });
    expect(metrics.connectionsObserved).toBe(false);
    expect(metrics.currentConnections).toBeNull();
    expect(metrics.peakConnections).toBeNull();
    expect(metrics.currentListeners).toBe(1);
    expect(metrics.peakListeners).toBe(2);

    const capped = retainSubscriptionGauge(
      [
        webConnection('c-1', 'web-1', 'attach', 100),
        firestoreAttach('a-1', 'l-1', 200, 'web-1'),
        firestoreAttach('a-2', 'l-2', 300, 'web-1'),
        firestoreAttach('a-3', 'l-3', 400, 'web-1'),
        firestoreDetach('d-2', 'l-2', 500),
      ],
      { maxTransitions: 3 },
    );
    expect(capped.capped).toBe(true);
    const postEviction = bucketSubscriptionMetrics(capped, { start: 350, end: 700 });
    expect(postEviction.currentListeners).toBe(2);
    expect(postEviction.currentConnections).toBe(1);
    expect(postEviction.peakListeners).toBe(3);
    expect(postEviction.peakConnections).toBe(1);
  });
});
