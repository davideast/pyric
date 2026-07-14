import { describe, expect, test } from 'bun:test';
import { InMemoryRtdbTriggerDelivery } from '../../src/functions-rtdb/delivery.js';

describe('InMemoryRtdbTriggerDelivery', () => {
  test('normalizes paths, clones snapshots, and stops delivery after unsubscribe', () => {
    const delivery = new InMemoryRtdbTriggerDelivery();
    const seeded = { nested: { value: 1 } };
    delivery.seed('/messages/', seeded);
    seeded.nested.value = 99;

    const received: Array<{ nested: { value: number } } | null> = [];
    const unsubscribe = delivery.subscribe('messages', (value) => {
      received.push(structuredClone(value) as { nested: { value: number } } | null);
      if (value && typeof value === 'object') {
        (value as { nested: { value: number } }).nested.value = 50;
      }
    });
    delivery.emit('//messages//', { nested: { value: 2 } });
    unsubscribe();
    const stopSecond = delivery.subscribe('/messages', (value) => {
      received.push(value as { nested: { value: number } } | null);
    });
    stopSecond();
    delivery.emit('/messages', { nested: { value: 3 } });

    expect(received).toEqual([
      { nested: { value: 1 } },
      { nested: { value: 2 } },
      { nested: { value: 2 } },
    ]);
  });
});
