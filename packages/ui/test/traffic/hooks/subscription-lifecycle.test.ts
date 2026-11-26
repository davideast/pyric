import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  normalizeSubscriptionLifecycleEvent,
  subscriptionConnectionKey,
  subscriptionListenerKey,
  type SubscriptionConnectionEvent,
} from '../../../src/traffic/hooks/subscription-lifecycle.js';

describe('normalizeSubscriptionLifecycleEvent (#284)', () => {
  it('normalizes legacy Firestore listener attach, detach, errored, delivery, and suppressed events', () => {
    const attach = normalizeSubscriptionLifecycleEvent({
      kind: 'listener_attach',
      id: 'e1',
      at: 100,
      listenerId: 'l-1',
      target: { kind: 'query', collection: 'rooms' },
      auth: { uid: 'u-1', token: {} },
      connectionId: 'web:1',
    } as unknown as SandboxEvent);
    expect(attach).toMatchObject({
      kind: 'listener',
      service: 'firestore',
      scope: '(default)',
      listenerId: 'l-1',
      listenerKey: subscriptionListenerKey('firestore', '(default)', 'l-1'),
      phase: 'attach',
      connectionId: 'web:1',
      connectionKey: subscriptionConnectionKey('firestore', '(default)', 'web:1'),
    });

    const errored = normalizeSubscriptionLifecycleEvent({
      kind: 'listener_errored',
      id: 'e2',
      at: 200,
      listenerId: 'l-1',
      database: 'analytics',
      target: { kind: 'query', collection: 'rooms' },
      auth: null,
      error: { code: 'permission-denied', message: 'Denied' },
    } as unknown as SandboxEvent);
    expect(errored).toMatchObject({
      kind: 'listener',
      service: 'firestore',
      scope: 'analytics',
      listenerKey: 'firestore:analytics:l-1',
      phase: 'errored',
    });

    const delivery = normalizeSubscriptionLifecycleEvent({
      kind: 'snapshot_delivery',
      id: 'e3',
      at: 250,
      listenerId: 'l-1',
      target: { kind: 'doc', path: 'rooms/r1' },
      auth: null,
      addedCount: 1,
      modifiedCount: 0,
      removedCount: 0,
      size: 1,
    } as SandboxEvent);
    expect(delivery).toMatchObject({
      kind: 'listener',
      service: 'firestore',
      phase: 'delivery',
    });
  });

  it('normalizes canonical RTDB listener events, explicit connection events, boundaries, gaps, and ignores unrelated ops', () => {
    const rtdbAttach = normalizeSubscriptionLifecycleEvent({
      kind: 'listener',
      id: 'e4',
      at: 300,
      service: 'rtdb',
      instance: 'shard-b',
      phase: 'attach',
      listenerId: 'l-1',
      target: { kind: 'path', path: '/rooms/alpha' },
      auth: null,
    } as unknown as SandboxEvent);
    expect(rtdbAttach).toMatchObject({
      kind: 'listener',
      service: 'rtdb',
      scope: 'shard-b',
      listenerKey: 'rtdb:shard-b:l-1',
      phase: 'attach',
    });

    const connection: SubscriptionConnectionEvent = {
      kind: 'connection',
      id: 'c1',
      at: 50,
      service: 'database',
      phase: 'attach',
      connectionId: 'conn-1',
      clientKind: 'server',
    };
    expect(normalizeSubscriptionLifecycleEvent(connection)).toMatchObject({
      kind: 'connection',
      service: 'rtdb',
      scope: '(default)',
      connectionKey: 'rtdb:(default):conn-1',
      phase: 'attach',
      clientKind: 'server',
    });

    const boundary = normalizeSubscriptionLifecycleEvent({
      kind: 'session_boundary',
      id: 'sb1',
      at: 350,
      phase: 'reset',
      priorOpCount: 4,
    } as SandboxEvent);
    expect(boundary).toEqual({
      kind: 'session_boundary',
      id: 'sb1',
      at: 350,
      phase: 'reset',
    });

    const gap = normalizeSubscriptionLifecycleEvent({
      kind: 'observation_gap',
      id: 'g1',
      at: 360,
      reason: 'history-limit',
      omittedCount: 12,
      firstEventId: 'a',
      lastEventId: 'b',
    } as SandboxEvent);
    expect(gap).toEqual({
      kind: 'observation_gap',
      id: 'g1',
      at: 360,
      reason: 'history-limit',
      omittedCount: 12,
    });

    const request = {
      kind: 'request',
      id: 'r1',
      at: 400,
      evalMs: 1,
      method: 'get',
      path: 'rooms/alpha',
      auth: null,
      result: 'allow',
      reasons: [],
      origin: 'user',
    } as unknown as SandboxEvent;
    expect(normalizeSubscriptionLifecycleEvent(request)).toBeNull();
  });
});
