import { describe, expect, test } from 'bun:test';
import type { FirestoreMutationRecord } from '../../src/functions/firestore/delivery.js';
import { InMemoryFirestoreTriggerDelivery } from '../../src/functions/firestore/in-memory-delivery.js';

describe('InMemoryFirestoreTriggerDelivery', () => {
  test('delivers ready immediately, ignores pre-seeded docs, and tracks create/update transitions', () => {
    const delivery = new InMemoryFirestoreTriggerDelivery();
    delivery.seed('/users/seeded/', { role: 'admin' });

    const observed: FirestoreMutationRecord[] = [];
    let readyCalls = 0;
    const stop = delivery.subscribe('(default)', {
      onReady() {
        readyCalls += 1;
      },
      onMutation(mutation) {
        observed.push(mutation);
      },
    });

    expect(readyCalls).toBe(1);
    expect(observed).toEqual([]);

    delivery.emitCreate({
      document: '/users/alice/',
      fields: { name: 'Alice' },
      time: '2026-07-13T20:00:01.000Z',
    });
    delivery.emitCreate({
      document: 'users/alice',
      fields: { name: 'Alice Updated' },
      time: '2026-07-13T20:00:05.000Z',
    });
    delivery.emitCreate({
      database: 'analytics',
      document: 'users/other-db',
      fields: { ignored: true },
    });

    expect(observed.length).toBe(2);
    expect(observed[0]?.before).toBeNull();
    expect(observed[0]?.after?.fields).toEqual({ name: 'Alice' });
    expect(observed[1]?.before?.fields).toEqual({ name: 'Alice' });
    expect(observed[1]?.after?.fields).toEqual({ name: 'Alice Updated' });
    expect(observed[1]?.after?.createTime).toEqual(observed[0]?.after?.createTime);

    stop();
    delivery.emitCreate({
      document: 'users/bob',
      fields: { name: 'Bob' },
    });
    expect(observed.length).toBe(2);
  });

  test('supports emitUpdate, emitDelete, updateMask computation, and no-op update suppression', () => {
    const delivery = new InMemoryFirestoreTriggerDelivery();
    const observed: FirestoreMutationRecord[] = [];
    delivery.subscribe('(default)', {
      onMutation(mutation) {
        observed.push(mutation);
      },
    });

    delivery.emitCreate({
      document: 'orders/ord-1',
      fields: { status: 'draft', total: 10 },
      time: '2026-07-13T20:00:01.000Z',
    });
    // Identical update must be suppressed without advancing updateTime
    delivery.emitUpdate({
      document: 'orders/ord-1',
      fields: { status: 'draft', total: 10 },
      time: '2026-07-13T20:00:03.000Z',
    });
    delivery.emitUpdate({
      document: 'orders/ord-1',
      fields: { status: 'paid', total: 10 },
      time: '2026-07-13T20:00:06.000Z',
    });
    delivery.emitDelete({
      document: 'orders/ord-1',
      time: '2026-07-13T20:00:09.000Z',
    });
    // Delete of already-missing document is a no-op
    delivery.emitDelete({
      document: 'orders/ord-1',
      time: '2026-07-13T20:00:11.000Z',
    });

    expect(observed.length).toBe(3);
    expect(observed[1]?.before?.updateTime).toEqual({ seconds: 1_783_972_801, nanos: 0 });
    expect(observed[1]?.after?.createTime).toEqual({ seconds: 1_783_972_801, nanos: 0 });
    expect(observed[1]?.after?.updateTime).toEqual({ seconds: 1_783_972_806, nanos: 0 });
    expect(observed[1]?.updateMask).toEqual(['status']);
    expect(observed[2]?.before?.fields).toEqual({ status: 'paid', total: 10 });
    expect(observed[2]?.after).toBeNull();
  });
});
