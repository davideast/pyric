/** Which events count as a delivery, across both services. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { deliveryListenerId, isDeliveryEvent } from './listener-deliveries.js';

function event(fields: Record<string, unknown>): SandboxEvent {
  return { id: 'e1', at: 10, auth: null, ...fields } as unknown as SandboxEvent;
}

describe('isDeliveryEvent', () => {
  it('counts a Firestore snapshot delivery', () => {
    expect(isDeliveryEvent(event({ kind: 'snapshot_delivery', listenerId: 'a' }))).toBe(true);
    expect(deliveryListenerId(event({ kind: 'snapshot_delivery', listenerId: 'a' }))).toBe('a');
  });

  it('counts a Realtime Database listener event in the delivery phase only', () => {
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'delivery' }))).toBe(true);
    expect(deliveryListenerId(event({ kind: 'listener', phase: 'delivery', listenerId: 'r-1' }))).toBe('r-1');
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'attach' }))).toBe(false);
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'suppressed' }))).toBe(false);
  });

  it('counts an allowed live operation event carrying detail.listenerId', () => {
    const liveDelivery = event({
      kind: 'operation',
      service: 'rtdb',
      method: 'onValue',
      result: 'allow',
      detail: { listenerId: 'page:tab-1:l-1' },
    });
    expect(isDeliveryEvent(liveDelivery)).toBe(true);
    expect(deliveryListenerId(liveDelivery)).toBe('page:tab-1:l-1');

    expect(
      isDeliveryEvent(
        event({
          kind: 'operation',
          service: 'rtdb',
          method: 'onValue',
          result: 'deny',
          detail: { listenerId: 'page:tab-1:l-1' },
        }),
      ),
    ).toBe(false);
    expect(
      isDeliveryEvent(
        event({
          kind: 'operation',
          service: 'rtdb',
          method: 'get',
          result: 'allow',
        }),
      ),
    ).toBe(false);
  });

  it('counts nothing else', () => {
    expect(isDeliveryEvent(event({ kind: 'snapshot_suppressed' }))).toBe(false);
    expect(isDeliveryEvent(event({ kind: 'request', method: 'get' }))).toBe(false);
  });
});
