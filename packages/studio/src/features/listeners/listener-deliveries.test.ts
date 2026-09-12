/** Which events count as a delivery, across both services. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { isDeliveryEvent } from './listener-deliveries.js';

function event(fields: Record<string, unknown>): SandboxEvent {
  return { id: 'e1', at: 10, auth: null, ...fields } as unknown as SandboxEvent;
}

describe('isDeliveryEvent', () => {
  it('counts a Firestore snapshot delivery', () => {
    expect(isDeliveryEvent(event({ kind: 'snapshot_delivery', listenerId: 'a' }))).toBe(true);
  });

  it('counts a Realtime Database listener event in the delivery phase only', () => {
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'delivery' }))).toBe(true);
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'attach' }))).toBe(false);
    expect(isDeliveryEvent(event({ kind: 'listener', phase: 'suppressed' }))).toBe(false);
  });

  it('counts nothing else', () => {
    expect(isDeliveryEvent(event({ kind: 'snapshot_suppressed' }))).toBe(false);
    expect(isDeliveryEvent(event({ kind: 'request', method: 'get' }))).toBe(false);
  });
});
