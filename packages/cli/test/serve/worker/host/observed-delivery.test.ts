import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import { observedDeliverySummaryOf } from '../../../../src/serve/worker/host/observed-delivery.js';

function rtdbCall(method: string, path = '/items'): ObservedCall {
  return {
    service: 'rtdb',
    method,
    instance: 'demo-default-rtdb',
    path,
    at: 1_000,
    outcome: { status: 'ok' },
    listenerId: 'l-1',
  };
}

function firestoreCall(billedDocuments?: number): ObservedCall {
  const call: ObservedCall = {
    service: 'firestore',
    method: 'onSnapshot',
    path: 'rooms',
    at: 1_000,
    outcome: { status: 'ok' },
    listenerId: 'l-fs-1',
  };
  if (billedDocuments !== undefined) call.billedDocuments = billedDocuments;
  return call;
}

describe('observedDeliverySummaryOf', () => {
  it('summarizes RTDB onChildAdded, onChildChanged, onChildMoved, and onChildRemoved by child path in delta mode', () => {
    expect(
      observedDeliverySummaryOf(rtdbCall('onChildAdded'), {
        rtdb: [
          {
            kind: 'set',
            instance: 'demo-default-rtdb',
            path: 'items/i1',
            value: { title: 'First', status: 'open' },
          },
        ],
      }),
    ).toEqual({
      mode: 'delta',
      size: 1,
      paths: ['items/i1'],
    });

    expect(
      observedDeliverySummaryOf(rtdbCall('onChildChanged'), {
        rtdb: [
          {
            kind: 'set',
            instance: 'demo-default-rtdb',
            path: 'items/i1',
            value: { title: 'First', status: 'done' },
          },
        ],
      }),
    ).toEqual({
      mode: 'delta',
      size: 1,
      paths: ['items/i1'],
    });

    expect(
      observedDeliverySummaryOf(rtdbCall('onChildMoved'), {
        rtdb: [
          {
            kind: 'set',
            instance: 'demo-default-rtdb',
            path: 'items/i1',
            value: { title: 'First', status: 'done' },
          },
        ],
      }),
    ).toEqual({
      mode: 'delta',
      size: 1,
      paths: ['items/i1'],
    });

    expect(
      observedDeliverySummaryOf(rtdbCall('onChildRemoved'), {
        rtdb: [{ kind: 'remove', instance: 'demo-default-rtdb', path: 'items/i1' }],
      }),
    ).toEqual({
      mode: 'delta',
      size: 0,
      paths: [],
      removedPaths: ['items/i1'],
    });

    expect(
      observedDeliverySummaryOf(rtdbCall('onChildRemoved'), {
        rtdb: [{ kind: 'invalidate', instance: 'demo-default-rtdb', path: 'items/i2' }],
      }),
    ).toEqual({
      mode: 'delta',
      size: 0,
      paths: [],
      removedPaths: ['items/i2'],
    });
  });

  it('summarizes filtered RTDB onValue [invalidate, update] and Firestore invalidate ops (#2540 N1, N2)', () => {
    expect(
      observedDeliverySummaryOf(rtdbCall('onValue', '/tasks'), {
        rtdb: [
          { kind: 'invalidate', instance: 'demo-default-rtdb', path: '/tasks' },
          {
            kind: 'update',
            instance: 'demo-default-rtdb',
            path: '/tasks',
            value: { t1: { owner: 'u-1' }, t2: { owner: 'u-1' } },
          },
        ],
      }),
    ).toEqual({
      mode: 'snapshot',
      size: 2,
      paths: ['tasks/t1', 'tasks/t2'],
    });

    expect(
      observedDeliverySummaryOf(rtdbCall('onValue', '/tasks'), {
        rtdb: [{ kind: 'invalidate', instance: 'demo-default-rtdb', path: '/tasks' }],
      }),
    ).toEqual({
      mode: 'snapshot',
      size: 0,
      paths: [],
    });

    expect(
      observedDeliverySummaryOf(firestoreCall(2), {
        firestore: [
          { kind: 'set', path: 'rooms/r1', data: { status: 'open' } },
          { kind: 'invalidate', path: 'rooms/r2' },
        ],
      }),
    ).toEqual({
      mode: 'delta',
      size: 2,
      paths: ['rooms/r1'],
      removedPaths: ['rooms/r2'],
    });
  });

  it('summarizes RTDB onValue in snapshot mode and preserves uncapped key cardinality above 64', () => {
    const bigNode: Record<string, number> = {};
    for (let i = 0; i < 90; i++) bigNode[`k-${i}`] = i;

    const summary = observedDeliverySummaryOf(rtdbCall('onValue', '/rooms/r1'), {
      rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/rooms/r1', value: bigNode }],
    });
    expect(summary?.mode).toBe('snapshot');
    expect(summary?.size).toBe(90);
    expect(summary?.paths).toHaveLength(64);
    expect(summary?.paths[0]).toBe('rooms/r1/k-0');
  });

  it('preserves uncapped Firestore size and billedDocuments while capping path list at 64', () => {
    const ops = Array.from({ length: 80 }, (_, index) => ({
      kind: 'set' as const,
      path: `rooms/r-${index}`,
      data: { n: index },
    }));
    const summary = observedDeliverySummaryOf(firestoreCall(120), { firestore: ops });
    expect(summary?.mode).toBe('delta');
    expect(summary?.size).toBe(120);
    expect(summary?.paths).toHaveLength(64);
  });

  it('rejects malformed or forbidden sessionData via readObservedSessionDelta without throwing', () => {
    expect(
      observedDeliverySummaryOf(firestoreCall(1), {
        firestore: [{ kind: 'set', path: 'not-even-segments', data: { ok: 1 } }],
      }),
    ).toBeUndefined();
    expect(
      observedDeliverySummaryOf(rtdbCall('onValue'), {
        rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: 'bad.$path', value: 1 }],
      }),
    ).toBeUndefined();
    expect(
      observedDeliverySummaryOf(rtdbCall('onValue', '/rooms'), {
        rtdb: [
          {
            kind: 'set',
            instance: 'demo-default-rtdb',
            path: '/rooms',
            value: { valid: 1, 'bad.key': 2, 'nested/key': 3 },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('ignores failed or admin calls and drops overlong RTDB child keys', () => {
    const failedCall: ObservedCall = {
      ...rtdbCall('onValue'),
      outcome: { status: 'error', code: 'permission-denied' },
    };
    expect(
      observedDeliverySummaryOf(failedCall, {
        rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/items', value: { a: 1 } }],
      }),
    ).toBeUndefined();

    const adminCall: ObservedCall = {
      ...firestoreCall(1),
      sdk: 'admin',
    };
    expect(
      observedDeliverySummaryOf(adminCall, {
        firestore: [{ kind: 'set', path: 'rooms/r1', data: { a: 1 } }],
      }),
    ).toBeUndefined();

    const summary = observedDeliverySummaryOf(rtdbCall('onValue', '/rooms'), {
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-default-rtdb',
          path: '/rooms',
          value: {
            valid: 1,
            ['x'.repeat(1030)]: 4,
          },
        },
      ],
    });
    expect(summary).toEqual({
      mode: 'snapshot',
      size: 2,
      paths: ['rooms/valid'],
    });
  });
});
