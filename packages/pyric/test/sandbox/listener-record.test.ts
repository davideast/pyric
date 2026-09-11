/**
 * Listener lifecycle projects into the canonical record with the phase as the
 * method, whether the event arrived in Firestore's own lifecycle variants or
 * in the canonical cross-service `listener` variant.
 */
import { describe, it, expect } from 'bun:test';
import { toListenerRecord, toOperationRecord } from '../../src/sandbox/operation-record.js';
import type { SandboxEvent } from '../../src/sandbox/types/events.js';

function firestoreAttach(): SandboxEvent {
  return {
    kind: 'listener_attach',
    id: 'e1',
    at: 10,
    listenerId: 'l1',
    target: { kind: 'doc', path: 'notes/one' },
    auth: null,
  };
}

function rtdbDelivery(): SandboxEvent {
  return {
    kind: 'listener',
    id: 'e2',
    at: 20,
    service: 'rtdb',
    phase: 'delivery',
    listenerId: 'l2',
    target: { kind: 'value', path: '/rooms/r1' },
    auth: null,
    size: 3,
  };
}

describe('toListenerRecord', () => {
  it("reads Firestore's own lifecycle variants as phases", () => {
    const record = toListenerRecord(firestoreAttach());
    expect(record?.method).toBe('attach');
    expect(record?.eventKind).toBe('listener');
    expect(record?.service).toBe('firestore');
    expect(record?.path).toBe('notes/one');
  });

  it('reads the cross-service listener variant as the same phases', () => {
    const record = toListenerRecord(rtdbDelivery());
    expect(record?.method).toBe('delivery');
    expect(record?.service).toBe('rtdb');
    expect(record?.path).toBe('/rooms/r1');
  });

  it('reports that a non-errored phase never met Security Rules', () => {
    expect(toListenerRecord(firestoreAttach())?.rules).toEqual({
      kind: 'not-evaluated',
      reason: 'not-a-rules-operation',
    });
  });

  it('reads an errored phase as a denial', () => {
    const errored: SandboxEvent = {
      kind: 'listener_errored',
      id: 'e3',
      at: 30,
      listenerId: 'l3',
      target: { kind: 'doc', path: 'notes/two' },
      auth: null,
      error: { code: 'permission-denied', message: 'denied' },
    };
    const record = toListenerRecord(errored);
    expect(record?.method).toBe('errored');
    expect(record?.result).toBe('deny');
    expect(record?.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
  });

  it('returns null for anything that is not listener lifecycle', () => {
    const write: SandboxEvent = {
      kind: 'session_boundary',
      id: 'e4',
      at: 40,
      phase: 'reset',
      priorOpCount: 0,
    };
    expect(toListenerRecord(write)).toBeNull();
  });

  it('leaves the operation projection unchanged for lifecycle it never carried', () => {
    expect(toOperationRecord(firestoreAttach())).toBeNull();
    expect(toOperationRecord(rtdbDelivery())).toBeNull();
  });
});
