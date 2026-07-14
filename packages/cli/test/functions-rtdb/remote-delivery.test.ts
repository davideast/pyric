import { describe, expect, test } from 'bun:test';
import { RemoteRtdbTriggerDelivery } from '../../src/functions-rtdb/remote-delivery.js';
import type {
  RemoteRtdb,
  RemoteRtdbSnapshot,
} from '../../src/remote/index.js';

describe('RemoteRtdbTriggerDelivery', () => {
  test('adapts the existing RTDB value subscription to snapshot values', () => {
    let subscribedPath: string | undefined;
    let deliver!: (snapshot: RemoteRtdbSnapshot) => void;
    let unsubscribed = false;
    const rtdb = {
      onValue(path, callback) {
        subscribedPath = path;
        deliver = callback;
        return () => {
          unsubscribed = true;
        };
      },
    } as Pick<RemoteRtdb, 'onValue'>;
    const adapter = new RemoteRtdbTriggerDelivery(rtdb);
    const values: unknown[] = [];

    const unsubscribe = adapter.subscribe('/items', (value) => values.push(value));
    deliver({ key: 'items', exists: true, value: { alpha: 1 }, size: 1 });

    expect(subscribedPath).toBe('/items');
    expect(values).toEqual([{ alpha: 1 }]);
    unsubscribe();
    expect(unsubscribed).toBe(true);
  });
});
