import { expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, onValue, onChildAdded, off, sandbox as databaseSandbox } from '../../src/database/index.js';
import { sdkActivity, type SdkActivityEvent } from '../../src/sandbox/internal/sdk-activity.js';

it('counts RTDB public callbacks, including the initial onlyOnce child batch and duplicate off', async () => {
  const database = getDatabase(initializeSandbox());
  databaseSandbox.setDefaultPolicy(database, 'allow');
  const target = ref(database, 'items');
  await set(target, { one: 1, two: 2 });
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  const unsubscribes: Array<() => void> = [];
  let children = 0;
  let values = 0;
  const callback = () => { ++values; };
  try {
    unsubscribes.push(onChildAdded(target, () => {
      ++children;
      throw new Error('app callback');
    }, { onlyOnce: true }));
    await Promise.resolve();
    const childId = events.find(event => event.phase === 'start')!.record.id;
    expect(children).toBe(2);
    expect(events.filter(event => event.phase === 'delivery' && event.record.id === childId)).toHaveLength(2);
    expect(events.find(event => event.phase === 'end' && event.record.id === childId)?.record).toMatchObject({ status: 'closed', method: 'onChildAdded', deliveryCount: 2 });
    unsubscribes.push(onValue(target, callback), onValue(target, callback));
    expect(values).toBe(2);
    const registrations = events.filter(event => event.phase === 'start' && event.record.method === 'onValue').map(event => event.record.id);
    expect(registrations).toHaveLength(2);
    off(target, 'value', callback);
    await set(target, { three: 3 });
    expect(values).toBe(3);
    const counts = registrations.map(id => events.filter(event => event.phase === 'delivery' && event.record.id === id).length).sort();
    expect(counts).toEqual([1, 2]);
    expect(children).toBe(2);
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    stop();
  }
});
