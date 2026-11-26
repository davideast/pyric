import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  subscriptionConnectionKey,
  subscriptionListenerKey,
  type SubscriptionConnectionEvent,
  type SubscriptionLifecycleInput,
} from '../../../src/traffic/hooks/subscription-lifecycle.js';
import {
  createSubscriptionGaugeSnapshot,
  foldSubscriptionGauge,
  retainSubscriptionGauge,
} from '../../../src/traffic/hooks/subscription-gauge.js';

function firestoreAttach(
  id: string,
  listenerId: string,
  at: number,
  extra: Record<string, unknown> = {},
): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'rooms' },
    auth: { uid: 'u-1', token: {} },
    ...extra,
  } as unknown as SandboxEvent;
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

function firestoreErrored(id: string, listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'listener_errored',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'rooms' },
    auth: null,
    error: { code: 'permission-denied', message: 'Denied' },
  } as unknown as SandboxEvent;
}

function connectionEvent(
  id: string,
  connectionId: string,
  phase: 'attach' | 'detach',
  at: number,
  clientKind: 'web' | 'server' = 'web',
): SubscriptionConnectionEvent {
  return {
    kind: 'connection',
    id,
    at,
    service: 'firestore',
    phase,
    connectionId,
    clientKind,
  };
}

describe('subscription-gauge reducer (#284)', () => {
  it('handles attach, detach, errored, and duplicate or out-of-order terminal events idempotently', () => {
    let state = createSubscriptionGaugeSnapshot();
    state = foldSubscriptionGauge(state, firestoreDetach('d-early', 'l-missing', 50));
    expect(state.activeListeners.size).toBe(0);

    state = foldSubscriptionGauge(state, firestoreAttach('a1', 'l-1', 100));
    state = foldSubscriptionGauge(state, firestoreAttach('a2', 'l-2', 120));
    expect(state.activeListeners.size).toBe(2);

    const afterDelivery = foldSubscriptionGauge(state, {
      kind: 'snapshot_delivery',
      id: 'del-1',
      at: 130,
      listenerId: 'l-1',
      target: { kind: 'doc', path: 'rooms/r1' },
      auth: null,
      addedCount: 1,
      modifiedCount: 0,
      removedCount: 0,
      size: 1,
    } as SandboxEvent);
    expect(afterDelivery).toBe(state);

    state = foldSubscriptionGauge(state, firestoreErrored('err-1', 'l-1', 150));
    expect(state.activeListeners.size).toBe(1);
    expect(foldSubscriptionGauge(state, firestoreErrored('err-2', 'l-1', 160))).toBe(state);
    expect(foldSubscriptionGauge(state, firestoreDetach('det-1', 'l-1', 170))).toBe(state);

    state = foldSubscriptionGauge(state, firestoreDetach('det-2', 'l-2', 200));
    expect(state.activeListeners.size).toBe(0);
    expect(foldSubscriptionGauge(state, firestoreDetach('det-3', 'l-2', 210))).toBe(state);
  });

  it('clears session listeners on reset and tears down all gauges on dispose', () => {
    const events: SubscriptionLifecycleInput[] = [
      connectionEvent('c1', 'web-1', 'attach', 100),
      firestoreAttach('a1', 'l-1', 150, { connectionId: 'web-1' }),
      {
        kind: 'session_boundary',
        id: 'sb-reset',
        at: 300,
        phase: 'reset',
        priorOpCount: 2,
      } as SandboxEvent,
    ];
    let state = retainSubscriptionGauge(events);
    expect(state.activeListeners.size).toBe(0);
    expect(state.activeConnections.size).toBe(1);

    state = foldSubscriptionGauge(
      state,
      firestoreAttach('a2', 'l-2', 400, { connectionId: 'web-1' }),
    );
    state = foldSubscriptionGauge(state, {
      kind: 'session_boundary',
      id: 'sb-dispose',
      at: 500,
      phase: 'dispose',
      priorOpCount: 4,
    } as SandboxEvent);
    expect(state.activeListeners.size).toBe(0);
    expect(state.activeConnections.size).toBe(0);
  });

  it('counts multiple modeled connections independently and removes only detached connection state', () => {
    let snapshot = retainSubscriptionGauge([
      connectionEvent('c-a', 'web-a', 'attach', 100, 'web'),
      connectionEvent('c-b', 'web-b', 'attach', 110, 'web'),
      connectionEvent('c-s', 'srv-1', 'attach', 120, 'server'),
      firestoreAttach('la-1', 'l-a1', 200, { connectionId: 'web-a' }),
      firestoreAttach('la-2', 'l-a2', 210, { connectionId: 'web-a' }),
      firestoreAttach('lb-1', 'l-b1', 220, { connectionId: 'web-b' }),
      firestoreAttach('ls-1', 'l-s1', 230, { connectionId: 'srv-1' }),
    ]);
    expect(snapshot.activeConnections.size).toBe(3);
    expect(snapshot.activeListeners.size).toBe(4);

    snapshot = foldSubscriptionGauge(
      snapshot,
      connectionEvent('c-a-det', 'web-a', 'detach', 500),
    );
    expect(snapshot.activeConnections.size).toBe(2);
    expect(snapshot.activeListeners.size).toBe(2);
    expect(
      snapshot.activeListeners.has(subscriptionListenerKey('firestore', '(default)', 'l-b1')),
    ).toBe(true);
    expect(
      snapshot.activeListeners.has(subscriptionListenerKey('firestore', '(default)', 'l-s1')),
    ).toBe(true);
    expect(
      snapshot.activeConnections.has(subscriptionConnectionKey('firestore', '(default)', 'web-a')),
    ).toBe(false);
  });
});
