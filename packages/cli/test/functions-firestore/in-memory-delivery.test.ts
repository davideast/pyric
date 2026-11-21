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
});
